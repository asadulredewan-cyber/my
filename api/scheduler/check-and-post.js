import * as Facebook from "../../lib/facebook.js";
import * as Gemini from "../../lib/gemini.js";
import { db } from "../../lib/firebase-admin.js";

const TZ = "Asia/Dhaka";
const DAILY_LIMIT = 5;
const send = (res, status, body) => res.status(status).json(body);

function dhakaParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23"
  }).formatToParts(date);
  return Object.fromEntries(parts.filter(p => p.type !== "literal").map(p => [p.type, p.value]));
}
function dhakaDateKey(date = new Date()) {
  const p = dhakaParts(date);
  return `${p.year}-${p.month}-${p.day}`;
}
// Converts a Dhaka wall-clock time into a real instant without assuming the server timezone.
function dhakaWallTimeToDate(dateKey, hour, minute) {
  const [year, month, day] = dateKey.split("-").map(Number);
  const targetAsUtc = Date.UTC(year, month - 1, day, hour, minute, 0);
  let guess = targetAsUtc - 6 * 60 * 60 * 1000; // Bangladesh is UTC+06:00.
  // Confirm/correct against the named time zone in case timezone rules ever change.
  for (let i = 0; i < 2; i++) {
    const p = dhakaParts(new Date(guess));
    const actualAsUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
    const delta = targetAsUtc - actualAsUtc;
    if (delta === 0) break;
    guess += delta;
  }
  return new Date(guess);
}
function scheduledTime(post) {
  const raw = post.scheduled_publish_time ?? post.scheduled_time ?? post.scheduledTime;
  if (raw == null) return null;
  if (typeof raw === "number" || /^\d+$/.test(String(raw))) return new Date(Number(raw) * 1000);
  const d = new Date(raw);
  return Number.isFinite(d.getTime()) ? d : null;
}
function isSameDhakaDay(date, dayKey) {
  return date && Number.isFinite(date.getTime()) && dhakaDateKey(date) === dayKey;
}
async function generateCaption(posts, slot, index = 1) {
  const prompt = [
    "You are a Facebook Page content strategist.",
    "Generate a new text-only Facebook post in the page's usual language and tone.",
    "Do not include an image prompt, image URL, markdown fences, or commentary.",
    "Make it distinct from the supplied recent posts and suitable for the requested audience/time.",
    `Requested slot: ${slot}. This is distinct post ${index}.`,
    "Return JSON only: {\"caption\":\"...\"}.",
    `Recent posts: ${JSON.stringify((posts || []).slice(0, 10))}`
  ].join("\n\n");
  const fn = Gemini.generateText || Gemini.generateContent || Gemini.generateCaption;
  if (typeof fn !== "function") throw new Error("lib/gemini.js must export generateText()");
  const result = await fn(prompt, { json: true });
  let parsed;
  if (typeof result === "string") {
    const cleaned = result.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
    try { parsed = JSON.parse(cleaned); }
    catch {
      const start = cleaned.indexOf("{"), end = cleaned.lastIndexOf("}");
      if (start < 0 || end <= start) throw new Error("Gemini returned invalid JSON");
      parsed = JSON.parse(cleaned.slice(start, end + 1));
    }
  } else parsed = result;
  const caption = String(parsed?.caption || "").trim();
  if (!caption) throw new Error("Gemini returned an empty caption");
  return caption;
}
async function countPublishedToday(dayKey) {
  // Supports ISO timestamps written by the current API modules.
  const snap = await db.collection("scheduled_posts").where("status", "==", "published").get();
  return snap.docs.filter(doc => {
    const d = doc.data();
    const date = new Date(d.publishedAt || d.published_at || d.updatedAt || d.createdAt || 0);
    return isSameDhakaDay(date, dayKey);
  }).length;
}
async function firestorePostsForDay(dayKey) {
  const snap = await db.collection("scheduled_posts").where("status", "in", ["pending", "scheduled"]).get();
  return snap.docs.map(doc => ({ id: doc.id, ...doc.data() })).filter(post => {
    const when = scheduledTime(post);
    return isSameDhakaDay(when, dayKey);
  });
}
async function hasNativeScheduledPostForDay(posts, dayKey, fromInstant = null) {
  return (posts || []).some(post => {
    const when = scheduledTime(post);
    if (!isSameDhakaDay(when, dayKey)) return false;
    return !fromInstant || when.getTime() >= fromInstant.getTime();
  });
}
async function logSkip(slot, reason, extra = {}) {
  await db.collection("scheduler_logs").add({
    slot, action: "skipped", reason, ...extra, createdAt: new Date().toISOString()
  });
}
async function scheduleTextOnly(caption, when, slot) {
  const now = Date.now();
  if (when.getTime() < now + 10 * 60 * 1000) {
    throw new Error(`Refusing to schedule in the past or less than 10 minutes ahead: ${when.toISOString()}`);
  }
  const timestamp = Math.floor(when.getTime() / 1000);
  // Text-only invariant: no imageUrl, attached_media, source, or media-generation call.
  const result = await Facebook.publishOrSchedulePost({
    message: caption,
    scheduledPublishTime: when.toISOString()
  });
  await db.collection("scheduled_posts").add({
    message: caption,
    scheduled_time: when.toISOString(),
    scheduled_publish_time: timestamp,
    status: "scheduled",
    source: "cron_gemini_text_only",
    slot,
    facebookPostId: result.id || null,
    createdAt: new Date().toISOString()
  });
  await db.collection("scheduler_logs").add({
    slot, action: "scheduled", facebookPostId: result.id || null,
    scheduled_time: when.toISOString(), createdAt: new Date().toISOString()
  });
  return { facebookPostId: result.id || null, scheduled_time: when.toISOString(), scheduled_publish_time: timestamp };
}

