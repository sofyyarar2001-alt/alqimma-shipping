"use strict";

const client = window.supabase.createClient(
  window.APP_CONFIG.SUPABASE_URL,
  window.APP_CONFIG.SUPABASE_ANON_KEY
);

const $ = id => document.getElementById(id);

let currentRole = null;
let currentProfile = null;
let wallets = [];
let transactions = [];
let ledgerRows = [];

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

const formatNumber = value =>
  Number(value || 0).toLocaleString("en-US", {
    maximumFractionDigits: 2
  });

function escapeHTML(value) {
  return String(value ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[c]);
}

function notify(message, type = "info") {
  const box = $("systemNotice");
  if (!box) {
    alert(message);
    return;
  }

  box.textContent = message;
  box.dataset.type = type;
  box.classList.remove("hidden");

  clearTimeout(notify.timer);
  notify.timer = setTimeout(() => {
    box.classList.add("hidden");
  }, 6000);
}

function showPage(pageId) {
  ["homePage", "loginPage", "dashboardPage"].forEach(id => {
    const element = $(id);
    if (element) {
      element.classList.toggle("hidden", id !== pageId);
    }
  });
}

window.showPage = showPage;

window.openLogin = role => {
  if (!["manager", "staff"].includes(role)) return;

  currentRole = role;

  $("loginForm").reset();
  $("loginError").textContent = "";

  $("usernameLabel").classList.remove("hidden");
  $("username").required = true;
  $("username").disabled = false;

  $("loginTitle").textContent =
    role === "manager" ? "دخول المدير" : "دخول المشرف";

  $("loginDescription").textContent =
    role === "manager"
      ? "أدخل اسم المستخدم وكلمة المرور."
      : "أدخل اسم المستخدم وكلمة مرور حساب المشرف.";

  showPage("loginPage");
};

function usernameToEmail(username) {
  const value = username.trim();

  if (value.includes("@")) return value;

  const aliases = {
    jor: "jor@alqimma.local",
    f90: "f90@alqimma.local"
  };

  return aliases[value.toLowerCase()] || "";
}

async function getProfile(userId) {
  const { data, error } = await client
    .from("profiles")
    .select("id,username,display_name,role,active")
    .eq("id", userId)
    .maybeSingle();

  if (error) throw error;
  if (!data || !data.active) {
    throw new Error("الحساب غير موجود أو غير مفعّل.");
  }

  return data;
}

async function login(event) {
  event.preventDefault();

  const errorBox = $("loginError");
  errorBox.textContent = "";

  const username = $("username").value.trim();
  const password = $("password").value;

  if (!username || !password) {
    errorBox.textContent = "أدخل اسم المستخدم وكلمة المرور.";
    return;
  }

  const email = usernameToEmail(username);

  if (!email) {
    errorBox.textContent =
      "اسم المستخدم غير مربوط ببريد حساب. استخدم البريد المسجل في Supabase Auth.";
    return;
  }

  const submitButton =
    $("loginForm").querySelector('button[type="submit"]');

  submitButton.disabled = true;

  try {
    const { data, error } = await client.auth.signInWithPassword({
      email,
      password
    });

    if (error) throw error;

    const profile = await getProfile(data.user.id);

    if (profile.role !== currentRole) {
      await client.auth.signOut();
      throw new Error("هذا الحساب لا يملك صلاحية الدخول إلى هذه الصفحة.");
    }

    await enterDashboard(profile);
  } catch (error) {
    errorBox.textContent =
      error.message || "تعذر تسجيل الدخول.";
  } finally {
    submitButton.disabled = false;
  }
}

$("loginForm").addEventListener("submit", login);

async function enterDashboard(profile) {
  currentProfile = profile;
  currentRole = profile.role;

  $("dashboardTitle").textContent =
    currentRole === "manager"
      ? "مركز إدارة وكالة مجلس القمة"
      : "لوحة عمليات المشرف";

  $("dashboardDescription").textContent =
    `مرحبًا ${profile.display_name || profile.username || ""}`;

  $("managerPanel").classList.toggle(
    "hidden",
    currentRole !== "manager"
  );

  document.body.dataset.role = currentRole;

  showPage("dashboardPage");

  await loadDashboard();
}

async function loadDashboard() {
  await Promise.all([
    loadWallets(),
    loadTransactions(),
    loadLedger()
  ]);
}

