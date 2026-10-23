/*
 * MY FB Autopilot global engine
 * 1) Configure Firebase web credentials using deployment config or replace
 *    the placeholder object below with your Firebase project's web config.
 * 2) Set window.FB_APP_ID before this module loads.
 * 3) Backend must validate Firebase ID tokens and store Page tokens server-side.
 *
 * Never store Facebook Page access tokens in localStorage/sessionStorage.
 */
import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-app.js";
import {
  getAuth, setPersistence, browserLocalPersistence, browserSessionPersistence,
  onAuthStateChanged, signInWithEmailAndPassword, signOut
} from "https://www.gstatic.com/firebasejs/12.2.1/firebase-auth.js";

const firebaseConfig = window.FIREBASE_CONFIG || {
  apiKey: "AIzaSyB_GX5qo2NVLWa8Znid5wteVy91D5s44Jc",
  authDomain: "newtry-79452.firebaseapp.com",
  projectId: "newtry-79452",
  appId: "1:719127182184:web:85b7e973308a163da9b4dd"
};
const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
export const auth = getAuth(app);
window.auth = auth;
window.firebaseAuth = auth;
window.onFirebaseAuthReady = callback => onAuthStateChanged(auth, callback);

const $ = (selector, root = document) => root.querySelector(selector);
const LOGIN_PATH = new URL("./login.html", document.baseURI).href;
const DASHBOARD_PATH = new URL("./index.html", document.baseURI).href;
const currentPath = window.location.pathname;
const isLoginPage = /\/login\.html$/.test(currentPath) || currentPath.endsWith("/login.html");
const isDashboardPage = /\/index\.html$/.test(currentPath) || currentPath.endsWith("/") || currentPath.endsWith("/public");
const isSubmodulePage = /\/(posts|messages|comments)\/index\.html$/.test(currentPath);

export function showNotification(message, type = "info") {
  const container = document.getElementById("toast-container");
  if (!container) return;
  const toast = document.createElement("div");
  toast.className = `custom-toast toast-${type}`;
  const icon = document.createElement("span");
  icon.className = "toast-icon";
  icon.textContent = type === "success" ? "✓" : type === "error" ? "!" : "i";
  const text = document.createElement("span");
  text.className = "toast-message";
  text.textContent = String(message);
  const close = document.createElement("button");
  close.type = "button"; close.className = "toast-close"; close.setAttribute("aria-label", "Dismiss notification"); close.textContent = "×";
  close.addEventListener("click", () => removeToast(toast));
  toast.append(icon, text, close);
  container.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add("is-visible"));
  window.setTimeout(() => removeToast(toast), 3500);
}
function removeToast(toast) {
  if (!toast || toast.dataset.removing) return;
  toast.dataset.removing = "true";
  toast.classList.remove("is-visible");
  window.setTimeout(() => toast.remove(), 300);
}

