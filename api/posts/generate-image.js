import { verifyAdmin } from "../auth/verify-admin.js";

const send = (res, s, b) => res.status(s).json(b);

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return send(res, 405, { success: false, data: null, error: "Method not allowed" });
  }
  if (!await verifyAdmin(req, res)) return;

  try {
    let rawPrompt = String(req.body?.prompt || "").trim();
    if (!rawPrompt || rawPrompt.length > 2000) {
      return send(res, 400, { success: false, data: null, error: "prompt is required" });
    }

    const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
    const apiToken = process.env.CLOUDFLARE_API_TOKEN;
    const model = process.env.CLOUDFLARE_IMAGE_MODEL || "@cf/black-forest-labs/flux-1-schnell";

    if (!accountId || !apiToken) {
      throw new Error("CLOUDFLARE_ACCOUNT_ID or CLOUDFLARE_API_TOKEN is missing in environment variables");
    }

    let sanitizedPrompt = rawPrompt
      .replace(/[\r\n]+/g, " ")
      .replace(/[^\x00-\x7F]/g, "")
      .trim();

    if (!sanitizedPrompt || sanitizedPrompt.length < 5) {
      sanitizedPrompt = "A cozy, cinematic, aesthetic landscape, high resolution, 8k photography";
    }

    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${model}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiToken}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          prompt: sanitizedPrompt,
          steps: 4
        })
      }
    );

    if (!response.ok) {
      const errText = await response.text();
      let msg = errText;
      try {
        const parsed = JSON.parse(errText);
        msg = parsed.errors?.[0]?.message || errText;
      } catch (_) {}
      throw new Error(`Cloudflare error (${response.status}): ${msg}`);
    }

    const contentType = response.headers.get("content-type") || "";
    let b64 = "";

    // Cloudflare JSON { result: { image: "..." } } পাঠালে তা সরাসরি নেওয়া হচ্ছে
    if (contentType.includes("application/json")) {
      const json = await response.json();
      b64 = json.result?.image || json.image || "";
    } else {
      // বাইনারি পাঠালে Buffer থেকে Base64 করা হচ্ছে
      const arrayBuffer = await response.arrayBuffer();
      const rawText = Buffer.from(arrayBuffer).toString("utf8");
      
      // সেফটি চেক: যদি বাফারের ভেতর লুকানো JSON থাকে
      if (rawText.trim().startsWith("{")) {
        try {
          const parsed = JSON.parse(rawText);
          b64 = parsed.result?.image || parsed.image || "";
        } catch (_) {
          b64 = Buffer.from(arrayBuffer).toString("base64");
        }
      } else {
        b64 = Buffer.from(arrayBuffer).toString("base64");
      }
    }

    if (!b64) throw new Error("Could not extract image data from Cloudflare response");

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
    return send(res, 500, { success: false, data: null, error: e.message || "Cloudflare image generation failed" });
  }
}
