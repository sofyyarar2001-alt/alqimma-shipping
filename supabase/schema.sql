/*
========================================================
سستم شحن وكالة مجلس القمة
قاعدة البيانات الأساسية
========================================================

طريقة الاستخدام:
1. افتح Supabase.
2. افتح SQL Editor.
3. أنشئ New Query.
4. الصق هذا الملف كاملًا.
5. اضغط Run.

تنبيه:
هذا المخطط مخصص لإنشاء قاعدة بيانات المشروع.
لا تشغله عشوائيًا على قاعدة تحتوي بيانات فعلية.

الأرصدة تبدأ من صفر.
تسجيل العمليات يتم من خلال record_transaction.
لا تضع كلمات مرور الحسابات داخل هذا الملف.
========================================================
*/

create extension if not exists pgcrypto;


-- ==========================================
-- 1. ملفات المستخدمين والصلاحيات
-- ==========================================

create table if not exists public.profiles (

  id uuid primary key
    references auth.users(id)
    on delete cascade,

  username text unique not null,

  display_name text not null default '',

  role text not null
    check (role in ('manager', 'staff')),

  active boolean not null default true,

  created_at timestamptz not null default now()

);


-- ==========================================
-- 2. المحافظ
-- ==========================================

create table if not exists public.wallets (

  id uuid primary key default gen_random_uuid(),

  name text not null,

  currency text not null
    check (currency in ('JOD', 'USD', 'EGP', 'TRY')),

  balance numeric(18,2) not null default 0
    check (balance >= 0),

  active boolean not null default true,

  created_at timestamptz not null default now(),

  updated_at timestamptz not null default now()

);


-- ==========================================
-- 3. سجل حركة كوينز النظام
-- ==========================================

create table if not exists public.system_ledger (

  id bigint generated always as identity primary key,

  coins_in numeric(24,0) not null default 0,

  coins_out numeric(24,0) not null default 0,

  coins_balance numeric(24,0) not null default 0
    check (coins_balance >= 0),

  reason text not null,

  created_at timestamptz not null default now()

);


-- تسجيل رصيد افتتاحي بصفر إن لم يوجد سجل.

insert into public.system_ledger (
  coins_in,
  coins_out,
  coins_balance,
  reason
)
select 0, 0, 0, 'opening_balance'
where not exists (
  select 1
  from public.system_ledger
);


-- ==========================================
-- 4. سجل العمليات
-- ==========================================

create table if not exists public.transactions (

  id uuid primary key default gen_random_uuid(),

  operation_type text not null
    check (
      operation_type in (
        'charge',
        'target',
        'game_profit',
        'adjustment'
      )
    ),

  coins numeric(24,0) not null
    check (coins >= 0),

  amount numeric(18,2) not null
    check (amount >= 0),

  currency text not null
    check (currency in ('JOD', 'USD', 'EGP', 'TRY')),

  wallet_id uuid
    references public.wallets(id),

  notes text,

  created_by uuid
    references auth.users(id),

  created_at timestamptz not null default now()

);


-- ==========================================
-- 5. سجل تدقيق التعديلات
-- ==========================================

create table if not exists public.audit_log (

  id bigint generated always as identity primary key,

  actor_id uuid
    references auth.users(id),

  action text not null,

  entity text not null,

  entity_id text,

  details jsonb not null default '{}'::jsonb,

  created_at timestamptz not null default now()

);


-- ==========================================
-- 6. معرفة صلاحية المستخدم الحالي
-- ==========================================

create or replace function public.current_app_role()

returns text

language sql

stable

security definer

set search_path = ''

as $$

  select p.role

  from public.profiles p

  where p.id = auth.uid()

    and p.active = true

  limit 1;

$$;


-- ==========================================
-- 7. تسجيل العمليات المحاسبية
-- ==========================================

create or replace function public.record_transaction(

  p_operation_type text,

  p_coins numeric,

  p_amount numeric,

  p_currency text,

  p_wallet_id uuid,

  p_notes text default null

)

returns uuid

language plpgsql

security definer

set search_path = ''

as $$

declare

  v_wallet public.wallets%rowtype;

  v_transaction_id uuid;

  v_balance numeric;

  v_coins_in numeric := 0;

  v_coins_out numeric := 0;