export async function fetchWithAuth(url, options = {}) {
  const user = auth.currentUser;
  if (!user) {
    if (!isLoginPage) window.location.assign(LOGIN_PATH);
    throw new Error("Authentication required.");
  }
  const token = await user.getIdToken();
  const headers = new Headers(options.headers || {});
  headers.set("Authorization", `Bearer ${token}`);
  if (options.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const response = await fetch(url, { ...options, headers });
  if (response.status === 401) {
    // Do not silently reuse an invalid session.
    await signOut(auth);
    if (!isLoginPage) window.location.assign(LOGIN_PATH);
  }
  return response;
}
window.fetchWithAuth = fetchWithAuth;
window.showNotification = showNotification;

function setInlineError(element, message) {
  if (!element) return;
  element.textContent = message || "";
  element.classList.toggle("hidden", !message);
}
function friendlyAuthError(error) {
  const code = error?.code || "";
  if (code.includes("invalid-credential") || code.includes("wrong-password") || code.includes("user-not-found")) return "Email or password is incorrect.";
  if (code.includes("too-many-requests")) return "Too many attempts. Please wait and try again.";
  if (code.includes("network-request-failed")) return "Network error. Check your connection and retry.";
  if (code.includes("invalid-email")) return "Enter a valid email address.";
  if (code.includes("operation-not-allowed")) return "Email/password sign-in is not enabled in Firebase Authentication.";
  return error?.message || "Authentication failed. Please try again.";
}

async function handleLogin(event) {
  event.preventDefault();
  const email = $("#email")?.value.trim();
  const password = $("#password")?.value || "";
  const button = $("#loginButton");
  const errorEl = $("#loginError");
  setInlineError(errorEl, "");
  if (!email || !password) return setInlineError(errorEl, "Enter your email and password.");
  button.disabled = true;
  button.dataset.originalText = button.textContent;
  button.textContent = "Signing in…";
  try {
    const remember = $("#remember")?.checked;
    await setPersistence(auth, remember ? browserLocalPersistence : browserSessionPersistence);
    await signInWithEmailAndPassword(auth, email, password);
    showNotification("Admin sign-in successful.", "success");
    window.setTimeout(() => window.location.assign(DASHBOARD_PATH), 250);
  } catch (error) {
    setInlineError(errorEl, friendlyAuthError(error));
    showNotification("Sign-in failed. Check your credentials or connection.", "error");
  } finally {
    button.disabled = false;
    button.textContent = button.dataset.originalText || "Sign in securely";
  }
}
function loadFacebookSdk() {
  return new Promise((resolve, reject) => {
    // শুধুমাত্র চেক করবে FB_APP_ID আছে কি না এবং এটি খালি কি না
    if (!window.FB_APP_ID) {
      reject(new Error("Set window.FB_APP_ID to your Meta App ID before connecting Facebook."));
      return;
    }
    if (window.FB) {
      window.FB.init({ appId: window.FB_APP_ID, cookie: true, xfbml: false, version: "v26.0" });
      resolve(window.FB);
      return;
    }
    window.fbAsyncInit = () => {
      try {
        window.FB.init({ appId: window.FB_APP_ID, cookie: true, xfbml: false, version: "v26.0" });
        resolve(window.FB);
      } catch (error) { reject(error); }
    };
    const existing = document.querySelector('script[src*="connect.facebook.net"][src*="sdk.js"]');
    if (!existing) {
      const script = document.createElement("script");
      script.src = "https://connect.facebook.net/en_US/sdk.js";
      script.async = true; script.defer = true; script.crossOrigin = "anonymous";
      script.onerror = () => reject(new Error("Facebook SDK could not be loaded."));
      document.head.appendChild(script);
    }
    window.setTimeout(() => {
      if (!window.FB) reject(new Error("Facebook SDK timed out. Check your network and Meta app domain settings."));
    }, 12000);
  });
}

async function connectFacebook() {
  const button = $("#connectFacebook") || $("#reconnectFacebook");
  const errorEl = $("#facebookError");
  setInlineError(errorEl, "");
  if (!auth.currentUser) {
    setInlineError(errorEl, "Sign in with your admin account before connecting Facebook.");
    return;
  }
  if (button) { button.disabled = true; button.dataset.originalText = button.textContent; button.textContent = "Connecting…"; }
  try {
    const FB = await loadFacebookSdk();
const result = await new Promise((resolve, reject) => {
      FB.login(response => response?.authResponse ? resolve(response) : reject(new Error("Facebook authorization was cancelled or not granted.")), {
        // pages_messaging পারমিশন এরর এড়াতে এখান থেকে বাদ রাখা হয়েছে
        scope: "pages_show_list,pages_manage_posts,pages_read_engagement",
        return_scopes: true
      });
    });
    const userToken = result.authResponse.accessToken;
    
    // Exchange happens on the backend.
    const response = await fetchWithAuth("/api/auth/fb-exchange-token", {
      method: "POST",
      body: JSON.stringify({ 
        shortLivedToken: userToken // <-- এখানে accessToken এর জায়গায় shortLivedToken দিন
      })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.success === false) throw new Error(payload.error || payload.message || "Facebook token exchange failed.");
    showNotification("Facebook authorization completed.", "success");
    if (isLoginPage) window.location.assign(DASHBOARD_PATH);
    else await loadDashboard();
  } catch (error) {
    setInlineError(errorEl, error.message || "Could not connect Facebook.");
    showNotification(error.message || "Facebook connection failed.", "error");
  } finally {
    if (button) { button.disabled = !auth.currentUser; button.textContent = button.dataset.originalText || "Connect Facebook Page"; }
    updateLoginFacebookState(auth.currentUser);
  }
}

function updateLoginFacebookState(user) {
  const button = $("#connectFacebook");
  const help = $("#facebookHelp");
  const status = $("#facebookStepStatus");
  if (!button) return;
  button.disabled = !user;
  if (user) {
    if (help) help.textContent = "Admin verified. You can now authorize your Facebook Page.";
    if (status) { status.textContent = "Unlocked"; status.className = "step-status unlocked"; }
  } else {
    if (help) help.textContent = "Sign in first to enable page connection.";
    if (status) { status.textContent = "Locked"; status.className = "step-status"; }
  }
}

function setService(id, value, detailId, detail) {
  const el = document.getElementById(id);
  if (!el) return;
  const normal = String(value ?? "unknown").toLowerCase();
  const ok = ["active", "ready", "connected", "valid", "healthy", "ok"].includes(normal);
  const bad = ["error", "failed", "disconnected", "expired", "offline"].includes(normal);
  el.className = `service-pill ${ok ? "good" : bad ? "bad" : "neutral"}`;
  el.textContent = value == null ? "Unknown" : String(value);
  const detailEl = detailId && document.getElementById(detailId);
  if (detailEl && detail) detailEl.textContent = detail;
}
function assignText(id, value, fallback = "—") {
  const element = document.getElementById(id);
  if (element) element.textContent = value == null || value === "" ? fallback : String(value);
}
async function loadDashboard() {
  try {
    const response = await fetchWithAuth("/api/dashboard/summary", { method: "GET" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || data.message || "Dashboard summary request failed.");
    const root = data.data || data;
    const stats = root.stats || root;
    const page = root.page || root.facebookPage || {};
    const system = root.system || root.services || {};
    const used = Number(stats.dailyUsed ?? stats.publishedToday ?? 0);
    const cap = Number(stats.dailyCap ?? stats.dailyLimit ?? 5);
    assignText("dailyUsed", used); assignText("dailyCap", cap);
    assignText("dailyNote", cap > 0 && used >= cap ? "Daily publishing cap reached." : `${Math.max(0, cap - used)} posts remaining today.`);
    assignText("dailyPercent", `${cap > 0 ? Math.min(100, Math.round(used / cap * 100)) : 0}%`);
    const bar = document.getElementById("dailyProgressBar");
    if (bar) bar.style.width = `${cap > 0 ? Math.min(100, used / cap * 100) : 0}%`;
    assignText("queueMetric", stats.firebaseQueue ?? stats.queueCount);
    assignText("messageMetric", stats.flaggedMessages ?? stats.flaggedMessageCount);
    assignText("commentMetric", stats.toxicComments ?? stats.flaggedComments);
    assignText("publishedMetric", stats.publishedToday ?? stats.dailyPublished);
    assignText("pageName", page.name || root.pageName, "No page connected");
    const token = String(page.tokenStatus || root.tokenStatus || "unknown");
    const tokenEl = document.getElementById("pageTokenStatus");
    if (tokenEl) {
      tokenEl.textContent = token === "valid" ? "Token valid" : token === "expired" ? "Token expired" : token === "missing" ? "Reconnect required" : "Status unknown";
      tokenEl.className = `token-pill ${token === "valid" ? "token-valid" : token === "expired" || token === "missing" ? "token-invalid" : "token-unknown"}`;
    }
    setService("cronStatus", system.cron || system.scheduler || root.cronStatus || "unknown", "cronDetail", system.cronDetail || "Status reported by backend");
    setService("geminiStatus", system.gemini || system.ai || root.geminiStatus || "unknown", "geminiDetail", system.geminiDetail || "Status reported by backend");
    setService("facebookApiStatus", page.connected ? "connected" : page.connected === false ? "disconnected" : "unknown", "facebookDetail", page.name || "Page connection status reported by backend");
    const authStatus = document.getElementById("dashboardAuthStatus");
    if (authStatus) { authStatus.className = "connection-pill connected"; authStatus.innerHTML = "<i></i> Signed in"; }
  } catch (error) {
    showNotification(error.message || "Unable to load dashboard data.", "error");
    assignText("pageName", "Could not load status");
    setService("cronStatus", "unknown", "cronDetail", "Dashboard API unavailable");
    setService("geminiStatus", "unknown", "geminiDetail", "Dashboard API unavailable");
    setService("facebookApiStatus", "unknown", "facebookDetail", "Dashboard API unavailable");
  }
}

function setupPage() {
  $("#loginForm")?.addEventListener("submit", handleLogin);
  $("#togglePassword")?.addEventListener("click", () => {
    const input = $("#password"), button = $("#togglePassword");
    const show = input.type === "password";
    input.type = show ? "text" : "password";
    button.textContent = show ? "Hide" : "Show";
    button.setAttribute("aria-label", show ? "Hide password" : "Show password");
  });
  $("#connectFacebook")?.addEventListener("click", connectFacebook);
  $("#reconnectFacebook")?.addEventListener("click", connectFacebook);
  $("#logoutButton")?.addEventListener("click", async () => {
    const button = $("#logoutButton"); button.disabled = true;
    try {
      await signOut(auth);
      showNotification("You have signed out.", "success");
      window.location.assign(LOGIN_PATH);
    } catch (error) {
      showNotification(error.message || "Sign out failed.", "error");
      button.disabled = false;
    }
  });
  $("#refreshDashboard")?.addEventListener("click", loadDashboard);
}

let authResolved = false;
onAuthStateChanged(auth, user => {
  authResolved = true;
  updateLoginFacebookState(user);
  if (isLoginPage && user) {
    window.location.replace(DASHBOARD_PATH);
    return;
  }
  if (!isLoginPage && !user) {
    window.location.replace(LOGIN_PATH);
    return;
  }
  if (!isLoginPage && user && document.getElementById("pageName")) loadDashboard();
});
setupPage();
