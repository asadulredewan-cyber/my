/*
 * Posts Management frontend
 * Auth integration: the shared public/script.js must expose the signed-in
 * Firebase Auth instance as window.auth (or window.firebaseAuth).
 * Never put Facebook Page tokens or Gemini API keys in this file.
 */

const API = {
  posts: "/api/posts/get-posts",
  schedule: "/api/posts/manual-schedule",
  image: "/api/posts/generate-image",
  caption: "/api/posts/manual-schedule"
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const state = {
  tab: "facebook",
  mode: "single",
  data: { facebookScheduled: [], firebaseQueue: [], published: [] },
  generatedImageUrl: "",
  busy: false
};

function toast(message, type = "info", duration = 4200) {
  const region = $("#toastRegion");
  if (!region) return;
  const item = document.createElement("div");
  item.className = `toast toast-${type}`;
  const icon = type === "success" ? "✓" : type === "error" ? "!" : "✦";
  const symbol = document.createElement("span");
  symbol.className = "toast-symbol";
  symbol.textContent = icon;
  const text = document.createElement("p");
  text.textContent = message;
  const close = document.createElement("button");
  close.type = "button";
  close.className = "toast-close";
  close.setAttribute("aria-label", "Dismiss notification");
  close.textContent = "×";
  close.addEventListener("click", () => dismissToast(item));
  item.append(symbol, text, close);
  region.append(item);
  requestAnimationFrame(() => item.classList.add("is-visible"));
  window.setTimeout(() => dismissToast(item), duration);
}

function dismissToast(item) {
  if (!item || item.dataset.dismissed) return;
  item.dataset.dismissed = "true";
  item.classList.remove("is-visible");
  window.setTimeout(() => item.remove(), 300);
}

function getAuth() {
  return window.auth || window.firebaseAuth || null;
}

async function authHeaders() {
  const auth = getAuth();
  const user = auth?.currentUser;
  if (!user) {
    throw new Error("You are not signed in. Please sign in again.");
  }
  const token = await user.getIdToken();
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json"
  };
}

async function apiRequest(url, options = {}) {
  const headers = await authHeaders();
  const response = await fetch(url, {
    ...options,
    headers: { ...headers, ...(options.headers || {}) }
  });
  let payload;
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    payload = await response.json();
  } else {
    const text = await response.text();
    payload = text ? { message: text } : {};
  }
  if (!response.ok || payload?.success === false) {
    throw new Error(payload?.error || payload?.message || `Request failed (${response.status})`);
  }
  return payload;
}

function setBusy(button, busy, busyText = "Working…") {
  if (!button) return;
  if (busy) {
    button.dataset.originalText = button.textContent;
    button.textContent = busyText;
    button.disabled = true;
    button.classList.add("is-loading");
  } else {
    button.textContent = button.dataset.originalText || button.textContent;
    button.disabled = false;
    button.classList.remove("is-loading");
  }
}

function toDateInputValue(date) {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 16);
}

function setDefaultScheduleTime(input) {
  if (!input) return;
  const date = new Date(Date.now() + 30 * 60 * 1000);
  date.setSeconds(0, 0);
  input.min = toDateInputValue(new Date(Date.now() + 20 * 60 * 1000));
  if (!input.value) input.value = toDateInputValue(date);
}

function validateSchedule(value) {
  if (!value) return "Please choose a schedule date and time.";
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return "The schedule date/time is invalid.";
  if (timestamp < Date.now() + 20 * 60 * 1000) {
    return "Schedule time must be at least 20 minutes in the future.";
  }
  return "";
}

