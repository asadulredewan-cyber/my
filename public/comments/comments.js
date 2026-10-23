/*
 * Comments moderation frontend. Firebase Auth must be exposed as window.auth
 * or window.firebaseAuth by the shared authentication bootstrap.
 * Destructive actions use an in-page dialog; comment text is rendered via
 * textContent, not interpolated into HTML.
 */
const API = {
  list: "/api/comments/get-comments",
  action: "/api/comments/comment-action"
};
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const state = { filter: "all", comments: [], pendingAction: null, busyIds: new Set() };

function toast(message, type = "success", duration = 3600) {
  const region = $("#toastRegion");
  if (!region) {
    console[type === "error" ? "error" : "log"](message);
    return;
  }
  const item = document.createElement("div");
  item.className = `toast ${type}`;
  const icon = document.createElement("span"); 
  icon.className = "toast-icon"; 
  icon.textContent = type === "error" ? "!" : "✓";
  const text = document.createElement("p"); 
  text.textContent = message;
  const close = document.createElement("button"); 
  close.type = "button"; 
  close.setAttribute("aria-label", "Dismiss"); 
  close.textContent = "×";
  close.addEventListener("click", () => removeToast(item));
  item.append(icon, text, close); 
  region.append(item);
  requestAnimationFrame(() => item.classList.add("visible"));
  setTimeout(() => removeToast(item), duration);
}

function removeToast(item) { 
  if (!item || item.dataset.removing) return; 
  item.dataset.removing = "1"; 
  item.classList.remove("visible"); 
  setTimeout(() => item.remove(), 300); 
}

function authInstance() { 
  return window.auth || window.firebaseAuth || null; 
}

async function request(url, options = {}) {
  const user = authInstance()?.currentUser;
  if (!user) throw new Error("You are not signed in. Please sign in and try again.");
  const token = await user.getIdToken();
  const response = await fetch(url, { 
    ...options, 
    headers: { 
      Authorization: `Bearer ${token}`, 
      "Content-Type": "application/json", 
      ...(options.headers || {}) 
    } 
  });
  const contentType = response.headers.get("content-type") || "";
  const data = contentType.includes("application/json") ? await response.json() : { message: await response.text() };
  if (!response.ok || data?.success === false) throw new Error(data?.error || data?.message || `Request failed (${response.status})`);
  return data;
}

function arr(...values) { return values.find(Array.isArray) || []; }

function normaliseComment(raw = {}) {
  const user = raw.user || raw.from || raw.author || {};
  const post = raw.post || raw.postContext || {};
  const replies = arr(raw.replies, raw.thread, raw.responses, raw.comments?.data);
  const flags = Array.isArray(raw.flags) ? raw.flags.map(x => String(x).toLowerCase()) : [];
  const status = String(raw.status || "").toLowerCase();
  const toxic = Boolean(raw.toxic || raw.flagged || raw.isToxic || raw.moderation?.toxic || flags.some(x => /toxic|abusive|bad|flag/.test(x)));
  const hidden = Boolean(raw.hidden || raw.isHidden || raw.is_hidden || raw.hiddenByAI || status === "hidden" || raw.moderation?.hidden);
  const needsAttention = Boolean(raw.needsAttention || raw.reviewRequired || raw.moderation?.reviewRequired || (toxic && !raw.reviewed));
  
  return {
    ...raw,
    id: String(raw.id || raw.commentId || ""),
    userName: String(raw.userName || raw.authorName || user.name || user.username || "Facebook user"),
    userId: String(raw.userId || user.id || raw.fromId || ""),
    message: String(raw.message || raw.text || raw.comment || ""),
    createdAt: raw.createdAt || raw.created_time || raw.timestamp || raw.time || "",
    postId: String(raw.postId || post.id || raw.parentPostId || ""),
    postSnippet: String(raw.postSnippet || post.message || post.caption || raw.postText || raw.postMessage || ""),
    toxic, 
    hidden, 
    needsAttention, 
    flags,
    replies
  };
}

function formatTime(value) {
  if (!value) return "Time unavailable";
  const d = value?.toDate ? value.toDate() : value?.seconds ? new Date(value.seconds * 1000) : new Date(value);
  return Number.isFinite(d.getTime()) ? new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }).format(d) : String(value);
}

