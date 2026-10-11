/*
========================================================
سستم شحن وكالة مجلس القمة
ملف تشغيل الواجهة
========================================================

المتطلبات:
1. إكمال config.js.
2. تنفيذ schema.sql في Supabase.
3. إنشاء حسابات المستخدمين.
4. إضافة صلاحيات الحسابات إلى profiles.

تنبيه:
هذا الملف لا يحتوي على كلمات مرور ثابتة.
لا تضع كلمات مرور المدير داخل JavaScript.
========================================================
*/

const client = window.supabase.createClient(
  window.APP_CONFIG.SUPABASE_URL,
  window.APP_CONFIG.SUPABASE_ANON_KEY
);

const $ = (id) => document.getElementById(id);

let currentRole = null;
let wallets = [];
let transactions = [];

const currencyNames = {
  JOD: "دينار أردني",
  USD: "دولار أمريكي",
  EGP: "جنيه مصري",
  TRY: "ليرة تركية"
};

const operationNames = {
  charge: "شحن مستخدم",
  target: "سحب تارجت",
  game_profit: "مكاسب ألعاب",
  adjustment: "تسوية إدارية"
};

function numberFormat(value) {
  return Number(value || 0).toLocaleString("en-US", {
    maximumFractionDigits: 2
  });
}

function showPage(pageId) {
  ["homePage", "loginPage", "dashboardPage"].forEach(id => {
    const element = $(id);

    if (element) {
      element.classList.toggle("hidden", id !== pageId);
    }
  });
}

function openLogin(role) {
  if (!["manager", "staff"].includes(role)) {
    return;
  }

  currentRole = role;

  $("loginForm").reset();
  $("loginError").textContent = "";

  $("usernameLabel").classList.toggle(
    "hidden",
    role === "staff"
  );

  $("username").required = role !== "staff";

  $("loginTitle").textContent =
    role === "manager"
      ? "دخول مدير الموقع"
      : "دخول مشرف الموقع";

  $("loginDescription").textContent =
    role === "manager"
      ? "أدخل اسم المستخدم وكلمة المرور."
      : "أدخل بيانات حساب المشرف.";

  showPage("loginPage");
}

window.openLogin = openLogin;
window.showPage = showPage;


// ======================================
// تسجيل الدخول
// ======================================

$("loginForm").addEventListener("submit", async event => {
  event.preventDefault();

  $("loginError").textContent = "";

  const username = $("username").value.trim();
  const password = $("password").value;
  const requestedRole = currentRole;

  if (
    !window.APP_CONFIG.SUPABASE_ANON_KEY ||
    window.APP_CONFIG.SUPABASE_ANON_KEY.includes("ضع_المفتاح")
  ) {
    $("loginError").textContent =
      "أضف مفتاح Supabase العام داخل config.js أولًا.";

    return;
  }

  const email = username === "jor"
    ? "jor@alqimma.local"
    : username === "f90"
      ? "f90@alqimma.local"
      : username;

  try {
    const { data, error } =
      await client.auth.signInWithPassword({
        email,
        password
      });

    if (error) throw error;

    const { data: profile, error: profileError } =
      await client
        .from("profiles")
        .select("role,display_name,active")
        .eq("id", data.user.id)
        .single();

    if (profileError) throw profileError;

    if (
      !profile ||
      !profile.active ||
      !["manager", "staff"].includes(profile.role)
    ) {
      await client.auth.signOut();

      throw new Error("الحساب غير مفعّل أو لا يملك صلاحية صحيحة.");
    }

    if (
      requestedRole === "manager" &&
      profile.role !== "manager"
    ) {
      await client.auth.signOut();

      throw new Error("هذا الحساب لا يملك صلاحية المدير.");
    }

    if (
      requestedRole === "staff" &&
      profile.role !== "staff"
    ) {
      await client.auth.signOut();

      throw new Error("هذا الحساب ليس حساب مشرف.");
    }

    currentRole = profile.role;

    $("dashboardTitle").textContent =
      currentRole === "manager"
        ? "لوحة مدير الموقع"
        : "لوحة مشرف الموقع";

    $("dashboardDescription").textContent =
      "مرحبًا " + (profile.display_name || username);

    $("managerPanel").classList.toggle(
      "hidden",
      currentRole !== "manager"
    );

    showPage("dashboardPage");

    await loadDashboard();

  } catch (error) {
    $("loginError").textContent =
      error.message || "تعذر تسجيل الدخول.";
  }
});


// ======================================
// تحميل البيانات
// ======================================