function escapeHtml(value = "") {
  return String(value).replace(/[&<>"']/g, char => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[char]);
}

function normalisePost(post = {}) {
  const isFbLive = Boolean(post.created_time || post.permalink_url);
  const derivedStatus = isFbLive ? "published" : (post.status || post.state || "queued");

  return {
    id: post.id || post.postId || "",
    caption: post.caption || post.message || post.text || "(No caption)",
    status: derivedStatus,
    scheduledAt: post.scheduledAt || post.scheduled_time || post.scheduled_publish_time || post.created_time || post.createdAt || "",
    imageUrl: post.imageUrl || post.full_picture || post.image || "",
    source: post.source || (isFbLive ? "facebook" : "")
  };
}

function formatDate(value) {
  if (!value) return "Time not provided";
  let date;
  if (typeof value === "object" && typeof value.toDate === "function") date = value.toDate();
  else if (typeof value === "object" && Number.isFinite(value.seconds)) date = new Date(value.seconds * 1000);
  else date = new Date(value);
  if (!Number.isFinite(date.getTime())) return String(value);
  return new Intl.DateTimeFormat(undefined, {
    month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit"
  }).format(date);
}

function statusClass(status = "") {
  const value = String(status).toLowerCase();
  if (value.includes("publish") || value === "success") return "published";
  if (value.includes("fail") || value.includes("reject") || value.includes("error")) return "failed";
  if (value.includes("facebook") || value.includes("fb") || value.includes("scheduled")) return "scheduled";
  return "queued";
}

function statusLabel(status = "") {
  const value = String(status).toLowerCase();
  if (value.includes("publish") || value === "success") return "Published";
  if (value.includes("fail") || value.includes("reject") || value.includes("error")) return "Failed";
  if (value.includes("facebook") || value.includes("fb")) return "Scheduled (FB)";
  if (value.includes("scheduled")) return "Scheduled";
  return "Queued (Firestore)";
}

function pickArray(...values) {
  return values.find(Array.isArray) || [];
}

function extractLists(payload = {}) {
  const root = payload.data || payload.posts || payload;
  const facebookScheduled = pickArray(
    root.facebookScheduled, root.facebook_scheduled, root.fbScheduled,
    root.scheduledFacebook, root.facebook?.scheduled
  );
  const firebaseQueue = pickArray(
    root.firebaseQueue, root.firebase_queue, root.queue, root.queued,
    root.firestoreQueue, root.firebase?.queue
  );
  const published = pickArray(
    root.published, root.publishedLog, root.published_log,
    root.todayPublished, root.history, root.facebook?.published
  );

  // Also accept a single posts array whose records identify their source/status.
  const all = pickArray(root.all, root.items, root.posts);
  if (!facebookScheduled.length && !firebaseQueue.length && !published.length && all.length) {
    for (const item of all) {
      const status = String(item.status || item.state || "").toLowerCase();
      const source = String(item.source || item.platform || "").toLowerCase();
      if (status.includes("publish")) published.push(item);
      else if (source.includes("facebook") || source === "fb" || status.includes("facebook")) facebookScheduled.push(item);
      else firebaseQueue.push(item);
    }
  }
  return { facebookScheduled, firebaseQueue, published };
}
function updateSummary(payload) {
  const lists = state.data;
  
  // আজকের তারিখ অনুযায়ী ফিল্টার করা
  const todayDateStr = new Date().toISOString().split("T")[0];
  const actualTodayCount = lists.published.filter(p => {
    const time = p.created_time || p.scheduledAt || p.createdAt || "";
    return typeof time === "string" && time.startsWith(todayDateStr);
  }).length;

  const publishedToday = Number(payload?.publishedToday ?? payload?.data?.publishedToday ?? actualTodayCount);
  const queueCount = Number(payload?.queueCount ?? payload?.data?.queueCount ?? lists.firebaseQueue.length);
  const fbCount = Number(payload?.facebookScheduledCount ?? payload?.data?.facebookScheduledCount ?? lists.facebookScheduled.length);
  const limit = Number(payload?.dailyLimit ?? payload?.data?.dailyLimit ?? 5);
  const used = Number(payload?.dailyUsed ?? payload?.data?.dailyUsed ?? publishedToday);

  $("#publishedCount").textContent = String(publishedToday);
  $("#queueCount").textContent = String(queueCount);
  $("#fbScheduledCount").textContent = String(fbCount);
  $("#dailyLimitText").textContent = `${used} / ${limit} Used`;
  $("#dailyLimitBar").style.width = `${Math.min(100, limit > 0 ? (used / limit) * 100 : 0)}%`;
  $("#dailyLimitBar").classList.toggle("is-limit", limit > 0 && used >= limit);
  $("#fbTabCount").textContent = String(lists.facebookScheduled.length);
  $("#queueTabCount").textContent = String(lists.firebaseQueue.length);
  $("#publishedTabCount").textContent = String(lists.published.length);

  const connected = payload?.pageConnected ?? payload?.data?.pageConnected ?? payload?.connected ?? payload?.page?.connected ?? payload?.data?.page?.connected;
  const pageStatus = $("#pageStatus");
  if (connected === true) {
    pageStatus.className = "status-pill status-connected";
    pageStatus.innerHTML = '<span class="status-dot"></span> Page connected';
  } else if (connected === false) {
    pageStatus.className = "status-pill status-disconnected";
    pageStatus.innerHTML = '<span class="status-dot"></span> Disconnected';
  } else {
    pageStatus.className = "status-pill status-muted";
    pageStatus.innerHTML = '<span class="status-dot"></span> Status unavailable';
  }
}
function currentList() {
  if (state.tab === "firebase") return state.data.firebaseQueue;
  if (state.tab === "published") return state.data.published;
  return state.data.facebookScheduled;
}

function renderPosts() {
  const list = $("#postList");
  const empty = $("#emptyState");
  const posts = currentList().map(normalisePost);
  list.replaceChildren();
  $("#listStatus").textContent = `${posts.length} post${posts.length === 1 ? "" : "s"}`;
  empty.classList.toggle("hidden", posts.length > 0);

  for (const post of posts) {
    const card = document.createElement("article");
    card.className = "post-card";
    const badgeClass = statusClass(post.status);
    const image = post.imageUrl
      ? `<img class="post-thumb" src="${escapeHtml(post.imageUrl)}" alt="" loading="lazy" referrerpolicy="no-referrer">`
      : `<div class="post-thumb post-thumb-empty">▧</div>`;
    card.innerHTML = `
      ${image}
      <div class="post-main">
        <div class="post-meta"><span class="status-badge ${badgeClass}">${escapeHtml(statusLabel(post.status))}</span><time>${escapeHtml(formatDate(post.scheduledAt))}</time></div>
        <p class="post-caption">${escapeHtml(post.caption)}</p>
        ${post.id ? `<span class="post-id">ID: ${escapeHtml(post.id)}</span>` : ""}
      </div>`;
    const thumb = card.querySelector("img.post-thumb");
    if (thumb) thumb.addEventListener("error", () => {
      const fallback = document.createElement("div");
      fallback.className = "post-thumb post-thumb-empty";
      fallback.textContent = "▧";
      thumb.replaceWith(fallback);
    }, { once: true });
    list.append(card);
  }
}

async function loadPosts({ quiet = false } = {}) {
  if (!quiet) $("#listStatus").textContent = "Loading posts…";
  try {
    const payload = await apiRequest(API.posts, { method: "GET" });
    state.data = extractLists(payload);
    updateSummary(payload);
    renderPosts();
  } catch (error) {
    $("#listStatus").textContent = "Could not load posts.";
    $("#postList").replaceChildren();
    $("#emptyState").classList.add("hidden");
    if (!quiet) toast(error.message || "Unable to fetch posts.", "error");
  }
}

function switchMode(mode) {
  state.mode = mode;
  const single = mode === "single";
  $("#singleForm").classList.toggle("hidden", !single);
  $("#bulkForm").classList.toggle("hidden", single);
  $("#singleModeBtn").classList.toggle("is-active", single);
  $("#bulkModeBtn").classList.toggle("is-active", !single);
  $("#singleModeBtn").setAttribute("aria-selected", String(single));
  $("#bulkModeBtn").setAttribute("aria-selected", String(!single));
}

function switchTab(tab) {
  state.tab = tab;
  $$(".tab-btn").forEach(button => {
    const active = button.dataset.tab === tab;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-selected", String(active));
  });
  renderPosts();
}

function updateCaptionCount() {
  $("#captionCount").textContent = `${$("#captionInput").value.length} characters`;
}

function makeBulkEntry(data = {}) {
  const wrapper = document.createElement("article");
  wrapper.className = "bulk-entry";
  wrapper.innerHTML = `
    <div class="bulk-entry-top"><strong class="bulk-entry-title">Post</strong><button type="button" class="remove-entry text-btn">Remove</button></div>
    <div class="field">
      <label>Post topic / idea <span class="optional">(Gemini input)</span></label>
      <textarea class="bulk-topic" rows="2" placeholder="e.g. New product launch, helpful tip, seasonal offer…"></textarea>
    </div>
    <div class="button-row bulk-ai-actions">
      <button type="button" class="btn btn-secondary bulk-generate-caption">✦ Generate caption with Gemini</button>
    </div>
    <label>Caption <span class="required">*</span></label>
    <textarea class="bulk-caption" rows="3" placeholder="Generated caption appears here, or write your own…" required></textarea>
    <div class="field bulk-image-prompt-field">
      <label>AI image prompt <span class="optional">(Cloudflare)</span></label>
      <textarea class="bulk-image-prompt" rows="2" placeholder="Describe the image for this post…"></textarea>
      <div class="button-row bulk-ai-actions">
        <button type="button" class="btn btn-secondary bulk-generate-image">▧ Generate image with Cloudflare</button>
      </div>
    </div>
    <div class="form-grid">
      <div class="field"><label>Schedule date &amp; time <span class="required">*</span></label><input class="bulk-time" type="datetime-local" required></div>
      <div class="field"><label>Image URL <span class="optional">(optional)</span></label><input class="bulk-image" type="url" placeholder="https://…"></div>
    </div>
    <div class="bulk-image-preview hidden"><img class="bulk-generated-image" alt="AI generated post image"><small>Generated image preview</small></div>`;
  $(".bulk-caption", wrapper).value = data.caption || "";
  $(".bulk-image", wrapper).value = data.imageUrl || "";
  $(".bulk-topic", wrapper).value = data.topic || "";
  $(".bulk-image-prompt", wrapper).value = data.imagePrompt || "";
  setDefaultScheduleTime($(".bulk-time", wrapper));
  if (data.scheduleAt) {
    const date = new Date(data.scheduleAt);
    if (Number.isFinite(date.getTime())) $(".bulk-time", wrapper).value = toDateInputValue(date);
  }
  $(".remove-entry", wrapper).addEventListener("click", () => {
    if ($("#bulkEntries").children.length <= 1) {
      toast("At least one bulk post entry is required.", "info", 2600);
      return;
    }
    wrapper.remove();
    renumberBulkEntries();
  });
  $("#bulkEntries").append(wrapper);
  renumberBulkEntries();
  return wrapper;
}

function renumberBulkEntries() {
  const entries = $$(".bulk-entry");
  entries.forEach((entry, index) => {
    $(".bulk-entry-title", entry).textContent = `Post ${index + 1}`;
    $(".remove-entry", entry).disabled = entries.length <= 1;
  });
  $("#bulkCount").textContent = `${entries.length} of 20 posts`;
  $("#addBulkBtn").disabled = entries.length >= 20;
}

function readBulkEntries() {
  return $$(".bulk-entry").map(entry => ({
    caption: $(".bulk-caption", entry).value.trim(),
    scheduledAt: $(".bulk-time", entry).value,
    imageUrl: $(".bulk-image", entry).value.trim()
  }));
}

async function submitSchedule(event) {
  event.preventDefault();
  if (state.busy) return;
  let posts;
  let type;
  if (state.mode === "single") {
    const caption = $("#captionInput").value.trim();
    const scheduleAt = $("#scheduleAt").value;
    const imageUrl = $("#imageUrl").value.trim();
    if (!caption) return toast("Please enter a caption.", "error");
    const timeError = validateSchedule(scheduleAt);
    if (timeError) return toast(timeError, "error");
    if (imageUrl && !isValidUrl(imageUrl)) return toast("Please enter a valid image URL.", "error");
    posts = [{ caption, scheduledAt: scheduleAt, imageUrl }];
    type = "single";
  } else {
    posts = readBulkEntries();
    if (!posts.length || posts.length > 20) return toast("Bulk scheduling supports 1–20 posts.", "error");
    for (let i = 0; i < posts.length; i++) {
      if (!posts[i].caption) return toast(`Post ${i + 1}: caption is required.`, "error");
      const timeError = validateSchedule(posts[i].scheduledAt);
      if (timeError) return toast(`Post ${i + 1}: ${timeError}`, "error");
      if (posts[i].imageUrl && !isValidUrl(posts[i].imageUrl)) return toast(`Post ${i + 1}: image URL is invalid.`, "error");
    }
    type = "bulk";
  }

  const button = event.submitter || (type === "single" ? $("#singleForm button[type=submit]") : $("#bulkForm button[type=submit]"));
  state.busy = true;
  setBusy(button, true, type === "single" ? "Scheduling…" : "Scheduling posts…");
  try {
    const result = await apiRequest(API.schedule, {
      method: "POST",
      body: JSON.stringify({ type, posts })
    });
    toast(result.message || `${posts.length} post${posts.length === 1 ? "" : "s"} scheduled successfully.`, "success");
    if (type === "single") {
      $("#captionInput").value = "";
      $("#imageUrl").value = "";
      $("#imagePrompt").value = "";
      $("#imagePreview").classList.add("hidden");
      updateCaptionCount();
      setDefaultScheduleTime($("#scheduleAt"));
    } else {
      $("#bulkEntries").replaceChildren();
      makeBulkEntry();
    }
    await loadPosts({ quiet: true });
  } catch (error) {
    toast(error.message || "Scheduling failed.", "error");
  } finally {
    state.busy = false;
    setBusy(button, false);
  }
}

function isValidUrl(value) {
  if (typeof value === "string" && value.startsWith("data:image/")) return true;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" || url.protocol === "data:";
  } catch {
    return false;
  }
}

async function generateCaption() {
  const button = $("#generateCaptionBtn");
  const currentCaption = $("#captionInput").value.trim();
  setBusy(button, true, "Generating…");
  toast("Gemini caption generation started.", "info", 2200);
  try {
    const payload = await apiRequest(API.caption, {
      method: "POST",
      body: JSON.stringify({ caption: currentCaption, context: "Generate a Facebook page caption based on the page's recent posts." })
    });
    const caption = payload.caption || payload.text || payload.data?.caption || payload.data?.text;
    if (!caption) throw new Error("The caption API returned no caption. Check the backend response format.");
    $("#captionInput").value = caption;
    updateCaptionCount();
    toast("Caption generated successfully.", "success");
  } catch (error) {
    toast(error.message || "Caption generation failed.", "error");
  } finally {
    setBusy(button, false);
  }
}

async function generateImage() {
  const button = $("#generateImageBtn");
  const prompt = $("#imagePrompt").value.trim();
  if (!prompt) return toast("Enter an AI image prompt first.", "error");
  setBusy(button, true, "Generating image…");
  toast("AI image generation started.", "info", 2200);
  try {
    const payload = await apiRequest(API.image, {
      method: "POST",
      body: JSON.stringify({ prompt, count: 1 })
    });
    const url = payload.url || payload.imageUrl || payload.image_url ||
      payload.data?.url || payload.data?.imageUrl ||
      payload.images?.[0]?.url || payload.data?.images?.[0]?.url;
    if (!url || !isValidUrl(url)) throw new Error("The image API returned no valid image URL.");
    state.generatedImageUrl = url;
    $("#generatedImage").src = url;
    $("#imagePreview").classList.remove("hidden");
    toast("AI image generated successfully.", "success");
  } catch (error) {
    toast(error.message || "AI image generation failed.", "error");
  } finally {
    setBusy(button, false);
  }
}

function parseCsvLine(line) {
  const cells = [];
  let value = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"' && quoted && line[i + 1] === '"') { value += '"'; i++; }
    else if (char === '"') quoted = !quoted;
    else if (char === "," && !quoted) { cells.push(value); value = ""; }
    else value += char;
  }
  cells.push(value);
  return cells;
}

