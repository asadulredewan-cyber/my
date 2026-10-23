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

    const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
    const apiToken = process.env.CLOUDFLARE_API_TOKEN;
    const model = process.env.CLOUDFLARE_IMAGE_MODEL || "@cf/black-forest-labs/flux-1-schnell";

    if (!accountId || !apiToken) {
      throw new Error("CLOUDFLARE_ACCOUNT_ID or CLOUDFLARE_API_TOKEN is missing in environment variables");
    }

    // Cloudflare Workers AI endpoint
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${model}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiToken}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          prompt: prompt,
          steps: 4
        })
      }
    );

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Cloudflare AI failed (${response.status}): ${errText}`);
    }

    // Cloudflare সরাসরি বাইনারি ডেটা রিটার্ন করে, যা Base64 Data URI-তে রূপান্তর করা হচ্ছে
    const arrayBuffer = await response.arrayBuffer();
    const b64 = Buffer.from(arrayBuffer).toString("base64");
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