async function loadWallets() {
  const { data, error } = await client
    .from("wallets")
    .select("*")
    .eq("active", true)
    .order("name");

  if (error) {
    notify("تعذر تحميل المحافظ: " + error.message, "error");
    return;
  }

  wallets = data || [];

  $("walletCount").textContent = wallets.length;

  const options = wallets.map(wallet => `
    <option value="${escapeHTML(wallet.id)}">
      ${escapeHTML(wallet.name)} — ${currencyNames[wallet.currency] || wallet.currency}
    </option>
  `).join("");

  $("operationWallet").innerHTML =
    '<option value="">اختر المحفظة</option>' + options;

  $("adjustWalletId").innerHTML =
    '<option value="">اختر المحفظة</option>' + options;

  $("walletList").innerHTML = wallets.length
    ? wallets.map(wallet => `
      <article class="wallet-card">
        <span class="wallet-currency">
          ${escapeHTML(currencyNames[wallet.currency] || wallet.currency)}
        </span>
        <strong>${escapeHTML(wallet.name)}</strong>
        <p>الرصيد</p>
        <h3>${formatNumber(wallet.balance)}</h3>
      </article>
    `).join("")
    : '<p>لا توجد محافظ نشطة.</p>';

  renderTransactions();
}

async function loadTransactions() {
  const { data, error } = await client
    .from("transactions")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(1000);

  if (error) {
    notify("تعذر تحميل العمليات: " + error.message, "error");
    return;
  }

  transactions = data || [];
  renderTransactions();
}

function renderTransactions() {
  const from = $("dateFrom").value;
  const to = $("dateTo").value;

  const filtered = transactions.filter(item => {
    const date = String(item.created_at).slice(0, 10);
    return (!from || date >= from) && (!to || date <= to);
  });

  $("transactionsTable").innerHTML = filtered.length
    ? filtered.map(item => {
        const wallet = wallets.find(w => w.id === item.wallet_id);

        return `
          <tr>
            <td>${escapeHTML(new Date(item.created_at).toLocaleString("ar"))}</td>
            <td>${escapeHTML(operationNames[item.operation_type] || item.operation_type)}</td>
            <td>${formatNumber(item.coins)}</td>
            <td>${formatNumber(item.amount)}</td>
            <td>${escapeHTML(currencyNames[item.currency] || item.currency)}</td>
            <td>${escapeHTML(wallet?.name || "—")}</td>
            <td>${escapeHTML(item.notes || "—")}</td>
          </tr>
        `;
      }).join("")
    : '<tr><td colspan="7">لا توجد عمليات في الفترة المحددة.</td></tr>';
}

async function loadLedger() {
  const { data, error } = await client
    .from("system_ledger")
    .select("coins_in,coins_out,coins_balance")
    .order("id", { ascending: false })
    .limit(1000);

  if (error) {
    notify("تعذر تحميل دفتر الكوينز: " + error.message, "error");
    return;
  }

  ledgerRows = data || [];

  const latest = ledgerRows[0];

  $("coinsBalance").textContent =
    formatNumber(latest?.coins_balance || 0);

  $("coinsIn").textContent = formatNumber(
    ledgerRows.reduce((sum, row) => sum + Number(row.coins_in || 0), 0)
  );

  $("coinsOut").textContent = formatNumber(
    ledgerRows.reduce((sum, row) => sum + Number(row.coins_out || 0), 0)
  );
}

$("operationForm").addEventListener("submit", async event => {
  event.preventDefault();

  const message = $("operationMessage");
  message.textContent = "";

  const operationType = $("operationType").value;
  const coins = Number($("operationCoins").value);
  const amount = Number($("operationAmount").value);
  const currency = $("operationCurrency").value;
  const walletId = $("operationWallet").value;
  const notes = $("operationNotes").value.trim() || null;

  if (!Number.isSafeInteger(coins) || coins <= 0) {
    message.textContent = "أدخل عدد كوينز صحيحًا وموجبًا.";
    return;
  }

  if (!Number.isFinite(amount) || amount < 0) {
    message.textContent = "أدخل مبلغًا صحيحًا.";
    return;
  }

  const wallet = wallets.find(w => w.id === walletId);

  if (!wallet || wallet.currency !== currency) {
    message.textContent = "اختر محفظة مطابقة للعملة.";
    return;
  }

  const button = event.submitter;
  if (button) button.disabled = true;

  try {
    const { error } = await client.rpc("record_transaction", {
      p_operation_type: operationType,
      p_coins: coins,
      p_amount: amount,
      p_currency: currency,
      p_wallet_id: walletId,
      p_notes: notes
    });

    if (error) throw error;

    message.textContent = "تم حفظ العملية بنجاح.";
    $("operationForm").reset();

    await loadDashboard();
  } catch (error) {
    message.textContent = "فشلت العملية: " + error.message;
  } finally {
    if (button) button.disabled = false;
  }
});

