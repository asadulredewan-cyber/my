/*
 * Messages frontend. Shared public/script.js should expose Firebase Auth as
 * window.auth or window.firebaseAuth. Optional API response fields are handled
 * defensively; adjust normaliseConversation() if your backend uses other keys.
 */
const API = {
  list: "/api/messages/get-messages",
  reply: "/api/messages/send-reply",
  translate: "/api/messages/translate"
};
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const state = { filter: "all", conversations: [], activeId: null, active: null, busy: false };

function toast(message, type = "success", duration = 3800) {
  const region = $("#toastRegion"), item = document.createElement("div");
  item.className = `toast ${type}`;
  const icon = document.createElement("span"); icon.className = "toast-icon"; icon.textContent = type === "error" ? "!" : "✓";
  const text = document.createElement("p"); text.textContent = message;
  const close = document.createElement("button"); close.type = "button"; close.setAttribute("aria-label", "Dismiss"); close.textContent = "×";
  close.addEventListener("click", () => removeToast(item));
  item.append(icon, text, close); region.append(item);
  requestAnimationFrame(() => item.classList.add("visible"));
  setTimeout(() => removeToast(item), duration);
}
function removeToast(item) { if (!item || item.dataset.removing) return; item.dataset.removing = "1"; item.classList.remove("visible"); setTimeout(() => item.remove(), 300); }
function authInstance() { return window.auth || window.firebaseAuth || null; }
async function request(url, options = {}) {
  const user = authInstance()?.currentUser;
  if (!user) throw new Error("You are not signed in. Please sign in and try again.");
  const token = await user.getIdToken();
  const response = await fetch(url, { ...options, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(options.headers || {}) } });
  const type = response.headers.get("content-type") || "";
  const data = type.includes("application/json") ? await response.json() : { message: await response.text() };
  if (!response.ok || data?.success === false) throw new Error(data?.error || data?.message || `Request failed (${response.status})`);
  return data;
}
function arr(...values) { return values.find(Array.isArray) || []; }
function normaliseConversation(item = {}) {
  const id = item.id || item.conversationId || item.threadId || item.senderId || item.recipientId || "";
  const messages = arr(item.messages, item.history, item.messageHistory);
  const last = item.lastMessage || item.last_message || messages[messages.length - 1] || {};
  return {
    ...item, id: String(id), name: item.name || item.senderName || item.participantName || item.from?.name || "Facebook user",
    senderId: String(item.senderId || item.participantId || item.from?.id || item.recipientId || id),
    preview: String(item.preview || item.lastMessageText || last.text || last.message || ""),
    timestamp: item.updatedAt || item.lastMessageAt || item.timestamp || last.timestamp || last.createdAt || "",
    unread: Boolean(item.unread || item.isUnread || Number(item.unreadCount) > 0),
    flagged: Boolean(item.flagged || item.isFlagged || item.reviewRequired || item.flags?.length),
    unknownLanguage: Boolean(item.unknownLanguage || item.languageUnknown || item.flags?.includes?.("unknown_language")),
    abusive: Boolean(item.abusive || item.toxic || item.reviewRequired || item.flags?.includes?.("abusive")),
    messages
  };
}
function formatTime(value) {
  if (!value) return "";
  let date = value?.toDate ? value.toDate() : value?.seconds ? new Date(value.seconds * 1000) : new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  const now = new Date();
  return date.toDateString() === now.toDateString()
    ? new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(date)
    : new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date);
}
function initials(name) { return String(name || "?").trim().split(/\s+/).slice(0, 2).map(s => s[0] || "").join("").toUpperCase() || "?"; }
function badge(text, kind) { const span = document.createElement("span"); span.className = `mini-badge ${kind}`; span.textContent = text; return span; }
function visibleConversations() {
  const query = $("#conversationSearch").value.trim().toLowerCase();
  return state.conversations.filter(c => {
    if (state.filter === "flagged" && !c.flagged) return false;
    if (state.filter === "unread" && !c.unread) return false;
    return !query || `${c.name} ${c.preview}`.toLowerCase().includes(query);
  });
}
function renderConversationList() {
  const list = $("#conversationList"); list.replaceChildren();
  const items = visibleConversations();
  $("#conversationEmpty").classList.toggle("hidden", items.length > 0);
  $("#conversationCount").textContent = `${items.length} conversation${items.length === 1 ? "" : "s"}`;
  for (const c of items) {
    const button = document.createElement("button"); button.type = "button";
    button.className = `conversation-item${c.id === state.activeId ? " active" : ""}`;
    const avatar = document.createElement("span"); avatar.className = "avatar"; avatar.textContent = initials(c.name);
    const content = document.createElement("span"); content.className = "conversation-content";
    const line = document.createElement("span"); line.className = "conversation-line";
    const name = document.createElement("span"); name.className = "conversation-name"; name.textContent = c.name;
    const time = document.createElement("span"); time.className = "conversation-time"; time.textContent = formatTime(c.timestamp);
    line.append(name, time);
    const preview = document.createElement("span"); preview.className = "conversation-preview"; preview.textContent = c.preview || "No message preview";
    const badges = document.createElement("span"); badges.className = "conversation-badges";
    if (c.unknownLanguage) badges.append(badge("Unknown language", "badge-unknown"));
    if (c.abusive) badges.append(badge("Review required", "badge-abusive"));
    if (c.unread) { const unread = document.createElement("span"); unread.className = "badge-unread"; unread.title = "Unread"; badges.append(unread); }
    content.append(line, preview, badges); button.append(avatar, content);
    button.addEventListener("click", () => selectConversation(c.id)); list.append(button);
  }
}
function updateCounts() {
  $("#allCount").textContent = state.conversations.length;
  $("#flaggedCount").textContent = state.conversations.filter(c => c.flagged).length;
  $("#unreadCount").textContent = state.conversations.filter(c => c.unread).length;
}
function extractConversations(payload) {
  const root = payload.data || payload;
  return arr(root.conversations, root.threads, root.messages, root.items).map(normaliseConversation).filter(c => c.id);
}
async function loadMessages({ quiet = true } = {}) {
  try {
    const payload = await request(`${API.list}?filter=${encodeURIComponent(state.filter === "unread" ? "all" : state.filter)}`, { method: "GET" });
    const previousId = state.activeId;
    state.conversations = extractConversations(payload);
    updateCounts(); renderConversationList();
    const status = $("#connectionStatus"); status.className = "connection-pill connected"; status.innerHTML = "<i></i> Connected";
    if (previousId && state.conversations.some(c => c.id === previousId)) {
      const updated = state.conversations.find(c => c.id === previousId);
      state.active = updated; renderActiveChat();
    } else if (state.activeId && !state.conversations.some(c => c.id === state.activeId)) {
      state.activeId = null; state.active = null; showPlaceholder();
    }
  } catch (error) {
    const status = $("#connectionStatus"); status.className = "connection-pill disconnected"; status.innerHTML = "<i></i> Connection error";
    if (!quiet) toast(error.message || "Unable to load messages.", "error");
    if (!state.conversations.length) {
      $("#conversationEmpty").classList.remove("hidden");
      $("#conversationEmpty").querySelector("strong").textContent = "Could not load inbox";
      $("#conversationEmpty").querySelector("p").textContent = error.message || "Check your connection and try again.";
    }
  }
}
function selectConversation(id) {
  const conversation = state.conversations.find(c => c.id === id);
  if (!conversation) return;
  state.activeId = id; state.active = conversation;
  renderConversationList(); renderActiveChat();
}
function showPlaceholder() { $("#activeChat").classList.add("hidden"); $("#chatPlaceholder").classList.remove("hidden"); }
function safeDate(value) {
  if (!value) return "";
  const d = value?.toDate ? value.toDate() : value?.seconds ? new Date(value.seconds * 1000) : new Date(value);
  return Number.isFinite(d.getTime()) ? new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit", month: "short", day: "numeric" }).format(d) : "";
}
function renderActiveChat() {
  const c = state.active;
  if (!c) return showPlaceholder();
  $("#chatPlaceholder").classList.add("hidden"); $("#activeChat").classList.remove("hidden");
  $("#activeAvatar").textContent = initials(c.name); $("#activeName").textContent = c.name;
  $("#activeMeta").textContent = `Facebook Messenger${c.senderId ? ` · ${c.senderId}` : ""}`;
  const flags = $("#activeFlags"); flags.replaceChildren();
  if (c.unknownLanguage) flags.append(badge("Unknown language", "badge-unknown"));
  if (c.abusive) flags.append(badge("Review required", "badge-abusive"));
  const notice = $("#flagNotice");
  if (c.flagged) {
    notice.classList.remove("hidden", "is-abusive");
    notice.textContent = c.abusive ? "This conversation may contain abusive content. Review carefully before replying." : "This conversation was flagged for language review.";
    if (c.abusive) notice.classList.add("is-abusive");
  } else notice.classList.add("hidden");

  const viewport = $("#messageViewport"); viewport.replaceChildren();
  const messages = c.messages.length ? c.messages : (c.lastMessage ? [c.lastMessage] : []);
  if (!messages.length) {
    const empty = document.createElement("p"); empty.className = "empty-state"; empty.textContent = "No message history was returned for this conversation."; viewport.append(empty);
  }
  for (const msg of messages) {
    const outgoing = Boolean(msg.isOutgoing || msg.outgoing || msg.fromPage || msg.direction === "outgoing" || msg.sender === "page" || msg.from?.id === c.pageId);
    const row = document.createElement("div"); row.className = `message-row${outgoing ? " outgoing" : ""}`;
    const bubble = document.createElement("div"); bubble.className = "message-bubble";
    bubble.textContent = String(msg.text || msg.message || msg.messageText || msg.content || "");
    row.append(bubble);
    const time = document.createElement("time"); time.className = "message-time"; time.textContent = safeDate(msg.createdAt || msg.timestamp || msg.time);
    if (time.textContent) row.append(time);
    if (!outgoing && c.flagged) {
      const translate = document.createElement("button"); translate.type = "button"; translate.className = "translate-button"; translate.textContent = "Translate text";
      translate.addEventListener("click", () => translateMessage(String(msg.text || msg.message || msg.messageText || ""), row, translate));
      row.append(translate);
    }
    viewport.append(row);
  }
  const suggestions = arr(c.suggestedReplies, c.suggestions, c.geminiSuggestions);
  const suggestionBox = $("#suggestedReplies"); suggestionBox.replaceChildren();
  const defaults = suggestions.length ? suggestions : ["Thank you for reaching out! How can we help?", "Thanks for your message. We’ll get back to you shortly."];
  defaults.slice(0, 5).forEach(value => {
    const text = typeof value === "string" ? value : value.text || value.message || "";
    if (!text) return;
    const chip = document.createElement("button"); chip.type = "button"; chip.className = "suggestion-chip"; chip.textContent = text;
    chip.addEventListener("click", () => { $("#replyInput").value = text; updateReplyLength(); $("#replyInput").focus(); });
    suggestionBox.append(chip);
  });
  $("#replyInput").value = ""; updateReplyLength();
  requestAnimationFrame(() => { viewport.scrollTop = viewport.scrollHeight; });
}
async function translateMessage(message, row, button) {
  if (!message.trim()) return;
  button.disabled = true; button.textContent = "Translating…";
  try {
    const payload = await request(API.translate, { method: "POST", body: JSON.stringify({ text: message, recipientId: state.active?.senderId, targetLanguage: "English" }) });
    const translation = payload.translation || payload.translatedText || payload.data?.translation;
    if (!translation) throw new Error("Translation endpoint returned no translation.");
    let result = row.querySelector(".message-translation");
    if (!result) { result = document.createElement("div"); result.className = "message-translation"; row.append(result); }
    result.textContent = translation;
    button.textContent = "Translated";
  } catch (error) {
    button.disabled = false; button.textContent = "Translate text";
    toast(error.message || "Translation failed.", "error");
  }
}
function updateReplyLength() { $("#replyLength").textContent = `${$("#replyInput").value.length} / 2000`; }
async function sendReply() {
  if (state.busy) return;
  const messageText = $("#replyInput").value.trim(), conversation = state.active;
  if (!conversation) return;
  if (!messageText) { $("#replyInput").focus(); return; }
  const recipientId = conversation.senderId;
  if (!recipientId) return toast("This conversation has no recipient ID.", "error");
  state.busy = true; const button = $("#sendReply"); button.disabled = true; button.innerHTML = "<span>…</span> Sending";
  try {
    await request(API.reply, { method: "POST", body: JSON.stringify({ recipientId, messageText }) });
    // Optimistically append the sent message so the chat feels immediate.
    conversation.messages.push({ text: messageText, direction: "outgoing", isOutgoing: true, createdAt: new Date().toISOString() });
    conversation.preview = messageText; conversation.timestamp = new Date().toISOString();
    $("#replyInput").value = ""; updateReplyLength(); renderActiveChat(); renderConversationList();
    toast("Reply sent successfully.", "success");
  } catch (error) {
    toast(error.message || "Message could not be sent.", "error");
  } finally { state.busy = false; button.disabled = false; button.innerHTML = "<span>➤</span> Send"; }
}
function bind() {
  $$(".filter-tab").forEach(button => button.addEventListener("click", () => {
    state.filter = button.dataset.filter;
    $$(".filter-tab").forEach(tab => { const active = tab === button; tab.classList.toggle("active", active); tab.setAttribute("aria-selected", String(active)); });
    renderConversationList();
    if (state.filter !== "unread") loadMessages();
  }));
  $("#conversationSearch").addEventListener("input", renderConversationList);
  $("#refreshMessages").addEventListener("click", () => loadMessages({ quiet: false }));
  $("#sendReply").addEventListener("click", sendReply);
  $("#replyInput").addEventListener("input", updateReplyLength);
  $("#replyInput").addEventListener("keydown", event => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); sendReply(); } });
}
function init() {
  bind();
  if (!authInstance()) {
    toast("Firebase Auth not found. Expose it as window.auth in public/script.js.", "error", 7000);
    $("#conversationEmpty").classList.remove("hidden");
    $("#conversationEmpty").querySelector("strong").textContent = "Authentication is not configured";
    return;
  }
  loadMessages({ quiet: false });
}
init();
