import * as Firebase from "../../lib/firebase-admin.js";
import * as Facebook from "../../lib/facebook.js";
import { verifyAdmin } from "../auth/verify-admin.js";
import { createDecipheriv } from "node:crypto";

const send = (res, s, b) => res.status(s).json(b);
const dbClient = () =>
  Firebase.db ||
  Firebase.firestore ||
  Firebase.default?.db ||
  Firebase.default?.firestore ||
  Firebase.admin?.firestore?.() ||
  Firebase.default?.firestore?.();

function decrypt(doc) {
  const k = process.env.TOKEN_ENCRYPTION_KEY || "";
  if (!/^[0-9a-fA-F]{64}$/.test(k)) throw Error("TOKEN_ENCRYPTION_KEY must be 32-byte hex");
  const d = doc.data(),
    x = createDecipheriv("aes-256-gcm", Buffer.from(k, "hex"), Buffer.from(d.pageAccessTokenIv, "base64"));
  x.setAuthTag(Buffer.from(d.pageAccessTokenTag, "base64"));
  return Buffer.concat([x.update(Buffer.from(d.pageAccessTokenEncrypted, "base64")), x.final()]).toString("utf8");
}

async function graph(path, token, params) {
  const h = Facebook.graphRequest || Facebook.facebookRequest || Facebook.requestGraphApi;
  if (h) return h(path, { accessToken: token, params, method: "POST" });
  const r = await fetch(`https://graph.facebook.com/${process.env.META_GRAPH_VERSION || "v26.0"}/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...params, access_token: token })
  });
  const d = await r.json();
  if (!r.ok || d.error) throw Error(d.error?.message || "Graph API failed");
  return d;
}

export default async function handler(req, res) {
  if (req.method !== "POST") return send(res, 405, { success: false, data: null, error: "Method not allowed" });
  if (!(await verifyAdmin(req, res))) return;

  try {
    const body = req.body || {};

    // ১. GEMINI CAPTION GENERATION (সরাসরি REST API দিয়ে, প্যাকেজ ছাড়া)
    if (body.caption !== undefined || body.context !== undefined) {
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) throw Error("GEMINI_API_KEY is not configured in Vercel Environment Variables");

      const promptTopic = String(body.caption || "").trim();
      const prompt = `
System / Context: ${body.context || "You are an expert social media manager for a Bengali Facebook Page. Write an engaging, natural, high-quality post caption."}

User Topic / Input: ${promptTopic || "Generate an engaging post"}

Instructions:
- Write the caption primarily in natural Bengali.
- Include 3 to 5 relevant hashtags at the end.
- Return ONLY the finalized caption text without quotes, markdown headers, or explanation.
`;

      const geminiRes = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${apiKey}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }]
          })
        }
      );

      const geminiData = await geminiRes.json().catch(() => ({}));
      if (!geminiRes.ok || geminiData.error) {
        throw Error(geminiData.error?.message || `Gemini API error (${geminiRes.status})`);
      }

      const generatedText = geminiData.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "";
      if (!generatedText) throw Error("Gemini returned an empty caption");

      return send(res, 200, {
        success: true,
        caption: generatedText,
        text: generatedText,
        data: { caption: generatedText, text: generatedText },
        error: null
      });
    }

    // ২. FACEBOOK POST SCHEDULING
    const posts = body.posts;
    if (!Array.isArray(posts) || !posts.length || posts.length > 100) {
      return send(res, 400, { success: false, data: null, error: "posts must be an array containing 1–100 items" });
    }
    if (body.type !== "single" && body.type !== "bulk") {
      return send(res, 400, { success: false, data: null, error: 'type must be "single" or "bulk"' });
    }
    if (body.type === "single" && posts.length !== 1) {
      return send(res, 400, { success: false, data: null, error: "single type requires exactly one post" });
    }

    const db = dbClient();
    const cred = await db.collection("settings").doc("meta_credentials").get();
    if (!cred.exists) return send(res, 400, { success: false, data: null, error: "Facebook Page is not connected" });

    const c = cred.data(),
      token = decrypt(cred),
      success = [],
      failed = [];

    for (let i = 0; i < posts.length; i++) {
      const p = posts[i],
        rawTime = p.scheduled_time || p.scheduledAt,
        when = new Date(rawTime),
        message = String(p.message || p.caption || "").trim();

      if (!message || !Number.isFinite(when.getTime()) || when.getTime() < Date.now() + 15 * 60 * 1000) {
        failed.push({ index: i, error: "message/caption required and schedule time must be at least 15 min future" });
        continue;
      }

      try {
        const data = { message, published: false, scheduled_publish_time: Math.floor(when.getTime() / 1000) };
        const img = p.image_url || p.imageUrl;
        if (img) data.link = String(img);

        const result = await graph(`${c.pageId}/feed`, token, data);
        const ref = await db.collection("scheduled_posts").add({
          message,
          scheduled_time: when.toISOString(),
          image_url: img || null,
          status: "scheduled",
          source: "manual",
          facebookPostId: result.id || null,
          createdBy: req.user.uid,
          createdAt: new Date().toISOString()
        });

        success.push({ index: i, queueId: ref.id, facebookPostId: result.id || null });
      } catch (e) {
        failed.push({ index: i, error: e.message || "Scheduling failed" });
      }
    }

    return send(res, success.length ? 200 : 400, {
      success: failed.length === 0,
      data: { scheduled: success, failed },
      error: failed.length ? "One or more posts failed" : null
    });
  } catch (e) {
    return send(res, 500, { success: false, data: null, error: e.message || "Operation failed" });
  }
}
