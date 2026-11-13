// src/routes/extra.js : the business can swipe on workers (invite them), and workers answer invites.
const router = require('express').Router();
const { q } = require('../db');
const { requireAuth, requireRole, wrap } = require('../lib/auth');
const { matchScore } = require('../lib/matching');
const { push } = require('../lib/notify');
const MIN_STU = () => Number(process.env.MIN_STUDENT_TRUST) || 4.2;

async function ownJob(req, jobId) {
  const { rows: [j] } = await q(`SELECT id, title, category, skills FROM jobs WHERE id=$1 AND business_id=$2 AND status='open'`, [jobId, req.user.id]);
  return j;
}

// Business: its own open shifts (so "My shifts" and "Find workers" work from any phone or browser).
router.get('/jobs/mine', requireAuth, requireRole('business'), wrap(async (req, res) => {
  const { rows } = await q(
    `SELECT id, title, category, pay, hours_text, urgent, status, created_at
       FROM jobs WHERE business_id = $1 AND status = 'open' ORDER BY id DESC`, [req.user.id]);
  res.json(rows);
}));

// Business: nearby workers for one of its open shifts (hides low-trust workers, and those already invited or matched).
router.get('/workers/feed', requireAuth, requireRole('business'), wrap(async (req, res) => {
  const radiusKm = Math.min(Number(req.query.radiusKm) || 10, 100);
  const j = await ownJob(req, req.query.jobId);
  if (!j) return res.status(404).json({ error: 'Job not found' });
  const minTrust = req.query.minTrust !== undefined ? Number(req.query.minTrust) : MIN_STU();
  const { rows } = await q(
    `SELECT u.id, u.name, sp.college, sp.age, sp.skills, sp.rating, sp.ontime_pct, sp.cancels, sp.available_now,
            ST_Distance(sp.location, jb.location) / 1000 AS dist_km,
            EXISTS (SELECT 1 FROM skill_progress k WHERE k.student_id = u.id AND k.category = $2 AND k.badge_at IS NOT NULL) AS has_badge
       FROM student_profiles sp
       JOIN users u ON u.id = sp.user_id
       JOIN jobs jb ON jb.id = $1
      WHERE sp.location IS NOT NULL AND u.name <> '' AND u.name <> 'Deleted user' AND sp.rating >= $3
        AND ST_DWithin(sp.location, jb.location, $4)
        AND NOT EXISTS (SELECT 1 FROM invites i WHERE i.job_id = $1 AND i.student_id = u.id)
        AND NOT EXISTS (SELECT 1 FROM matches m WHERE m.job_id = $1 AND m.student_id = u.id)
      LIMIT 100`, [j.id, j.category, minTrust, radiusKm * 1000]);
  const feed = rows.map((w) => ({
    ...w, dist_km: Number(w.dist_km),
    match_score: matchScore({ distKm: Number(w.dist_km), radiusKm, studentSkills: w.skills, jobSkills: j.skills, hasBadge: w.has_badge, bizRating: Number(w.rating) }),
  })).sort((a, b) => (b.available_now - a.available_now) || (b.has_badge - a.has_badge) || (b.match_score - a.match_score));
  res.json(feed);
}));

// Business swipes a worker: like = invite (instant match if the worker already liked that shift), pass = skip.
router.post('/workers/:studentId/swipe', requireAuth, requireRole('business'), wrap(async (req, res) => {
  const { jobId, direction } = req.body;
  if (!['like', 'pass'].includes(direction)) return res.status(400).json({ error: 'direction must be like or pass' });
  const j = await ownJob(req, jobId);
  if (!j) return res.status(404).json({ error: 'Job not found' });
  const sid = req.params.studentId;
  if (direction === 'pass') {
    await q(`INSERT INTO invites(job_id, student_id, business_id, status) VALUES ($1,$2,$3,'passed') ON CONFLICT DO NOTHING`, [j.id, sid, req.user.id]);
    return res.json({ ok: true });
  }
  const { rows: [liked] } = await q(`SELECT 1 FROM swipes WHERE job_id=$1 AND student_id=$2 AND direction='like'`, [j.id, sid]);
  if (liked) {
    const { rows: [m] } = await q(`INSERT INTO matches(job_id, student_id, business_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING id`, [j.id, sid, req.user.id]);
    await q(`INSERT INTO invites(job_id, student_id, business_id, status) VALUES ($1,$2,$3,'accepted') ON CONFLICT (job_id, student_id) DO UPDATE SET status='accepted'`, [j.id, sid, req.user.id]);
    if (m) await push([Number(sid)], { title: "It's a Shift Match!", body: `You matched for "${j.title}". Open chat.`, data: { matchId: String(m.id) } });
    return res.status(201).json({ matched: true, matchId: m ? m.id : null });
  }
  await q(`INSERT INTO invites(job_id, student_id, business_id, status) VALUES ($1,$2,$3,'pending') ON CONFLICT DO NOTHING`, [j.id, sid, req.user.id]);
  await push([Number(sid)], { title: 'A shop invited you', body: `Invite for "${j.title}"`, data: { jobId: String(j.id) } });
  res.status(201).json({ matched: false });
}));

// Worker: pending invites from shops.
router.get('/invites', requireAuth, requireRole('student'), wrap(async (req, res) => {
  const { rows } = await q(
    `SELECT i.job_id, j.title, j.category, j.pay, j.hours_text, u.name AS business_name, b.rating AS business_rating
       FROM invites i
       JOIN jobs j ON j.id = i.job_id AND j.status = 'open'
       JOIN businesses b ON b.user_id = i.business_id
       JOIN users u ON u.id = i.business_id
      WHERE i.student_id = $1 AND i.status = 'pending'
      ORDER BY i.created_at DESC`, [req.user.id]);
  res.json(rows);
}));

router.post('/invites/:jobId/accept', requireAuth, requireRole('student'), wrap(async (req, res) => {
  const { rows: [i] } = await q(
    `SELECT i.business_id, j.title FROM invites i JOIN jobs j ON j.id = i.job_id AND j.status = 'open'
      WHERE i.job_id=$1 AND i.student_id=$2 AND i.status='pending'`, [req.params.jobId, req.user.id]);
  if (!i) return res.status(404).json({ error: 'Invite not found' });
  let { rows: [m] } = await q(`INSERT INTO matches(job_id, student_id, business_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING id`, [req.params.jobId, req.user.id, i.business_id]);
  if (!m) ({ rows: [m] } = await q(`SELECT id FROM matches WHERE job_id=$1 AND student_id=$2`, [req.params.jobId, req.user.id]));
  await q(`UPDATE invites SET status='accepted' WHERE job_id=$1 AND student_id=$2`, [req.params.jobId, req.user.id]);
  await push([i.business_id], { title: 'Invite accepted', body: `A worker accepted "${i.title}". Open chat.`, data: { matchId: String(m.id) } });
  res.status(201).json({ matchId: m.id });
}));

router.post('/invites/:jobId/decline', requireAuth, requireRole('student'), wrap(async (req, res) => {
  await q(`UPDATE invites SET status='declined' WHERE job_id=$1 AND student_id=$2 AND status='pending'`, [req.params.jobId, req.user.id]);
  res.json({ ok: true });
}));

module.exports = router;
