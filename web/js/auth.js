/* Signing in: turning "someone opened the page" into a server session for a verified Matrix ID.

   In order (docs/research/matrix-widget.md §1.6, §4):
   1. A plain browser tab opened from the widget carries #handoff=<code> in the fragment
      (fragments never reach server logs). We redeem it and strip it from the URL at once.
   2. A session token from earlier in this tab (sessionStorage) is checked with /api/me.
   3. Inside a widget: ask the Matrix client for an OpenID token and post it to /api/auth/openid.
      No UI unless that fails; the client may show its own permission prompt meanwhile.
   4. Otherwise a sign-in screen: retry OpenID (widget), "get a code by Matrix DM" (when the
      server has a bot account), and a dev login form when the server runs with DEV_AUTH=1.

   openInBrowserTab() is the widget's way out to a real tab: Element's pop-out drops the widget
   parameters, Commet/Vommet widget windows are incognito, and downloads are friendlier there. It
   mints a single-use 2-minute handoff code and window.open()s the page with #handoff=<code>
   from the click on the dialog's button, so popup blockers see a user gesture. */
import { h, clear, spinner, dialog, toast, copyText } from "./ui.js";

const HANDOFF_RE = /(?:^#|[#&])handoff=([A-Za-z0-9_-]{8,200})(?:&|$)/;

/** Read and remove #handoff=<code> from the address bar. */
export function takeHandoffCode() {
  const m = HANDOFF_RE.exec(location.hash || "");
  if (!m) return null;
  try { history.replaceState(null, "", location.pathname + location.search); } catch { location.hash = ""; }
  return m[1];
}

/** Ask the Matrix client for an OpenID token and trade it for our own session. */
export async function openIdLogin({ api, matrix }) {
  const openid = await matrix.openIdToken();
  // Display name is cosmetic (the server keeps the verified id); prefer member state over the URL.
  const displayName = (matrix.hints.userId && matrix.displayName(matrix.hints.userId)) || matrix.hints.displayName || undefined;
  const r = await api.post("api/auth/openid", { openid, displayName }, { auth: false });
  api.setToken(r.token);
  return r.user;
}

async function checkExistingSession({ api, matrix }) {
  if (!api.token) return null;
  try {
    const { user } = await api.get("api/me");
    // Same-origin widgets can share a tab's sessionStorage (two accounts in the dev harness,
    // or a different account in the same Element tab): a hint that disagrees means re-verify.
    if (user && !(matrix.isWidget && matrix.hints.userId && matrix.hints.userId !== user.id)) return user;
  } catch { /* expired or unreachable: sign in again */ }
  api.clearToken();
  return null;
}

/**
 * Run the sign-in flow. Renders into `el` only when it needs the user.
 *   ctx = { api, config, matrix, el, status(text) }
 * Resolves with the server's user { id, displayName }; the token is already set on api.
 */
export async function signIn(ctx) {
  const { api, matrix, status } = ctx;
  let error = null;

  if (!matrix.isWidget) {
    const code = takeHandoffCode();
    if (code) {
      status("Signing you in…");
      try {
        const r = await api.post("api/auth/handoff/redeem", { code }, { auth: false });
        api.setToken(r.token);
        return r.user;
      } catch (e) {
        error = e.message;
      }
    }
  }

  status("Checking your session…");
  const existing = await checkExistingSession(ctx);
  if (existing) return existing;

  if (matrix.isWidget) {
    status("Asking your Matrix client who you are… If it asks whether this widget may verify your identity, choose Allow.");
    try {
      return await openIdLogin(ctx);
    } catch (e) {
      console.warn("OpenID sign-in failed:", e.message);
      error = e.message;
    }
  }

  return showSignInScreen(ctx, error);
}

function notice(text, kind = "error") {
  return h("div", { class: ["notice", "notice-" + kind], role: kind === "error" ? "alert" : "status" }, text);
}

function field(label, input, hint) {
  return h("label", { class: "field" }, h("span", { class: "field-label" }, label), input, hint && h("span", { class: "field-hint" }, hint));
}

/** Show the sign-in card in ctx.el and resolve when one of the methods succeeds. */
function showSignInScreen(ctx, initialError) {
  const { api, config, matrix, el } = ctx;
  return new Promise((resolve) => {
    let finished = false;
    const done = (user) => { if (!finished) { finished = true; resolve(user); } };
    const errorSlot = h("div", { class: "signin-error" }, initialError && notice(initialError));
    const showError = (msg) => clear(errorSlot, msg && notice(msg));
    const sections = h("div", { class: "signin-methods" });

    const card = h("div", { class: "card signin-card" },
      h("div", { class: "signin-head" },
        h("span", { class: "brand-mark brand-mark-lg", "aria-hidden": "true" }, h("i"), h("i"), h("i"), h("i")),
        h("div", null, h("h1", null, "Sign in"), h("p", { class: "muted" }, "Your boxes, trades and battles belong to your Matrix account."))),
      errorSlot,
      sections);
    clear(el, h("div", { class: "screen screen-center" }, card));

    /* --- widget: retry OpenID --- */
    if (matrix.isWidget) {
      const wait = h("div", { class: "signin-wait", hidden: true },
        spinner("Waiting for your Matrix client… If it shows a permission prompt, choose Allow."));
      const retry = h("button", { type: "button", class: "btn btn-primary btn-block" }, "Retry with Matrix");
      retry.addEventListener("click", async () => {
        retry.disabled = true;
        wait.hidden = false;
        showError(null);
        try {
          done(await openIdLogin(ctx));
        } catch (e) {
          showError(e.message);
        } finally {
          retry.disabled = false;
          wait.hidden = true;
        }
      });
      sections.append(h("section", { class: "signin-method" },
        h("h3", null, "Matrix identity check"),
        h("p", { class: "muted" }, "Your Matrix client confirms who you are to this server. Nothing else from your account is shared."),
        retry, wait));
    }

    const methodsSlot = h("div", null, spinner("Loading sign-in options…"));
    sections.append(methodsSlot);

    api.get("api/auth/methods", { auth: false }).catch(() => ({ dmCode: !!config.dmCodeLogin, dev: !!config.devAuth })).then((methods) => {
      clear(methodsSlot);
      if (methods.dmCode) methodsSlot.append(dmCodeSection(ctx, done, showError));
      if (methods.dev) methodsSlot.append(devSection(ctx, done, showError));
      if (!matrix.isWidget && !methods.dmCode && !methods.dev) {
        methodsSlot.append(notice("Open this page from the widget in your Matrix room, then use “Open in browser tab” in its menu to continue here.", "info"));
      }
    });
  });
}

/* --- "Get a code by Matrix DM" (bot account) --- */
function dmCodeSection({ api, matrix }, done, showError) {
  const idInput = h("input", { class: "input", type: "text", name: "mxid", placeholder: "@you:example.org", autocomplete: "username", spellcheck: "false", value: matrix.hints.userId || "" });
  const codeInput = h("input", { class: "input input-code", type: "text", name: "code", inputmode: "numeric", autocomplete: "one-time-code", maxlength: 6, placeholder: "123456", pattern: "[0-9]{6}" });
  const sendBtn = h("button", { type: "submit", class: "btn btn-primary" }, "Send me a code");
  const verifyBtn = h("button", { type: "submit", class: "btn btn-primary" }, "Sign in");
  const sentTo = h("strong");
  let userId = "";

  const step1 = h("form", { class: "stack" }, field("Matrix ID", idInput, "A bot will send you a 6-digit code in a direct message."), sendBtn);
  const back = h("button", { type: "button", class: "btn btn-ghost" }, "Use a different ID");
  const step2 = h("form", { class: "stack", hidden: true },
    h("p", { class: "muted" }, "Code sent to ", sentTo, ". It expires in 10 minutes."),
    field("Code", codeInput), h("div", { class: "row" }, verifyBtn, back));

  step1.addEventListener("submit", async (e) => {
    e.preventDefault();
    userId = idInput.value.trim();
    if (!/^@[^:\s]+:\S+$/.test(userId)) { showError("Enter your full Matrix ID, like @name:example.org"); return; }
    sendBtn.disabled = true;
    showError(null);
    try {
      await api.post("api/auth/code/request", { userId }, { auth: false });
      sentTo.textContent = userId;
      step1.hidden = true;
      step2.hidden = false;
      codeInput.value = "";
      codeInput.focus();
    } catch (err) {
      showError(err.message);
    } finally {
      sendBtn.disabled = false;
    }
  });
  step2.addEventListener("submit", async (e) => {
    e.preventDefault();
    const code = codeInput.value.replace(/\D/g, "");
    if (code.length !== 6) { showError("The code has 6 digits."); return; }
    verifyBtn.disabled = true;
    showError(null);
    try {
      const r = await api.post("api/auth/code/verify", { userId, code }, { auth: false });
      api.setToken(r.token);
      done(r.user);
    } catch (err) {
      showError(err.message);
    } finally {
      verifyBtn.disabled = false;
    }
  });
  back.addEventListener("click", () => { step2.hidden = true; step1.hidden = false; idInput.focus(); });

  return h("section", { class: "signin-method" }, h("h3", null, "Get a code by Matrix DM"), step1, step2);
}

/* --- dev login (DEV_AUTH=1 only; the server refuses it otherwise) --- */
function devSection({ api, matrix }, done, showError) {
  const idInput = h("input", { class: "input", type: "text", name: "dev-user", value: matrix.hints.userId || "@ash:example.org", spellcheck: "false", autocomplete: "off" });
  const nameInput = h("input", { class: "input", type: "text", name: "dev-name", value: matrix.hints.displayName || "", placeholder: "Ash", autocomplete: "off" });
  const btn = h("button", { type: "submit", class: "btn" }, "Dev sign-in");
  const form = h("form", { class: "stack" }, h("div", { class: "row row-fields" }, field("User ID", idInput), field("Display name", nameInput)), btn);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    btn.disabled = true;
    showError(null);
    try {
      const r = await api.post("api/auth/dev", { userId: idInput.value.trim(), displayName: nameInput.value.trim() || undefined }, { auth: false });
      api.setToken(r.token);
      done(r.user);
    } catch (err) {
      showError(err.message);
    } finally {
      btn.disabled = false;
    }
  });
  return h("section", { class: "signin-method signin-dev" },
    h("h3", null, "Developer sign-in ", h("span", { class: "badge badge-warn" }, "DEV_AUTH")),
    h("p", { class: "muted" }, "This server trusts any user ID. Never enable this in production."),
    form);
}