async function importCsv(file) {
  if (!file) return;
  try {
    const raw = await file.text();
    const lines = raw.replace(/^\uFEFF/, "").split(/\r?\n/).filter(line => line.trim());
    if (lines.length < 2) throw new Error("CSV must contain a header and at least one post.");
    const headers = parseCsvLine(lines[0]).map(value => value.trim().toLowerCase());
    const captionIndex = headers.indexOf("caption");
    const timeIndex = headers.findIndex(value => ["scheduleat", "scheduledat", "scheduled_at", "datetime"].includes(value));
    const imageIndex = headers.findIndex(value => ["imageurl", "image_url", "image"].includes(value));
    if (captionIndex < 0 || timeIndex < 0) throw new Error("CSV needs caption and scheduleAt columns.");
    const rows = lines.slice(1).map(line => {
      const cells = parseCsvLine(line);
      return {
        caption: (cells[captionIndex] || "").trim(),
        scheduleAt: (cells[timeIndex] || "").trim(),
        imageUrl: imageIndex >= 0 ? (cells[imageIndex] || "").trim() : ""
      };
    }).filter(row => row.caption || row.scheduleAt);
    if (!rows.length) throw new Error("No post entries found in CSV.");
    if (rows.length > 20) throw new Error("CSV contains more than 20 posts. Split it into smaller files.");
    $("#bulkEntries").replaceChildren();
    rows.forEach(row => makeBulkEntry(row));
    switchMode("bulk");
    toast(`${rows.length} post${rows.length === 1 ? "" : "s"} imported. Review dates and submit.`, "success");
  } catch (error) {
    toast(error.message || "Unable to import CSV.", "error");
  } finally {
    $("#csvInput").value = "";
  }
}

