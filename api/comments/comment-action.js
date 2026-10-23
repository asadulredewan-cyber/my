import * as Firebase from "../../lib/firebase-admin.js";
import * as Facebook from "../../lib/facebook.js";
import { verifyAdmin } from "../auth/verify-admin.js";
import { createDecipheriv } from "node:crypto";

const send = (res, status, body) => res.status(status).json(body);

function getDb() {
  return Firebase.db
    || Firebase.firestore
    || Firebase.default?.db
    || Firebase.default?.firestore
    || Firebase.admin?.firestore?.()
    || Firebase.default?.firestore?.();
}

function decryptPageToken(snapshot) {
  const key = process.env.TOKEN_ENCRYPTION_KEY || "";
  if (!/^[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error("TOKEN_ENCRYPTION_KEY must be a 32-byte hex string.");
  }

  const data = snapshot.data() || {};
  if (!data.pageAccessTokenIv || !data.pageAccessTokenTag || !data.pageAccessTokenEncrypted) {
    throw new Error("Encrypted Facebook Page token fields are missing.");
  }

  const decipher = createDecipheriv(
    "aes-256-gcm",
    Buffer.from(key, "hex"),
    Buffer.from(data.pageAccessTokenIv, "base64")
  );
  decipher.setAuthTag(Buffer.from(data.pageAccessTokenTag, "base64"));

  return Buffer.concat([
    decipher.update(Buffer.from(data.pageAccessTokenEncrypted, "base64")),
    decipher.final()
  ]).toString("utf8");
}

async function graphRequest(path, token, params = {}, method = "POST") {
  const helper = Facebook.graphRequest
    || Facebook.facebookRequest
    || Facebook.requestGraphApi;

  if (helper) {
    return helper(path, { accessToken: token, params, method });
  }

  const version = process.env.META_GRAPH_VERSION || "v26.0";
  const url = `https://graph.facebook.com/${version}/${path}`;
  let response;

  if (method === "DELETE") {
    const query = new URLSearchParams({ access_token: token });
    response = await fetch(`${url}?${query.toString()}`, { method: "DELETE" });
  } else {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...params, access_token: token })
    });
  }

  const raw = await response.text();
  let result;
  try {
    result = raw ? JSON.parse(raw) : {};
  } catch {
    throw new Error(`Meta Graph API returned non-JSON (HTTP ${response.status}).`);
  }

  if (!response.ok || result.error) {
    throw new Error(
      result.error?.message || `Meta Graph API request failed (HTTP ${response.status}).`
    );
  }
  return result;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return send(res, 405, {
      success: false,
      data: null,
      error: "Method not allowed"
    });
  }

  if (!await verifyAdmin(req, res)) return;

  try {
    const action = String(req.body?.action || "").trim().toLowerCase();
    const commentId = String(req.body?.commentId || "").trim();
    const message = String(req.body?.message || "").trim();

    if (!commentId) {
      return send(res, 400, {
        success: false, data: null, error: "commentId is required."
      });
    }

    if (!["reply", "hide", "unhide", "delete"].includes(action)) {
      return send(res, 400, {
        success: false,
        data: null,
        error: 'action must be "reply", "hide", "unhide", or "delete".'
      });
    }

    if (action === "reply" && (!message || message.length > 2000)) {
      return send(res, 400, {
        success: false,
        data: null,
        error: "A reply message is required (maximum 2000 characters)."
      });
    }

    const db = getDb();
    if (!db) throw new Error("Firebase Admin Firestore is not configured.");

    const credentials = await db.collection("settings").doc("meta_credentials").get();
    if (!credentials.exists) {
      return send(res, 400, {
        success: false, data: null, error: "Facebook Page is not connected."
      });
    }

    const pageToken = decryptPageToken(credentials);
    let result;

    if (action === "reply") {
      result = await graphRequest(`${commentId}/comments`, pageToken, { message }, "POST");
    } else if (action === "delete") {
      result = await graphRequest(commentId, pageToken, {}, "DELETE");
    } else {
      result = await graphRequest(
        commentId,
        pageToken,
        { is_hidden: action === "hide" },
        "POST"
      );
    }

    // Save moderation metadata if this comment has a matching flagged_items record.
    if (action !== "reply") {
      const matches = await db.collection("flagged_items")
        .where("itemId", "==", commentId)
        .get();

      if (!matches.empty) {
        const batch = db.batch();
        const update = {
          moderationStatus: action,
          moderatedAt: new Date().toISOString(),
          moderatedBy: req.user?.uid || null
        };
        for (const doc of matches.docs) {
          batch.set(doc.ref, update, { merge: true });
        }
        await batch.commit();
      }
    }

    return send(res, 200, {
      success: true,
      data: action === "reply"
        ? { commentId: result.id || null, parentCommentId: commentId, action }
        : { commentId, action, result },
      error: null
    });
  } catch (error) {
    console.error("comment-action API error:", error);
    return send(res, 500, {
      success: false,
      data: null,
      error: error?.message || "Comment action failed."
    });
  }
}