function initials(name) { 
  return String(name || "?").trim().split(/\s+/).slice(0, 2).map(s => s[0] || "").join("").toUpperCase() || "?"; 
}

function badge(text, cls) { 
  const el = document.createElement("span"); 
  el.className = `status-badge ${cls}`; 
  el.textContent = text; 
  return el; 
}

function extractComments(payload) {
  const root = payload.data || payload;
  return arr(root.comments, root.items, root.results).map(normaliseComment).filter(c => c.id);
}

function filteredComments() {
  const query = $("#commentSearch").value.trim().toLowerCase();
  return state.comments.filter(c => {
    if (state.filter === "toxic" && !c.toxic) return false;
    if (state.filter === "hidden" && !c.hidden) return false;
    if (state.filter === "attention" && !c.needsAttention) return false;
    return !query || `${c.userName} ${c.message} ${c.postSnippet} ${c.postId}`.toLowerCase().includes(query);
  });
}

function updateSummary(payload = {}) {
  const root = payload.data || payload;
  $("#allCount").textContent = payload.totalCount ?? root.totalCount ?? payload.stats?.total ?? state.comments.length;
  $("#flaggedCount").textContent = payload.flaggedCount ?? root.flaggedCount ?? payload.stats?.flagged ?? state.comments.filter(c => c.toxic).length;
  $("#hiddenCount").textContent = payload.hiddenCount ?? root.hiddenCount ?? payload.stats?.hidden ?? state.comments.filter(c => c.hidden).length;
  $("#attentionCount").textContent = payload.attentionCount ?? root.attentionCount ?? payload.stats?.needsAttention ?? state.comments.filter(c => c.needsAttention).length;
}

async function loadComments({ quiet = false } = {}) {
  try {
    const serverStatus = state.filter === "hidden" || state.filter === "attention" ? "all" : state.filter;
    const payload = await request(`${API.list}?status=${encodeURIComponent(serverStatus)}`, { method: "GET" });
    state.comments = extractComments(payload);
    updateSummary(payload); 
    renderComments();
    const status = $("#connectionStatus"); 
    status.className = "connection-pill connected"; 
    status.innerHTML = "<i></i> Connected";
  } catch (error) {
    const status = $("#connectionStatus"); 
    status.className = "connection-pill disconnected"; 
    status.innerHTML = "<i></i> Connection error";
    if (!quiet) toast(error.message || "Could not load comments.", "error");
    if (!state.comments.length) {
      $("#emptyState").classList.remove("hidden");
      $("#emptyState").querySelector("strong").textContent = "Could not load comments";
      $("#emptyState").querySelector("p").textContent = error.message || "Check your connection and try again.";
    }
  }
}

function renderComments() {
  const grid = $("#commentsGrid"); 
  grid.replaceChildren();
  const comments = filteredComments();
  $("#resultCount").textContent = `${comments.length} comment${comments.length === 1 ? "" : "s"}`;
  $("#emptyState").classList.toggle("hidden", comments.length > 0);
  for (const comment of comments) grid.append(createCommentCard(comment));
}

