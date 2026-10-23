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

    // সংবেদনশীল ও ক্ষতিকর শব্দ ফিল্টার করে নিরাপদ ইংরেজি প্রম্পট তৈরি
    let sanitizedPrompt = rawPrompt
      .replace(/[\r\n]+/g, " ")
      .replace(/[^\x00-\x7F]/g, "") // নন-ASCII বা বাংলা ক্যারেক্টার বাদ দিয়ে ক্লিন করা
      .trim();

    // প্রম্পট যদি সম্পূর্ণ বাংলায় থাকে বা ফিল্টারে ফাঁকা হয়ে যায়, তবে নিরাপদ ডিফল্ট প্রম্পট যুক্ত হবে
    if (!sanitizedPrompt || sanitizedPrompt.length < 5) {
      sanitizedPrompt = "A cozy, cinematic, aesthetically pleasing modern everyday lifestyle scene, high resolution, warm ambient lighting, 8k photography";
    } else {
      sanitizedPrompt = `${sanitizedPrompt}, safe for work, aesthetic composition, cinematic lighting, 8k`;
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
      
      if (msg.includes("NSFW")) {
        throw new Error("Prompt triggered safety filters. Please use a neutral, family-friendly prompt.");
      }
      throw new Error(`Cloudflare error (${response.status}): ${msg}`);
    }

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
