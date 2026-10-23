import * as Firebase from "../../lib/firebase-admin.js";
import { verifyAdmin } from "./verify-admin.js";
import { createCipheriv, randomBytes } from "node:crypto";

const send = (res, status, body) => res.status(status).json(body);
const dbClient = () => Firebase.db || Firebase.firestore || Firebase.default?.db || Firebase.default?.firestore || Firebase.admin?.firestore?.() || Firebase.default?.firestore?.();
function encrypt(value) {
  const keyHex = process.env.TOKEN_ENCRYPTION_KEY || "";
  if (!/^[0-9a-fA-F]{64}$/.test(keyHex)) throw new Error("TOKEN_ENCRYPTION_KEY must be 32-byte hex");
  const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", Buffer.from(keyHex, "hex"), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return { ciphertext: encrypted.toString("base64"), iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64") };
}
async function graph(path, params = {}) {
  const url = new URL(`https://graph.facebook.com/${process.env.META_GRAPH_VERSION || "v26.0"}/${path.replace(/^\/+/, "")}`);
  for (const [k,v] of Object.entries(params)) url.searchParams.set(k, String(v));
  const response = await fetch(url);
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.error) throw new Error(data.error?.message || `Meta Graph API error (${response.status})`);
  return data;
}
export default async function handler(req, res) {
  if (req.method !== "POST") return send(res, 405, { success: false, data: null, error: "Method not allowed" });
  if (!await verifyAdmin(req, res)) return;
  try {
    const shortLivedToken = req.body?.shortLivedToken;
    if (typeof shortLivedToken !== "string" || shortLivedToken.length < 20) return send(res, 400, { success: false, data: null, error: "shortLivedToken is required" });
    const { META_APP_ID, META_APP_SECRET } = process.env;
    if (!META_APP_ID || !META_APP_SECRET) throw new Error("Meta app environment variables are missing");
    const exchanged = await graph("oauth/access_token", { grant_type: "fb_exchange_token", client_id: META_APP_ID, client_secret: META_APP_SECRET, fb_exchange_token: shortLivedToken });
    const pages = await graph("me/accounts", { access_token: exchanged.access_token, fields: "id,name,access_token,tasks" });
    const page = (pages.data || []).find(p => Array.isArray(p.tasks) ? p.tasks.some(t => ["CREATE_CONTENT","MODERATE","MESSAGING","MANAGE"].includes(t)) : true);
    if (!page?.access_token || !page?.id) throw new Error("No eligible Facebook Page was returned. Check Page access and permissions.");
    const token = encrypt(page.access_token);
    const db = dbClient();
    if (!db?.collection) throw new Error("Firebase Admin Firestore export is not configured");
    await db.collection("settings").doc("meta_credentials").set({
      pageId: page.id, pageName: page.name || null,
      pageAccessTokenEncrypted: token.ciphertext, pageAccessTokenIv: token.iv, pageAccessTokenTag: token.tag,
      tokenEncryption: "aes-256-gcm", connectedBy: req.user.uid,
      connectedAt: new Date().toISOString(), updatedAt: new Date().toISOString()
    }, { merge: true });
    return send(res, 200, { success: true, data: { pageId: page.id, pageName: page.name || null, message: "Page credentials secured" }, error: null });
  } catch (e) {
    return send(res, 500, { success: false, data: null, error: e.message || "Facebook token exchange failed" });
  }
}