function createCommentCard(c) {
  const card = document.createElement("article");
  card.className = `comment-card${c.toxic ? " is-toxic" : c.flags.includes("unknown_language") ? " is-unknown" : ""}`;
  card.dataset.commentId = c.id;
  const top = document.createElement("div"); top.className = "comment-top";
  const avatar = document.createElement("span"); avatar.className = "user-avatar"; avatar.textContent = initials(c.userName);
  const user = document.createElement("div"); user.className = "comment-user";
  const name = document.createElement("div"); name.className = "user-name"; name.textContent = c.userName;
  const time = document.createElement("div"); time.className = "comment-time"; time.textContent = formatTime(c.createdAt);
  user.append(name, time);
  const badges = document.createElement("div"); badges.className = "comment-badges";
  if (c.toxic) badges.append(badge("Flagged / toxic", "status-toxic"));
  if (c.hidden) badges.append(badge("Hidden", "status-hidden"));
  if (c.needsAttention) badges.append(badge("Needs review", "status-attention"));
  if (!c.toxic && !c.hidden && !c.needsAttention) badges.append(badge("Normal", "status-ok"));
  top.append(avatar, user, badges);

  const body = document.createElement("p"); body.className = "comment-body"; body.textContent = c.message;
  if (c.toxic) {
    body.classList.add("is-masked"); body.tabIndex = 0; body.setAttribute("aria-label", "Flagged comment text. Focus or hover to reveal.");
  }
  const postCard = document.createElement("div"); postCard.className = "post-context";
  const contextLabel = document.createElement("div"); contextLabel.className = "post-context-label"; contextLabel.textContent = "Related post";
  const snippet = document.createElement("div"); snippet.className = "post-snippet"; snippet.textContent = c.postSnippet || "No post snippet provided.";
  const postId = document.createElement("div"); postId.className = "post-id"; postId.textContent = c.postId ? `Post ID: ${c.postId}` : "Post ID unavailable";
  postCard.append(contextLabel, snippet, postId);

  const wrap = document.createElement("div");
  if (c.toxic) { const note = document.createElement("p"); note.className = "mask-note"; note.textContent = "Flagged text is blurred for review. Hover or focus to reveal."; wrap.append(note); }
  wrap.append(body);
  const thread = document.createElement("div"); thread.className = "reply-thread";
  c.replies.slice(0, 3).forEach(reply => {
    const line = document.createElement("div"); line.className = "thread-reply";
    const strong = document.createElement("strong"); strong.textContent = `${reply.authorName || reply.from?.name || "Reply"}: `;
    const content = document.createElement("span"); content.textContent = String(reply.message || reply.text || "");
    line.append(strong, content); thread.append(line);
  });

  const replyBox = document.createElement("form"); replyBox.className = "inline-reply hidden";
  const textarea = document.createElement("textarea"); textarea.maxLength = 2000; textarea.required = true; textarea.placeholder = "Write a public reply…"; textarea.setAttribute("aria-label", "Reply to comment");
  const replyActions = document.createElement("div"); replyActions.className = "reply-form-actions";
  const cancel = document.createElement("button"); cancel.type = "button"; cancel.className = "button button-quiet"; cancel.textContent = "Cancel";
  const send = document.createElement("button"); send.type = "submit"; send.className = "button button-primary"; send.textContent = "Send reply";
  cancel.addEventListener("click", () => replyBox.classList.add("hidden"));
  replyBox.addEventListener("submit", event => { event.preventDefault(); submitReply(c, textarea.value, send, card); });
  replyActions.append(cancel, send); replyBox.append(textarea, replyActions);

  const actions = document.createElement("div"); actions.className = "comment-actions";
  const replyButton = document.createElement("button"); replyButton.type = "button"; replyButton.className = "button button-primary"; replyButton.textContent = "↩ Reply";
  replyButton.addEventListener("click", () => { replyBox.classList.toggle("hidden"); if (!replyBox.classList.contains("hidden")) textarea.focus(); });
  const hideButton = document.createElement("button"); hideButton.type = "button"; hideButton.className = "button button-warning"; hideButton.textContent = c.hidden ? "Unhide" : "Hide";
  hideButton.addEventListener("click", () => performModeration(c, c.hidden ? "unhide" : "hide", card));
  const deleteButton = document.createElement("button"); deleteButton.type = "button"; deleteButton.className = "button button-quiet"; deleteButton.textContent = "Delete";
  deleteButton.addEventListener("click", () => openConfirmation({ title: "Delete this comment?", message: "This action cannot usually be undone. The comment will be removed from the page if Facebook accepts the request.", confirmText: "Delete comment", danger: true, action: () => performModeration(c, "delete", card, true) }));
  actions.append(replyButton, hideButton, deleteButton);
  card.append(top, wrap, postCard, thread, replyBox, actions);
  return card;
}

function openConfirmation(options) {
  state.pendingAction = options;
  $("#confirmTitle").textContent = options.title;
  $("#confirmMessage").textContent = options.message;
  $("#acceptConfirm").textContent = options.confirmText || "Confirm";
  $("#acceptConfirm").className = `button ${options.danger ? "button-danger" : "button-primary"}`;
  $("#confirmIcon").textContent = options.danger ? "!" : "?";
  const dialog = $("#confirmDialog");
  if (typeof dialog.showModal === "function") dialog.showModal();
  else if (window.confirm(options.message)) options.action();
}