async function generateBulkCaption(entry) {
  const button = $(".bulk-generate-caption", entry);
  const topic = $(".bulk-topic", entry).value.trim();
  const currentCaption = $(".bulk-caption", entry).value.trim();
  if (!topic && !currentCaption) {
    toast("Enter a topic or draft caption for this post first.", "error");
    return;
  }
  setBusy(button, true, "Generating…");
  try {
    const payload = await apiRequest(API.caption, {
      method: "POST",
      body: JSON.stringify({
        caption: topic || currentCaption,
        context: "Create a polished Facebook Page post caption. Treat the input as the topic/brief, not as final copy. Keep it engaging, relevant, and page-appropriate. Return only the caption."
      })
    });
    const caption = payload.caption || payload.text || payload.data?.caption || payload.data?.text;
    if (!caption) throw new Error("Gemini returned no caption. Check /api/posts/generate-caption.");
    $(".bulk-caption", entry).value = caption;
    toast("Gemini caption generated for this post.", "success", 2600);
  } catch (error) {
    toast(error.message || "Gemini caption generation failed.", "error");
  } finally {
    setBusy(button, false);
  }
}

async function generateBulkImage(entry) {
  const button = $(".bulk-generate-image", entry);
  const prompt = $(".bulk-image-prompt", entry).value.trim();
  if (!prompt) {
    toast("Enter an image prompt for this post first.", "error");
    return;
  }
  setBusy(button, true, "Generating image…");
  try {
    const payload = await apiRequest(API.image, {
      method: "POST",
      body: JSON.stringify({ prompt, count: 1 })
    });
    const url = payload.url || payload.imageUrl || payload.image_url ||
      payload.data?.url || payload.data?.imageUrl ||
      payload.images?.[0]?.url || payload.data?.images?.[0]?.url;
    if (!url || !isValidUrl(url)) throw new Error("Cloudflare image API returned no valid image URL.");
    $(".bulk-image", entry).value = url;
    const preview = $(".bulk-image-preview", entry);
    const img = $(".bulk-generated-image", entry);
    img.src = url;
    preview.classList.remove("hidden");
    toast("Cloudflare image generated and added to this post.", "success", 2600);
  } catch (error) {
    toast(error.message || "AI image generation failed.", "error");
  } finally {
    setBusy(button, false);
  }
}

