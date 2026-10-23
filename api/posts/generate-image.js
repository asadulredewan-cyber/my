import { verifyAdmin } from "../auth/verify-admin.js";

const send = (res, s, b) => res.status(s).json(b);

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return send(res, 405, { success: false, data: null, error: "Method not allowed" });
  }
  if (!await verifyAdmin(req, res)) return;

  try {
    const prompt = String(req.body?.prompt || "").trim();
    if (!prompt || prompt.length > 2000) {
      return send(res, 400, { success: false, data: null, error: "prompt is required and must be at most 2000 characters" });
    }

    const key = process.env.GEMINI_API_KEY || process.env.GOOGLE_CLOUD_API_KEY;
    if (!key) {
      throw new Error("GEMINI_API_KEY is not configured in environment variables");
    }

    // Google AI Imagen REST API (বিদ্যমান GEMINI_API_KEY দিয়েই কাজ করবে)
    const imagenUrl = `https://generativelanguage.googleapis.com/v1beta/models/imagen-3.0-generate-002:predict?key=${key}`;

    const response = await fetch(imagenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        instances: [{ prompt }],
        parameters: {
          sampleCount: 1,
          aspectRatio: "1:1",
          outputMimeType: "image/jpeg"
        }
      })
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.error) {
      throw new Error(data.error?.message || `Imagen request failed (${response.status})`);
    }

    const b64 = data.predictions?.[0]?.bytesBase64Encoded;
    if (!b64) throw new Error("No image data returned from model");

    // কোনো আলাদা ক্লাউড স্টোরেজ ছাড়া সরাসরি Data URI ফরম্যাট
    const imageUrl = `data:image/jpeg;base64,${b64}`;

    return send(res, 200, {
      success: true,
      url: imageUrl,
      imageUrl: imageUrl,
      data: { url: imageUrl, imageUrl: imageUrl },
      images: [{ url: imageUrl, mimeType: "image/jpeg" }],
      error: null
    });
  } catch (e) {
    return send(res, 500, { success: false, data: null, error: e.message || "Image generation failed" });
  }
}