function closeConfirmation() { 
  const dialog = $("#confirmDialog"); 
  if (dialog.open) dialog.close(); 
  state.pendingAction = null; 
}

async function performModeration(comment, action, card, removeAfter = false) {
  if (state.busyIds.has(comment.id)) return;
  const previousOpacity = card.style.opacity;
  card.classList.add("is-pending");
  state.busyIds.add(comment.id);
  try {
    const payload = { commentId: comment.id, action };
    await request(API.action, { method: "POST", body: JSON.stringify(payload) });
    if (action === "delete" || action === "block") {
      state.comments = state.comments.filter(item => item.id !== comment.id);
      card.remove();
      toast(action === "delete" ? "Comment deleted." : "Block request completed.", "success");
    } else {
      comment.hidden = action === "hide";
      comment.status = action === "hide" ? "hidden" : "visible";
      toast(action === "hide" ? "Comment hidden." : "Comment unhidden.", "success");
      renderComments();
    }
    updateSummary(); 
    $("#resultCount").textContent = `${filteredComments().length} comments`;
    $("#emptyState").classList.toggle("hidden", filteredComments().length > 0);
  } catch (error) {
    card.classList.remove("is-pending"); 
    card.style.opacity = previousOpacity;
    toast(error.message || `Could not ${action} comment.`, "error");
  } finally { 
    state.busyIds.delete(comment.id); 
  }
}

async function submitReply(comment, message, button, card) {
  const text = message.trim();
  if (!text) return;
  if (state.busyIds.has(comment.id)) return;
  state.busyIds.add(comment.id); 
  button.disabled = true; 
  button.textContent = "Sending…";
  try {
    await request(API.action, { method: "POST", body: JSON.stringify({ action: "reply", commentId: comment.id, message: text }) });
    comment.replies.push({ authorName: "Page", message: text });
    toast("Reply sent successfully.", "success");
    renderComments();
  } catch (error) {
    toast(error.message || "Reply could not be sent.", "error");
  } finally { 
    state.busyIds.delete(comment.id); 
    button.disabled = false; 
    button.textContent = "Send reply"; 
  }
}

function bind() {
  $$(".filter-tab").forEach(button => button.addEventListener("click", () => {
    state.filter = button.dataset.filter;
    $$(".filter-tab").forEach(tab => { 
      const active = tab === button; 
      tab.classList.toggle("active", active); 
      tab.setAttribute("aria-selected", String(active)); 
    });
    renderComments();
  }));
  $("#commentSearch").addEventListener("input", renderComments);
  $("#refreshComments").addEventListener("click", () => loadComments({ quiet: false }));
  $("#cancelConfirm").addEventListener("click", closeConfirmation);
  $("#confirmForm").addEventListener("submit", async event => {
    event.preventDefault();
    const action = state.pendingAction;
    closeConfirmation();
    if (action?.action) await action.action();
  });
}

function init() {
  bind();

  // script.js এর মাধ্যমে Firebase Auth লোড হওয়া পর্যন্ত অপেক্ষা করার মেকানিজম
  let attempts = 0;
  const waitForAuth = () => {
    const auth = authInstance();
    if (auth?.currentUser) {
      loadComments({ quiet: false });
      return;
    }

    if (typeof window.onFirebaseAuthReady === "function") {
      window.onFirebaseAuthReady(user => {
        if (user) loadComments({ quiet: false });
        else window.location.href = "../login.html";
      });
      return;
    }

    if (++attempts < 25) {
      setTimeout(waitForAuth, 200);
    } else {
      const status = $("#connectionStatus"); 
      status.className = "connection-pill disconnected"; 
      status.innerHTML = "<i></i> Connection error";
      $("#emptyState").classList.remove("hidden");
      $("#emptyState").querySelector("strong").textContent = "Could not load comments";
      $("#emptyState").querySelector("p").textContent = "You are not signed in. Please sign in and try again.";
    }
  };

  waitForAuth();
}

init();
