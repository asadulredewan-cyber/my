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
  const d = doc.data();
  const x = createDecipheriv("aes-256-gcm", Buffer.from(k, "hex"), Buffer.from(d.pageAccessTokenIv, "base64"));
  x.setAuthTag(Buffer.from(d.pageAccessTokenTag, "base64"));
  return Buffer.concat([x.update(Buffer.from(d.pageAccessTokenEncrypted, "base64")), x.final()]).toString("utf8");
}

async function graph(path, token, params = {}) {
  const h = Facebook.graphRequest || Facebook.facebookRequest || Facebook.requestGraphApi;
  if (h) return h(path, { accessToken: token, params });
  const u = new URL(`https://graph.facebook.com/${process.env.META_GRAPH_VERSION || "v26.0"}/${path}`);
  u.searchParams.set("access_token", token);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));
  const r = await fetch(u);
  const d = await r.json();
  if (!r.ok || d.error) throw Error(d.error?.message || "Graph API failed");
  return d;
}

export default async function handler(req, res) {
  if (req.method !== "GET") return send(res, 405, { success: false, data: null, error: "Method not allowed" });
  if (!await verifyAdmin(req, res)) return;

  try {
    const db = dbClient();
    const cred = await db.collection("settings").doc("meta_credentials").get();

    if (!cred.exists) {
      return send(res, 200, {
        success: true,
        pageConnected: false,
        pageName: "Not Connected",
        publishedToday: 0,
        dailyUsed: 0,
        dailyLimit: 5,
        data: {
          pageConnected: false,
          pageName: "Not Connected",
          publishedToday: 0,
          dailyUsed: 0,
          dailyLimit: 5,
          live: [],
          published: [],
          facebookScheduled: [],
          queue: []
        },
        error: null
      });
    }

    const c = cred.data();
    const token = decrypt(cred);

    const [live, scheduled, queue] = await Promise.all([
      graph(`${c.pageId}/posts`, token, { fields: "id,message,created_time,permalink_url,full_picture", limit: 25 }).catch(() => ({ data: [] })),
      graph(`${c.pageId}/scheduled_posts`, token, { fields: "id,message,scheduled_publish_time", limit: 25 }).catch(() => ({ data: [] })),
      db.collection("scheduled_posts").orderBy("createdAt", "desc").limit(50).get()
    ]);

    const livePosts = live.data || [];

    // আজকের তারিখ (UTC/ISO) বের করে আজকের পোস্ট সংখ্যা গণনা
    const todayStr = new Date().toISOString().split("T")[0];
    const todayPublishedCount = livePosts.filter(p => p.created_time && p.created_time.startsWith(todayStr)).length;

    return send(res, 200, {
      success: true,
      pageConnected: true,
      pageName: c.pageName || "Active Facebook Page",
      publishedToday: todayPublishedCount,
      dailyUsed: todayPublishedCount,
      dailyLimit: 5,
      data: {
        pageConnected: true,
        pageName: c.pageName || "Active Facebook Page",
        publishedToday: todayPublishedCount,
        dailyUsed: todayPublishedCount,
        dailyLimit: 5,
        live: livePosts,
        published: livePosts,
        facebookScheduled: scheduled.data || [],
        queue: queue.docs.map(d => ({ id: d.id, ...d.data() }))
      },
      error: null
    });
  } catch (e) {
    return send(res, 500, { success: false, data: null, error: e.message || "Could not load posts" });
  }
}