export default async function handler(req, res) {
  if (!["GET", "POST"].includes(req.method)) {
    return send(res, 405, { success: false, data: null, error: "Method not allowed" });
  }

  const authHeader = req.headers?.authorization || "";
  if (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return send(res, 401, { success: false, data: null, error: "Unauthorized cron trigger" });
  }

  const slot = String(req.query?.slot || req.body?.slot || "");
  if (!["early", "afternoon"].includes(slot)) {
    return send(res, 400, { success: false, data: null, error: 'slot must be "early" or "afternoon"' });
  }

  try {
    const now = new Date();
    const dayKey = dhakaDateKey(now);
    const publishedToday = await countPublishedToday(dayKey);
    if (publishedToday >= DAILY_LIMIT) {
      await logSkip(slot, "daily_limit_reached", { publishedToday, limit: DAILY_LIMIT });
      return send(res, 200, { success: true, data: { action: "skipped", reason: "daily_limit_reached", publishedToday, limit: DAILY_LIMIT }, error: null });
    }

    const queuedToday = await firestorePostsForDay(dayKey);
    const { scheduled: nativeScheduled } = await Facebook.getLiveAndScheduledPosts();
    const nativeForDay = (nativeScheduled || []).filter(post => isSameDhakaDay(scheduledTime(post), dayKey));

    if (slot === "early") {
      if (queuedToday.length || nativeForDay.length) {
        await logSkip(slot, "post_already_scheduled_today", { firestoreQueueCount: queuedToday.length, facebookScheduledCount: nativeForDay.length });
        return send(res, 200, { success: true, data: { action: "skipped", reason: "post_already_scheduled_today", firestoreQueueCount: queuedToday.length, facebookScheduledCount: nativeForDay.length }, error: null });
      }

      const recentPosts = await Facebook.getRecentPagePosts(10);
      const morning = dhakaWallTimeToDate(dayKey, 7, 30);
      const midday = dhakaWallTimeToDate(dayKey, 12, 45);
      const targets = [
        { when: morning, label: "today 07:30 Bangladesh time", index: 1 },
        { when: midday, label: "today 12:45 Bangladesh time", index: 2 }
      ];
      const scheduled = [];
      for (const target of targets) {
        if (target.when.getTime() < Date.now() + 10 * 60 * 1000) {
          // Do not publish an out-of-date morning slot if this cron ran late.
          scheduled.push({ skipped: true, reason: "target_time_too_close_or_passed", scheduled_time: target.when.toISOString() });
          continue;
        }
        const caption = await generateCaption(recentPosts, target.label, target.index);
        scheduled.push(await scheduleTextOnly(caption, target.when, slot));
      }
      await db.collection("scheduler_logs").add({ slot, action: "early_complete", scheduledCount: scheduled.filter(x => !x.skipped).length, createdAt: new Date().toISOString() });
      return send(res, 200, { success: true, data: { action: "early_complete", day: dayKey, scheduled }, error: null });
    }

    const todayAfternoon = dhakaWallTimeToDate(dayKey, 15, 0);
    const evening = dhakaWallTimeToDate(dayKey, 19, 10);
    if (now.getTime() < todayAfternoon.getTime()) {
      return send(res, 400, { success: false, data: null, error: "The afternoon slot must run at or after 03:00 PM Bangladesh time" });
    }
    const pendingTonight = [
      ...queuedToday.filter(p => {
        const when = scheduledTime(p);
        return when && when >= now && when < dhakaWallTimeToDate(dayKey, 23, 59);
      }),
      ...nativeForDay.filter(p => {
        const when = scheduledTime(p);
        return when && when >= now && when < dhakaWallTimeToDate(dayKey, 23, 59);
      })
    ];
    if (pendingTonight.length) {
      await logSkip(slot, "post_already_scheduled_for_tonight", { pendingCount: pendingTonight.length });
      return send(res, 200, { success: true, data: { action: "skipped", reason: "post_already_scheduled_for_tonight", pendingCount: pendingTonight.length }, error: null });
    }
    if (evening.getTime() < Date.now() + 10 * 60 * 1000) {
      return send(res, 200, { success: true, data: { action: "skipped", reason: "evening_target_less_than_10_minutes_away", scheduled_time: evening.toISOString() }, error: null });
    }

    const recentPosts = await Facebook.getRecentPagePosts(10);
    const caption = await generateCaption(recentPosts, "today 07:10 PM Bangladesh time, evening audience engagement", 1);
    const scheduled = await scheduleTextOnly(caption, evening, slot);
    return send(res, 200, { success: true, data: { action: "afternoon_complete", day: dayKey, scheduled }, error: null });
  } catch (error) {
    console.error("Scheduler error:", error?.message || error);
    try {
      await db.collection("scheduler_logs").add({
        slot, action: "error", error: String(error?.message || error), createdAt: new Date().toISOString()
      });
    } catch {}
    return send(res, 500, { success: false, data: null, error: error?.message || "Scheduler failed" });
  }
}