async function loadDashboard() {
  await Promise.all([
    loadWallets(),
    loadTransactions(),
    loadSystemLedger()
  ]);
}


// ======================================
// تحميل المحافظ
// ======================================

async function loadWallets() {
  const { data, error } = await client
    .from("wallets")
    .select("*")
    .eq("active", true)
    .order("name");

  if (error) {
    showNotice("تعذر تحميل المحافظ: " + error.message);
    return;
  }

  wallets = data || [];

  $("walletCount").textContent = wallets.length;

  $("operationWallet").innerHTML =
    '<option value="">اختر المحفظة</option>' +
    wallets.map(wallet => `
      <option value="${wallet.id}">
        ${escapeHTML(wallet.name)}
        — ${currencyNames[wallet.currency] || wallet.currency}
      </option>
    `).join("");

  renderWallets();
}


// ======================================
// عرض المحافظ
// ======================================

function renderWallets() {
  $("walletList").innerHTML = wallets.length
    ? wallets.map(wallet => `
      <article class="wallet-card">
        <strong>${escapeHTML(wallet.name)}</strong>

        <p>
          العملة:
          ${currencyNames[wallet.currency] || wallet.currency}
        </p>

        <p>
          الرصيد: ${numberFormat(wallet.balance)}
        </p>
      </article>
    `).join("")
    : "<p>لا توجد محافظ مضافة.</p>";
}


// ======================================
// تحميل سجل العمليات
// ======================================

async function loadTransactions() {
  const { data, error } = await client
    .from("transactions")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(1000);

  if (error) {
    showNotice("تعذر تحميل السجلات: " + error.message);
    return;
  }

  transactions = data || [];

  renderTransactions();
}


// ======================================
// عرض سجل العمليات
// ======================================

function renderTransactions() {
  const from = $("dateFrom").value;
  const to = $("dateTo").value;

  const filtered = transactions.filter(transaction => {
    const date = new Date(transaction.created_at)
      .toISOString()
      .slice(0, 10);

    return (!from || date >= from) &&
           (!to || date <= to);
  });

  $("transactionsTable").innerHTML = filtered.length
    ? filtered.map(transaction => {
      const wallet = wallets.find(
        item => item.id === transaction.wallet_id
      );

      return `
        <tr>
          <td>
            ${new Date(transaction.created_at)
              .toLocaleString("ar")}
          </td>

          <td>
            ${operationNames[transaction.operation_type]
              || escapeHTML(transaction.operation_type)}
          </td>

          <td>${numberFormat(transaction.coins)}</td>

          <td>${numberFormat(transaction.amount)}</td>

          <td>
            ${currencyNames[transaction.currency]
              || escapeHTML(transaction.currency)}
          </td>

          <td>${escapeHTML(wallet?.name || "—")}</td>
        </tr>
      `;
    }).join("")
    : '<tr><td colspan="6">لا توجد عمليات.</td></tr>';
}


// ======================================
// تحميل دفتر كوينز النظام
// ======================================

async function loadSystemLedger() {
  const { data, error } = await client
    .from("system_ledger")
    .select("coins_in,coins_out,coins_balance")
    .order("id", { ascending: false })
    .limit(1);

  if (error) {
    showNotice("تعذر تحميل رصيد النظام: " + error.message);
    return;
  }

  const ledger = data?.[0];

  $("coinsBalance").textContent =
    numberFormat(ledger?.coins_balance || 0);

  const { data: allRows, error: totalsError } = await client
    .from("system_ledger")
    .select("coins_in,coins_out");

  if (totalsError) {
    showNotice("تعذر حساب إجماليات الكوينز.");
    return;
  }

  $("coinsIn").textContent = numberFormat(
    (allRows || []).reduce(
      (sum, row) => sum + Number(row.coins_in || 0),
      0
    )
  );

  $("coinsOut").textContent = numberFormat(
    (allRows || []).reduce(
      (sum, row) => sum + Number(row.coins_out || 0),
      0
    )
  );
}


// ======================================
// تسجيل عملية جديدة
// ======================================