async function generateAllBulkCaptions() {
  const entries = $$(".bulk-entry");
  const missing = entries.filter(entry => !$(".bulk-topic", entry).value.trim() && !$(".bulk-caption", entry).value.trim());
  if (missing.length) {
    toast(`Add a topic or draft caption to each post first. ${missing.length} post(s) need input.`, "error", 5000);
    return;
  }
  const button = $("#generateAllCaptionsBtn");
  setBusy(button, true, "Generating captions…");
  let completed = 0;
  try {
    for (const entry of entries) {
      const topic = $(".bulk-topic", entry).value.trim();
      const currentCaption = $(".bulk-caption", entry).value.trim();
      if (!topic && currentCaption) continue;
      const payload = await apiRequest(API.caption, {
        method: "POST",
        body: JSON.stringify({
          caption: topic || currentCaption,
          context: "Create a distinct, polished Facebook Page post caption from this topic/brief. Return only the caption."
        })
      });
      const caption = payload.caption || payload.text || payload.data?.caption || payload.data?.text;
      if (!caption) throw new Error(`Gemini returned no caption for ${$(".bulk-entry-title", entry).textContent}.`);
      $(".bulk-caption", entry).value = caption;
      completed++;
    }
    toast(`Gemini generated ${completed} caption(s). Review them before scheduling.`, "success", 5000);
  } catch (error) {
    toast(error.message || "Bulk caption generation failed.", "error", 5000);
  } finally {
    setBusy(button, false);
  }
}


