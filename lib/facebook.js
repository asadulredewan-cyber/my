import { createDecipheriv } from "node:crypto";
import { db } from "./firebase-admin.js";

const GRAPH_VERSION = process.env.META_GRAPH_VERSION || "v26.0";
const CREDENTIALS_REF = () => db.collection("settings").doc("meta_credentials");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function decryptPageToken(data) {
  // Supports the AES-256-GCM document written by api/auth/fb-exchange-token.js.
  if (data.pageAccessToken && !data.pageAccessTokenEncrypted) return data.pageAccessToken;
  const keyHex = process.env.TOKEN_ENCRYPTION_KEY || "";
  if (!/^[0-9a-fA-F]{64}$/.test(keyHex)) {
    throw new Error("TOKEN_ENCRYPTION_KEY must be a 32-byte hex string");
  }
  if (!data.pageAccessTokenEncrypted || !data.pageAccessTokenIv || !data.pageAccessTokenTag) {
    throw new Error("Encrypted Facebook Page credentials are incomplete");
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    Buffer.from(keyHex, "hex"),
    Buffer.from(data.pageAccessTokenIv, "base64")
  );
  decipher.setAuthTag(Buffer.from(data.pageAccessTokenTag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(data.pageAccessTokenEncrypted, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

export async function getPageCredentials() {
  const snapshot = await CREDENTIALS_REF().get();
  if (!snapshot.exists) throw new Error("Facebook Page is not connected");
  const data = snapshot.data();
  if (!data.pageId) throw new Error("Facebook Page ID is missing");
  return { pageId: data.pageId, pageName: data.pageName || null, accessToken: decryptPageToken(data) };
}

function graphUrl(path) {
  return `https://graph.facebook.com/${GRAPH_VERSION}/${String(path).replace(/^\/+/, "")}`;
}

/**
 * Low-level Graph API request with bounded exponential backoff for transient errors.
 * For DELETE requests, pass method: "DELETE". All requests use server-side Page credentials.
 */
export async function graphRequest(path, { params = {}, method = "GET", accessToken, retries = 3 } = {}) {
  const token = accessToken || (await getPageCredentials()).accessToken;
  const verb = String(method).toUpperCase();
  let lastError;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const url = new URL(graphUrl(path));
      const options = { method: verb, headers: {} };
      if (verb === "GET" || verb === "DELETE") {
        for (const [key, value] of Object.entries(params || {})) {
          if (value !== undefined && value !== null) {
            url.searchParams.set(key, typeof value === "object" ? JSON.stringify(value) : String(value));
          }
        }
        url.searchParams.set("access_token", token);
      } else {
        options.headers["content-type"] = "application/json";
        options.body = JSON.stringify({ ...params, access_token: token });
      }

      const response = await fetch(url, options);
      const payload = await response.json().catch(() => ({}));
      if (response.ok && !payload.error) return payload;

      const error = payload.error || {};
      const retryable = response.status === 429 || response.status >= 500 ||
        [1, 2, 4, 17, 32, 613].includes(Number(error.code));
      const err = new Error(error.message || `Meta Graph API returned HTTP ${response.status}`);
      err.status = response.status;
      err.code = error.code;
      err.isTransient = retryable;
      if (!retryable || attempt === retries) throw err;
      lastError = err;
    } catch (error) {
      if (!error.isTransient || attempt === retries) throw error;
      lastError = error;
    }
    const delay = Math.min(8000, 400 * (2 ** attempt)) + Math.floor(Math.random() * 200);
    await sleep(delay);
  }
  throw lastError || new Error("Meta Graph API request failed");
}

export async function getLiveAndScheduledPosts() {
  const { pageId, accessToken } = await getPageCredentials();
  const [live, scheduled] = await Promise.all([
    graphRequest(`${pageId}/posts`, {
      accessToken, params: { fields: "id,message,created_time,permalink_url,full_picture", limit: 25 },
    }),
    graphRequest(`${pageId}/scheduled_posts`, {
      accessToken, params: { fields: "id,message,scheduled_publish_time,permalink_url", limit: 25 },
    }),
  ]);
  return { live: live.data || [], scheduled: scheduled.data || [] };
}

async function uploadPhoto({ pageId, accessToken, imageUrl, scheduledPublishTime }) {
  // Meta requires a publicly fetchable image URL for url-based photo upload.
  const photo = await graphRequest(`${pageId}/photos`, {
    accessToken,
    method: "POST",
    params: { url: imageUrl, published: false },
  });
  const attachedMedia = JSON.stringify([{ media_fbid: photo.id }]);
  const postParams = { attached_media: attachedMedia };
  if (scheduledPublishTime) {
    postParams.published = false;
    postParams.scheduled_publish_time = Math.floor(new Date(scheduledPublishTime).getTime() / 1000);
  }
  return graphRequest(`${pageId}/feed`, { accessToken, method: "POST", params: postParams });
}

export async function publishOrSchedulePost({ message = "", scheduledPublishTime = null, imageUrl = null } = {}) {
  const { pageId, accessToken } = await getPageCredentials();
  const text = String(message).trim();
  if (!text && !imageUrl) throw new Error("A post must include message text or an image URL");

  let scheduleTimestamp = null;
  if (scheduledPublishTime) {
    const date = new Date(scheduledPublishTime);
    if (!Number.isFinite(date.getTime())) throw new Error("scheduledPublishTime is invalid");
    const minimum = Date.now() + 10 * 60 * 1000;
    if (date.getTime() < minimum) throw new Error("Scheduled posts must be at least 10 minutes in the future");
    scheduleTimestamp = Math.floor(date.getTime() / 1000);
  }

  let result;
  if (imageUrl) {
    // Publish image as a page photo, then create the feed post with attached_media.
    // If the image-upload flow fails, propagate the error so the caller can log a text-only fallback.
    const photo = await graphRequest(`${pageId}/photos`, {
      accessToken, method: "POST", params: { url: imageUrl, published: false },
    });
    const params = { message: text, attached_media: JSON.stringify([{ media_fbid: photo.id }]) };
    if (scheduleTimestamp) {
      params.published = false;
      params.scheduled_publish_time = scheduleTimestamp;
    }
    result = await graphRequest(`${pageId}/feed`, { accessToken, method: "POST", params });
  } else {
    const params = { message: text };
    if (scheduleTimestamp) {
      params.published = false;
      params.scheduled_publish_time = scheduleTimestamp;
    }
    result = await graphRequest(`${pageId}/feed`, { accessToken, method: "POST", params });
  }

  return { id: result.id || null, scheduledPublishTime: scheduleTimestamp, raw: result };
}

export async function replyToComment(commentId, message) {
  if (!commentId || !String(message || "").trim()) throw new Error("commentId and message are required");
  return graphRequest(`${encodeURIComponent(commentId)}/comments`, {
    method: "POST", params: { message: String(message).trim() },
  });
}

export async function moderateComment(commentId, action) {
  if (!commentId || !["hide", "unhide", "delete"].includes(action)) {
    throw new Error('commentId and action ("hide"|"unhide"|"delete") are required');
  }
  if (action === "delete") return graphRequest(encodeURIComponent(commentId), { method: "DELETE" });
  return graphRequest(encodeURIComponent(commentId), {
    method: "POST", params: { is_hidden: action === "hide" },
  });
}

export async function sendInboxMessage(recipientId, text) {
  const message = String(text || "").trim();
  if (!recipientId || !message) throw new Error("recipientId and text are required");
  return graphRequest("me/messages", {
    method: "POST",
    params: { recipient: { id: String(recipientId) }, message: { text: message } },
  });
}

export async function getRecentPagePosts(limit = 10) {
  const { pageId, accessToken } = await getPageCredentials();
  const result = await graphRequest(`${pageId}/posts`, {
    accessToken,
    params: { fields: "id,message,created_time,shares,comments.limit(0).summary(true),likes.limit(0).summary(true)", limit: Math.min(25, Math.max(1, Number(limit) || 10)) },
  });
  return result.data || [];
}

// Compatibility aliases used by some endpoint modules.
export const facebookRequest = graphRequest;
export const requestGraphApi = graphRequest;