$("walletForm").addEventListener("submit", async event => {
  event.preventDefault();

  if (currentRole !== "manager") {
    notify("هذه العملية للمدير فقط.", "error");
    return;
  }

  const name = $("walletName").value.trim();
  const currency = $("walletCurrency").value;

  if (!name) return;

  try {
    const { error } = await client.from("wallets").insert({
      name,
      currency,
      balance: 0,
      active: true
    });

    if (error) throw error;

    $("walletForm").reset();
    notify("تمت إضافة المحفظة بنجاح.", "success");
    await loadWallets();
  } catch (error) {
    notify("تعذرت إضافة المحفظة: " + error.message, "error");
  }
});

$("walletAdjustForm").addEventListener("submit", async event => {
  event.preventDefault();

  if (currentRole !== "manager") {
    notify("هذه العملية للمدير فقط.", "error");
    return;
  }

  const walletId = $("adjustWalletId").value;
  const amount = Number($("adjustWalletAmount").value);
  const direction = $("adjustWalletDirection").value;
  const reason = $("adjustWalletReason").value.trim();

  if (!walletId || !Number.isFinite(amount) || amount <= 0 || !reason) {
    notify("أكمل بيانات تعديل المحفظة بشكل صحيح.", "error");
    return;
  }

  try {
    const { error } = await client.rpc("adjust_wallet_balance", {
      p_wallet_id: walletId,
      p_amount: amount,
      p_direction: direction,
      p_reason: reason
    });

    if (error) throw error;

    $("walletAdjustForm").reset();
    notify("تم تعديل رصيد المحفظة وتسجيل الحركة.", "success");
    await loadDashboard();
  } catch (error) {
    notify("تعذر تعديل المحفظة: " + error.message, "error");
  }
});

$("systemCoinsForm").addEventListener("submit", async event => {
  event.preventDefault();

  if (currentRole !== "manager") {
    notify("هذه العملية للمدير فقط.", "error");
    return;
  }

  const coins = Number($("systemCoinsAmount").value);
  const direction = $("systemCoinsDirection").value;
  const reason = $("systemCoinsReason").value.trim();

  if (!Number.isSafeInteger(coins) || coins <= 0 || !reason) {
    notify("أدخل عدد كوينز صحيحًا وسبب التعديل.", "error");
    return;
  }

  try {
    const { error } = await client.rpc("adjust_system_coins", {
      p_coins: coins,
      p_direction: direction,
      p_reason: reason
    });

    if (error) throw error;

    $("systemCoinsForm").reset();
    notify("تم تعديل كوينز النظام وتسجيل الحركة.", "success");
    await loadLedger();
  } catch (error) {
    notify("تعذر تعديل كوينز النظام: " + error.message, "error");
  }
});

$("filterButton").addEventListener("click", renderTransactions);

$("refreshButton").addEventListener("click", loadDashboard);

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
    ...transactions.map(item =>
      headers.map(key =>
        `"${String(item[key] ?? "").replace(/"/g, '""')}"`
      ).join(",")
    )
  ];

  const blob = new Blob(["\ufeff" + rows.join("\r\n")], {
    type: "text/csv;charset=utf-8;"
  });

  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");

  link.href = url;
  link.download = "alqimma-transactions.csv";
  link.click();

  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

$("logoutButton").addEventListener("click", async () => {
  await client.auth.signOut();

  currentRole = null;
  currentProfile = null;
  wallets = [];
  transactions = [];

  document.body.removeAttribute("data-role");
  showPage("homePage");
});

$("themeToggle").addEventListener("click", () => {
  document.body.classList.toggle("dark");

  localStorage.setItem(
    "alqimma-theme",
    document.body.classList.contains("dark") ? "dark" : "light"
  );
});

if (localStorage.getItem("alqimma-theme") === "dark") {
  document.body.classList.add("dark");
}

$("year").textContent = new Date().getFullYear();

(async function restoreSession() {
  try {
    const { data, error } = await client.auth.getSession();

    if (error || !data.session) return;

    const profile = await getProfile(data.session.user.id);
    await enterDashboard(profile);
  } catch {
    await client.auth.signOut();
    showPage("homePage");
  }
})();
