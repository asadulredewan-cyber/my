import * as Firebase from "../../lib/firebase-admin.js";

const authClient = () => Firebase.auth || Firebase.adminAuth || Firebase.default?.auth || Firebase.default?.adminAuth || Firebase.admin?.auth?.() || Firebase.default?.auth?.();
const send = (res, status, body) => res.status(status).json(body);
export async function verifyAdmin(req, res) {
  const header = req.headers?.authorization || req.headers?.Authorization || "";
  const token = /^Bearer\s+(.+)$/i.exec(header)?.[1];
  if (!token) { send(res, 401, { success: false, data: null, error: "Missing bearer token" }); return null; }
  try {
    const auth = authClient();
    if (!auth?.verifyIdToken) throw new Error("Firebase Admin auth export is not configured");
    const decoded = await auth.verifyIdToken(token);
    req.user = decoded;
    return decoded;
  } catch {
    send(res, 401, { success: false, data: null, error: "Invalid or expired Firebase ID token" });
    return null;
  }
}
export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") return send(res, 405, { success: false, data: null, error: "Method not allowed" });
  const user = await verifyAdmin(req, res);
  if (!user) return;
  return send(res, 200, { success: true, data: { uid: user.uid, email: user.email || null }, error: null });
}