begin

  -- التحقق من تسجيل الدخول.

  if auth.uid() is null then

    raise exception 'يجب تسجيل الدخول أولًا';

  end if;


  -- التحقق من صلاحية الحساب.

  if not exists (

    select 1

    from public.profiles p

    where p.id = auth.uid()

      and p.active = true

      and p.role in ('manager', 'staff')

  ) then

    raise exception 'ليس لديك صلاحية لتنفيذ العملية';

  end if;


  -- التحقق من نوع العملية.

  if p_operation_type not in (
    'charge',
    'target',
    'game_profit'
  ) then

    raise exception 'نوع العملية غير صحيح';

  end if;


  -- التحقق من الكوينز.

  if p_coins is null
     or p_coins <= 0
     or p_coins <> trunc(p_coins) then

    raise exception 'عدد الكوينز يجب أن يكون عددًا صحيحًا موجبًا';

  end if;


  -- التحقق من المبلغ.

  if p_amount is null or p_amount < 0 then

    raise exception 'المبلغ غير صحيح';

  end if;


  -- التحقق من العملة.

  if p_currency not in ('JOD', 'USD', 'EGP', 'TRY') then

    raise exception 'العملة غير مدعومة';

  end if;


  -- قفل المحفظة أثناء تنفيذ العملية.

  select *

  into v_wallet

  from public.wallets

  where id = p_wallet_id

    and active = true

  for update;


  if not found then

    raise exception 'المحفظة غير موجودة أو غير فعالة';

  end if;


  if v_wallet.currency <> p_currency then

    raise exception 'عملة العملية لا تطابق عملة المحفظة';

  end if;


  -- قفل أحدث سجل في دفتر كوينز النظام.

  select l.coins_balance

  into v_balance

  from public.system_ledger l

  order by l.id desc

  limit 1

  for update;


  if not found then

    raise exception 'دفتر كوينز النظام غير مهيأ';

  end if;


  -- ======================================
  -- الشحن
  -- الكوينز تخرج من النظام.
  -- المبلغ النقدي يدخل المحفظة.
  -- ======================================

  if p_operation_type = 'charge' then

    if v_balance < p_coins then

      raise exception 'رصيد كوينز النظام غير كافٍ';

    end if;


    v_balance := v_balance - p_coins;

    v_coins_out := p_coins;


    update public.wallets

    set balance = balance + p_amount,

        updated_at = now()

    where id = p_wallet_id;


  -- ======================================
  -- سحب التارجت
  -- الكوينز تدخل النظام.
  -- المبلغ النقدي يخرج من المحفظة.
  -- ======================================

  elsif p_operation_type = 'target' then

    if v_wallet.balance < p_amount then

      raise exception 'رصيد المحفظة غير كافٍ';

    end if;


    v_balance := v_balance + p_coins;

    v_coins_in := p_coins;


    update public.wallets

    set balance = balance - p_amount,

        updated_at = now()

    where id = p_wallet_id;


  -- ======================================
  -- مكاسب الألعاب
  -- الكوينز تدخل النظام.
  -- المبلغ النقدي يخرج من المحفظة.
  -- ======================================

  elsif p_operation_type = 'game_profit' then

    if v_wallet.balance < p_amount then

      raise exception 'رصيد المحفظة غير كافٍ';

    end if;


    v_balance := v_balance + p_coins;

    v_coins_in := p_coins;


    update public.wallets

    set balance = balance - p_amount,

        updated_at = now()

    where id = p_wallet_id;

  end if;


  -- حفظ العملية.

  insert into public.transactions (

    operation_type,

    coins,

    amount,

    currency,

    wallet_id,

    notes,

    created_by

  )

  values (

    p_operation_type,

    p_coins,

    p_amount,

    p_currency,

    p_wallet_id,

    nullif(trim(p_notes), ''),

    auth.uid()

  )

  returning id into v_transaction_id;


  -- حفظ حركة الكوينز.

  insert into public.system_ledger (

    coins_in,

    coins_out,

    coins_balance,

    reason

  )

  values (

    v_coins_in,

    v_coins_out,

    v_balance,

    p_operation_type

  );


  -- تسجيل العملية في سجل التدقيق.

  insert into public.audit_log (

    actor_id,

    action,

    entity,

    entity_id,

    details

  )

  values (

    auth.uid(),

    'record_transaction',

    'transactions',

    v_transaction_id::text,

    jsonb_build_object(

      'operation_type', p_operation_type,

      'coins', p_coins,

      'amount', p_amount,

      'currency', p_currency,

      'wallet_id', p_wallet_id

    )

  );


  return v_transaction_id;

end;

$$;


-- ==========================================
-- 8. تفعيل حماية الجداول
-- ==========================================

alter table public.profiles enable row level security;

alter table public.wallets enable row level security;

alter table public.system_ledger enable row level security;

alter table public.transactions enable row level security;

alter table public.audit_log enable row level security;


-- ==========================================
-- 9. سياسات الحسابات
-- ==========================================

drop policy if exists
  "profiles read own or manager"
on public.profiles;


create policy
  "profiles read own or manager"

on public.profiles

for select

to authenticated

using (

  id = auth.uid()

  or public.current_app_role() = 'manager'

);


-- ==========================================
-- 10. سياسات المحافظ
-- ==========================================

drop policy if exists
  "wallets read authenticated"
on public.wallets;


create policy
  "wallets read authenticated"

on public.wallets

for select

to authenticated

using (

  public.current_app_role() in ('manager', 'staff')

);


drop policy if exists
  "wallets manager insert"
on public.wallets;


create policy
  "wallets manager insert"

on public.wallets

for insert

to authenticated

with check (

  public.current_app_role() = 'manager'

);


drop policy if exists
  "wallets manager update"
on public.wallets;


create policy
  "wallets manager update"

on public.wallets

for update

to authenticated

using (

  public.current_app_role() = 'manager'

)

with check (

  public.current_app_role() = 'manager'

);


-- ==========================================
-- 11. سياسات العمليات والسجلات
-- ==========================================

drop policy if exists
  "transactions read authenticated"
on public.transactions;


create policy
  "transactions read authenticated"

on public.transactions

for select

to authenticated

using (

  public.current_app_role() in ('manager', 'staff')

);


drop policy if exists
  "ledger read authenticated"
on public.system_ledger;


create policy
  "ledger read authenticated"

on public.system_ledger

for select

to authenticated

using (

  public.current_app_role() in ('manager', 'staff')

);


drop policy if exists
  "audit manager read"
on public.audit_log;


create policy
  "audit manager read"

on public.audit_log

for select

to authenticated

using (

  public.current_app_role() = 'manager'

);


-- ==========================================
-- 12. صلاحية استدعاء دالة تسجيل العمليات
-- ==========================================

revoke all

on function public.record_transaction(
  text,
  numeric,
  numeric,
  text,
  uuid,
  text
)

from public, anon;


grant execute

on function public.record_transaction(
  text,
  numeric,
  numeric,
  text,
  uuid,
  text
)

to authenticated;


grant execute

on function public.current_app_role()

to authenticated;
