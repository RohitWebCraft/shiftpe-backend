const { q } = require('../db');
let admin = null;
try {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    admin = require('firebase-admin'); // npm i firebase-admin to enable real push
    admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
  }
} catch (e) { console.warn('FCM disabled:', e.message); admin = null; }

async function push(userIds, { title, body, data = {} }) {
  if (!userIds.length) return 0;
  const { rows } = await q('SELECT token FROM device_tokens WHERE user_id = ANY($1)', [userIds]);
  const tokens = rows.map((r) => r.token);
  if (!admin) { console.log(`[push:dev] to ${userIds.length} users: ${title} - ${body}`); return userIds.length; }
  if (tokens.length) await admin.messaging().sendEachForMulticast({ tokens, notification: { title, body }, data });
  return userIds.length;
}

// Urgent Hiring mode: ping nearby, available, trusted students (max 3 pings per student per day).
async function notifyNearbyStudents(job, bizName) {
  const radius = (Number(process.env.URGENT_RADIUS_KM) || 3) * 1000;
  const { rows } = await q(
    `SELECT sp.user_id FROM student_profiles sp
      WHERE sp.available_now AND sp.rating >= $3
        AND ST_DWithin(sp.location, (SELECT location FROM jobs WHERE id=$1), $2)
        AND (cardinality($4::text[]) = 0 OR sp.skills && $4::text[])
        AND (SELECT COUNT(*) FROM notifications n WHERE n.user_id=sp.user_id AND n.sent_at > now() - interval '1 day') < 3
      LIMIT 100`,
    [job.id, radius, Number(process.env.MIN_STUDENT_TRUST) || 4.2, job.skills]);
  const ids = rows.map((r) => r.user_id);
  if (ids.length) await q('INSERT INTO notifications(user_id, job_id) SELECT unnest($1::bigint[]), $2', [ids, job.id]);
  await push(ids, { title: '⚡ Urgent shift nearby', body: `${bizName || 'A business'} needs ${job.title} (₹${job.pay}). Tap to claim.`, data: { jobId: String(job.id) } });
  return ids.length;
}
module.exports = { push, notifyNearbyStudents };
