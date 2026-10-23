import { db } from '../../lib/firebase-admin.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  try {
    // Firestore থেকে মেটা পেজ ক্রেডেনশিয়াল চেক করা
    let pageConnected = false;
    let pageName = "Not Connected";
    let tokenStatus = "missing";

    try {
      const metaDoc = await db.collection('settings').doc('meta_credentials').get();
      if (metaDoc.exists) {
        const data = metaDoc.data();
        
        // এখানে pageAccessTokenEncrypted চেক করা হয়েছে
        if (data && (data.pageAccessTokenEncrypted || data.pageAccessToken)) {
          pageConnected = true;
          pageName = data.pageName || "Active Facebook Page";
          tokenStatus = "valid";
        }
      }
    } catch (e) {
      console.warn("Could not fetch meta credentials:", e.message);
    }

    // আজকের তারিখ অনুযায়ী পোস্ট কাউন্ট ফেচ
    const todayStr = new Date().toISOString().split('T')[0];
    let dailyUsed = 0;
    try {
      const postsSnapshot = await db.collection('scheduled_posts')
        .where('publishedDate', '==', todayStr)
        .get();
      dailyUsed = postsSnapshot.size;
    } catch (e) {
      // ignore
    }

    return res.status(200).json({
      success: true,
      data: {
        stats: {
          dailyUsed: dailyUsed,
          dailyCap: 5,
          firebaseQueue: 0,
          flaggedMessages: 0,
          toxicComments: 0,
          publishedToday: dailyUsed
        },
        page: {
          name: pageName,
          connected: pageConnected,
          tokenStatus: tokenStatus
        },
        system: {
          cron: "active",
          gemini: "ready",
          cronDetail: "Cron active (BST schedule)",
          geminiDetail: "gemini-3.6-flash ready"
        }
      }
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message || 'Failed to fetch dashboard summary'
    });
  }
}