/* ---------- widget -> browser tab ---------- */

/** URL of this page for a browser tab: no widget parameters, the room id and theme kept. */
export function handoffUrl(code, matrix) {
  const u = new URL(location.href);
  u.search = "";
  if (matrix.roomId()) u.searchParams.set("roomId", matrix.roomId());
  const theme = matrix.theme() || matrix.hints.theme;   // current, after any theme_change push
  if (theme) u.searchParams.set("theme", theme);
  if (matrix.hints.lang) u.searchParams.set("lang", matrix.hints.lang);
  u.hash = "handoff=" + encodeURIComponent(code);
  return u.href;
}

/** Dialog that mints a handoff code and opens a browser tab signed in as the same user. */
export function openInBrowserTab({ api, matrix }) {
  let code = null;
  let expiresAt = 0;
  let openBtn = null, copyBtn = null;
  const status = h("p", { class: "muted", role: "status" }, "Preparing a one-time sign-in link…");

  const mint = async () => {
    code = null;
    if (openBtn) { openBtn.disabled = true; copyBtn.disabled = true; }
    status.textContent = "Preparing a one-time sign-in link…";
    status.classList.remove("text-error");
    try {
      const r = await api.post("api/auth/handoff", {});
      code = r.code;
      expiresAt = Date.now() + (r.expiresIn || 120) * 1000 - 5000;
      status.textContent = "The link signs you in once and expires in 2 minutes.";
      if (openBtn) { openBtn.disabled = false; copyBtn.disabled = false; }
    } catch (e) {
      status.textContent = e.message;
      status.classList.add("text-error");
    }
  };
  const fresh = () => {
    if (code && Date.now() < expiresAt) return true;
    mint();
    status.textContent = "That link expired; preparing a new one…";
    return false;
  };

  const minting = mint();
  return dialog({
    title: "Open in a browser tab",
    body: [
      h("p", null, "Continue in a normal browser tab: handy for downloading saves, for a bigger window, and in Matrix clients whose widget windows forget your session."),
      status,
    ],
    buttons: [
      { label: "Cancel", value: false, kind: "ghost" },
      {
        label: "Copy link", value: "copy", kind: "ghost", disabled: true,
        onClick: async () => {
          if (!fresh()) return false;
          const ok = await copyText(handoffUrl(code, matrix));
          toast(ok ? "Link copied. It works once, for 2 minutes." : "Could not copy; use “Open tab” instead.", ok ? "ok" : "warn");
          return ok ? undefined : false;
        },
      },
      {
        label: "Open tab", value: true, kind: "primary", disabled: true,
        onClick: () => {
          if (!fresh()) return false;
          // Synchronous inside the click: Element Web opens a real tab (allow-popups-to-escape-
          // sandbox), Element Desktop hands it to the system browser.
          window.open(handoffUrl(code, matrix), "_blank", "noopener");
          code = null;   // single use
          return true;
        },
      },
    ],
    cancelValue: false,
    onOpen: (c) => {
      copyBtn = c.buttons[1];
      openBtn = c.buttons[2];
      minting.then(() => { if (code) { openBtn.disabled = false; copyBtn.disabled = false; openBtn.focus(); } });
    },
  });
}

/** End this tab's session (the widget would just sign in again silently, so tabs only). */
export async function signOut({ api }) {
  try { await api.post("api/auth/logout", {}); } catch { /* already gone */ }
  api.clearToken();
}