$("operationForm").addEventListener("submit", async event => {
  event.preventDefault();

  $("operationMessage").textContent = "";

  const operationType = $("operationType").value;
  const coins = Number($("operationCoins").value);
  const amount = Number($("operationAmount").value);
  const currency = $("operationCurrency").value;
  const walletId = $("operationWallet").value;
  const notes = $("operationNotes").value.trim() || null;

  if (!Number.isSafeInteger(coins) || coins <= 0) {
    $("operationMessage").textContent =
      "أدخل عدد كوينز صحيحًا وموجبًا.";
    return;
  }

  if (!Number.isFinite(amount) || amount < 0) {
    $("operationMessage").textContent =
      "المبلغ المدخل غير صحيح.";
    return;
  }

  if (!walletId) {
    $("operationMessage").textContent =
      "اختر المحفظة أولًا.";
    return;
  }

  const wallet = wallets.find(item => item.id === walletId);

  if (!wallet || wallet.currency !== currency) {
    $("operationMessage").textContent =
      "يجب أن تتطابق عملة العملية مع عملة المحفظة.";
    return;
  }

  try {
    const { error } = await client.rpc(
      "record_transaction",
      {
        p_operation_type: operationType,
        p_coins: coins,
        p_amount: amount,
        p_currency: currency,
        p_wallet_id: walletId,
        p_notes: notes
      }
    );

    if (error) throw error;

    $("operationMessage").textContent =
      "تم حفظ العملية وتحديث الأرصدة.";

    $("operationForm").reset();

    await loadDashboard();

  } catch (error) {
    $("operationMessage").textContent =
      "تعذر حفظ العملية: " + error.message;
  }
});


// ======================================
// إضافة محفظة
// ======================================

$("walletForm").addEventListener("submit", async event => {
  event.preventDefault();

  if (currentRole !== "manager") {
    showNotice("هذه العملية متاحة للمدير فقط.");
    return;
  }

  const name = $("walletName").value.trim();
  const currency = $("walletCurrency").value;

  if (!name) return;

  const { error } = await client
    .from("wallets")
    .insert({
      name,
      currency,
      balance: 0,
      active: true
    });

  if (error) {
    showNotice("تعذر إضافة المحفظة: " + error.message);
    return;
  }

  $("walletForm").reset();

  await loadWallets();
});


// ======================================
// تصدير CSV
// ======================================

$("exportButton").addEventListener("click", () => {
  const headers = [
    "created_at",
    "operation_type",
    "coins",
    "amount",
    "currency",
    "wallet_id",
    "notes"
  ];

  const rows = [
    headers.join(","),

    ...transactions.map(transaction =>
      headers.map(key => {
        const value = String(transaction[key] ?? "")
          .replace(/"/g, '""');

        return `"${value}"`;
      }).join(",")
    )
  ];

  const blob = new Blob(
    ["\ufeff" + rows.join("\r\n")],
    { type: "text/csv;charset=utf-8;" }
  );

  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");

  link.href = url;
  link.download = "alqimma-transactions.csv";

  document.body.appendChild(link);
  link.click();
  link.remove();

  setTimeout(() => URL.revokeObjectURL(url), 1000);
});


// ======================================
// أدوات الواجهة
// ======================================

function escapeHTML(value) {
  return String(value ?? "").replace(/[&<>"']/g, character => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[character]);
}

function showNotice(message) {
  $("systemNotice").textContent = message;
  $("systemNotice").classList.remove("hidden");
}


// ======================================
// الأزرار
// ======================================

$("refreshButton").addEventListener(
  "click",
  loadDashboard
);

$("filterButton").addEventListener(
  "click",
  renderTransactions
);

$("logoutButton").addEventListener("click", async () => {
  await client.auth.signOut();

  currentRole = null;

  showPage("homePage");
});

$("themeToggle").addEventListener("click", () => {
  document.body.classList.toggle("dark");

  localStorage.setItem(
    "alqimma-theme",
    document.body.classList.contains("dark")
      ? "dark"
      : "light"
  );
});

if (localStorage.getItem("alqimma-theme") === "dark") {
  document.body.classList.add("dark");
}

$("year").textContent = new Date().getFullYear();


// ======================================
// استعادة جلسة دخول سابقة
// ======================================

(async () => {
  const { data, error: sessionError } =
    await client.auth.getSession();

  if (sessionError || !data.session) {
    return;
  }

  const { data: profile, error } = await client
    .from("profiles")
    .select("role,display_name,active")
    .eq("id", data.session.user.id)
    .single();

  if (
    !error &&
    profile?.active &&
    ["manager", "staff"].includes(profile.role)
  ) {
    currentRole = profile.role;

    $("dashboardTitle").textContent =
      currentRole === "manager"
        ? "لوحة مدير الموقع"
        : "لوحة مشرف الموقع";

    $("dashboardDescription").textContent =
      "مرحبًا " + (profile.display_name || "");

    $("managerPanel").classList.toggle(
      "hidden",
      currentRole !== "manager"
    );

    showPage("dashboardPage");

    await loadDashboard();

  } else {
    await client.auth.signOut();
    currentRole = null;
    showPage("homePage");
  }
})();