async function createFivePostsFromIdea() {
  const idea = $("#sharedBulkIdea").value.trim();
  if (!idea) return toast("আগে একটি topic বা caption idea লিখুন।", "error");
  if (state.busy) return;

  const button = $("#createFivePostsBtn");
  state.busy = true;
  setBusy(button, true, "Creating 5 posts…");
  const created = [];
  try {
    for (let i = 0; i < 5; i++) {
      const isImagePost = i < 2;
      const captionPayload = await apiRequest(API.caption, {
        method: "POST",
        body: JSON.stringify({
          caption: idea,
          context: [
            `Create post ${i + 1} of a coordinated set of 5 distinct Facebook Page posts.`,
            "Write premium-quality, natural, engaging copy. Each post must have a different angle and must not repeat the others.",
            "Include exactly 5 relevant popular/trending-style hashtags at the end. Hashtags should be relevant to the topic and audience; do not claim live trend verification.",
            isImagePost ? "This post will include an image; write a caption that pairs naturally with a premium visual." : "This is a text-only post; do not refer to an attached image.",
            "Return only the finished caption, no headings or explanation."
          ].join(" ")
        })
      });
      const caption = captionPayload.caption || captionPayload.text ||
        captionPayload.data?.caption || captionPayload.data?.text;
      if (!caption) throw new Error(`Gemini returned no caption for post ${i + 1}.`);

      let imageUrl = "";
      if (isImagePost) {
        const imagePayload = await apiRequest(API.image, {
          method: "POST",
          body: JSON.stringify({
            prompt: `Create a premium, polished, scroll-stopping Facebook post visual about: ${idea}. Variation ${i + 1} of 2, visually distinct composition, high quality, no fake logos, no watermark, avoid rendering text in the image.`,
            count: 1
          })
        });
        imageUrl = imagePayload.url || imagePayload.imageUrl || imagePayload.image_url ||
          imagePayload.data?.url || imagePayload.data?.imageUrl ||
          imagePayload.images?.[0]?.url || imagePayload.data?.images?.[0]?.url || "";
        if (!imageUrl || !isValidUrl(imageUrl)) {
          throw new Error(`Image generation returned no valid URL for post ${i + 1}.`);
        }
      }

      const scheduled = new Date(Date.now() + 30 * 60 * 1000 + i * 24 * 60 * 60 * 1000);
      scheduled.setSeconds(0, 0);
      created.push({
        caption,
        imageUrl,
        topic: `${idea} — angle ${i + 1}`,
        imagePrompt: isImagePost ? `Premium Facebook visual about ${idea}` : "",
        scheduleAt: toDateInputValue(scheduled)
      });
    }

    $("#bulkEntries").replaceChildren();
    created.forEach(post => {
      const entry = makeBulkEntry(post);
      if (!post.imageUrl) {
        $(".bulk-image-prompt-field", entry).classList.add("hidden");
      } else {
        $(".bulk-generated-image", entry).src = post.imageUrl;
        $(".bulk-image-preview", entry).classList.remove("hidden");
      }
    });
    switchMode("bulk");
    toast("5টি post তৈরি হয়েছে: 2টি image post + 3টি text-only post। Schedule করার আগে সময় ও caption দেখে নিন।", "success", 6500);
  } catch (error) {
    toast(error.message || "Could not create the five posts.", "error", 6500);
  } finally {
    state.busy = false;
    setBusy(button, false);
  }
}

