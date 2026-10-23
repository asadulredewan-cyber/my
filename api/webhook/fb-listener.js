import * as Firebase from "../../lib/firebase-admin.js";
import * as Facebook from "../../lib/facebook.js";
import * as Gemini from "../../lib/gemini.js";
import { createHmac, timingSafeEqual, createDecipheriv } from "node:crypto";

const send = (res,status,body) => res.status(status).json(body);
const dbClient = () => Firebase.db || Firebase.firestore || Firebase.default?.db || Firebase.default?.firestore || Firebase.admin?.firestore?.() || Firebase.default?.firestore?.();
function validSignature(req) {
  const secret = process.env.META_APP_SECRET; const header = req.headers["x-hub-signature-256"];
  if (!secret || !header || !req.body) return false;
  const raw = typeof req.body === "string" ? req.body : JSON.stringify(req.body);
  const expected = "sha256=" + createHmac("sha256",secret).update(raw).digest("hex");
  try { return timingSafeEqual(Buffer.from(header),Buffer.from(expected)); } catch { return false; }
}
function decryptToken(doc) {
  const keyHex=process.env.TOKEN_ENCRYPTION_KEY||""; if(!/^[0-9a-fA-F]{64}$/.test(keyHex)) throw new Error("TOKEN_ENCRYPTION_KEY must be 32-byte hex");
  const d=doc.data(), x=createDecipheriv("aes-256-gcm",Buffer.from(keyHex,"hex"),Buffer.from(d.pageAccessTokenIv,"base64"));
  x.setAuthTag(Buffer.from(d.pageAccessTokenTag,"base64"));
  return Buffer.concat([x.update(Buffer.from(d.pageAccessTokenEncrypted,"base64")),x.final()]).toString("utf8");
}
async function graph(path, token, body) {
  const helper=Facebook.graphRequest||Facebook.facebookRequest||Facebook.requestGraphApi;
  if(helper) return helper(path,{accessToken:token,params:body,method:"POST"});
  const u=`https://graph.facebook.com/${process.env.META_GRAPH_VERSION||"v26.0"}/${path.replace(/^\/+/,"")}`;
  const r=await fetch(u,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({...body,access_token:token})});
  const d=await r.json().catch(()=>({})); if(!r.ok||d.error) throw new Error(d.error?.message||"Graph API failed"); return d;
}
async function ai(prompt) {
  const fn=Gemini.generateText||Gemini.generateContent||Gemini.generateCaption||Gemini.default;
  if(!fn) throw new Error("No supported text-generation function exported by lib/gemini.js");
  const out=await fn(prompt,{model:process.env.GEMINI_MODEL||"gemini-2.5-flash"});
  return typeof out==="string"?out:(out.text||out.response?.text||out.candidates?.[0]?.content?.parts?.map(p=>p.text).join("")||"");
}
export default async function handler(req,res) {
  if(req.method==="GET") {
    const q=req.query||{}, mode=q["hub.mode"], token=q["hub.verify_token"], challenge=q["hub.challenge"];
    if(mode==="subscribe" && token && token===process.env.META_WEBHOOK_VERIFY_TOKEN) return res.status(200).send(String(challenge||""));
    return send(res,403,{success:false,data:null,error:"Webhook verification failed"});
  }
  if(req.method!=="POST") return send(res,405,{success:false,data:null,error:"Method not allowed"});
  if(!validSignature(req)) return send(res,401,{success:false,data:null,error:"Invalid Meta webhook signature"});
  // Acknowledge promptly; Vercel functions continue processing only within their execution window.
  res.status(200).json({success:true,data:{received:true},error:null});
  try {
    const db=dbClient(); if(!db?.collection) return;
    const creds=await db.collection("settings").doc("meta_credentials").get(); if(!creds.exists) return;
    const c=creds.data(), pageToken=decryptToken(creds), pageId=c.pageId;
    const body=req.body||{};
    for(const entry of body.entry||[]) {
      for(const change of entry.changes||[]) {
        if(change.field!=="feed") continue;
        const v=change.value||{}, commentId=v.comment_id||v.id, message=String(v.message||"").trim();
        if(!commentId||!message) continue;
        const verdict=(await ai(`Classify this Facebook comment for moderation. Return JSON only: {"toxic":boolean,"languageKnown":boolean,"reply":"short respectful reply or empty if unsafe"}. Text: ${message}`));
        let parsed={toxic:false,languageKnown:true,reply:""};
        try { parsed=JSON.parse(verdict.replace(/^```json|```$/g,"").trim()); } catch {}
        if(parsed.toxic || parsed.languageKnown===false) {
          if(parsed.toxic) await graph(`${commentId}`,pageToken,{is_hidden:true}).catch(()=>{});
          await db.collection("flagged_items").add({type:parsed.toxic?"toxic_comment":"unknown_language",itemId:commentId,text:message,reason:parsed.toxic?"abusive":"unknown_language",status:"pending",createdAt:new Date().toISOString()});
        } else if(parsed.reply) await graph(`${commentId}/comments`,pageToken,{message:parsed.reply}).catch(()=>{});
      }
      for(const msg of entry.messaging||[]) {
        const message=msg.message, sender=msg.sender?.id, page=msg.recipient?.id;
        if(!message?.text||!sender||sender===page) continue;
        const result=await ai(`Write a brief, safe, helpful reply to this Facebook Page inbox message. If it is abusive, threatening, or unclear, return exactly FLAG. Message: ${message.text}`);
        if(!result || result.trim()==="FLAG") {
          await db.collection("flagged_items").add({type:"flagged_message",itemId:sender,text:message.text,reason:"needs_review",status:"pending",createdAt:new Date().toISOString()}); continue;
        }
        await graph("me/messages",pageToken,{recipient:{id:sender},message:{text:result.trim()}});
      }
    }
  } catch (e) { console.error("Meta webhook processing error:",e.message); }
}