function bindEvents() {
  $("#singleModeBtn").addEventListener("click", () => switchMode("single"));
  $("#bulkModeBtn").addEventListener("click", () => switchMode("bulk"));
  $("#captionInput").addEventListener("input", updateCaptionCount);
  $("#singleForm").addEventListener("submit", submitSchedule);
  $("#bulkForm").addEventListener("submit", submitSchedule);
  $("#generateCaptionBtn").addEventListener("click", generateCaption);
  $("#generateImageBtn").addEventListener("click", generateImage);
  $("#generateAllCaptionsBtn").addEventListener("click", generateAllBulkCaptions);
  $("#createFivePostsBtn").addEventListener("click", createFivePostsFromIdea);
  $("#bulkEntries").addEventListener("click", event => {
    const entry = event.target.closest(".bulk-entry");
    if (!entry) return;
    if (event.target.closest(".bulk-generate-caption")) generateBulkCaption(entry);
    if (event.target.closest(".bulk-generate-image")) generateBulkImage(entry);
  });
  $("#useImageBtn").addEventListener("click", () => {
    if (!state.generatedImageUrl) return;
    $("#imageUrl").value = state.generatedImageUrl;
    toast("Generated image URL added to the post.", "success", 2400);
  });
  $("#addBulkBtn").addEventListener("click", () => {
    if ($("#bulkEntries").children.length >= 20) return toast("Maximum 20 posts per batch.", "error");
    makeBulkEntry();
  });
  $("#csvInput").addEventListener("change", event => importCsv(event.target.files?.[0]));
  $$(".tab-btn").forEach(button => button.addEventListener("click", () => switchTab(button.dataset.tab)));
  $("#refreshBtn").addEventListener("click", () => loadPosts());
  $("#listRefreshBtn").addEventListener("click", () => loadPosts());
}

function init() {
  bindEvents();
  setDefaultScheduleTime($("#scheduleAt"));
  makeBulkEntry();
  updateCaptionCount();

  // Shared auth bootstrap should expose window.auth. Wait for a signed-in user
  // where Firebase's onAuthStateChanged callback is available globally.
  const auth = getAuth();
  if (!auth) {
    $("#listStatus").textContent = "Authentication is not configured.";
    toast("Auth not found. Expose the shared Firebase Auth instance as window.auth in public/script.js.", "error", 7000);
    return;
  }
  if (auth.currentUser) {
    loadPosts();
    return;
  }
  if (typeof window.onFirebaseAuthReady === "function") {
    window.onFirebaseAuthReady(user => user ? loadPosts() : (window.location.href = "../login.html"));
  } else {
    // Give the shared auth script a short chance to finish its initial auth check.
    let attempts = 0;
    const check = () => {
      if (auth.currentUser) loadPosts();
      else if (++attempts < 20) window.setTimeout(check, 250);
      else {
        $("#listStatus").textContent = "Please sign in to load posts.";
        toast("Please sign in, then reopen Posts Management.", "error", 6000);
      }
    };
    check();
  }
}

init();
