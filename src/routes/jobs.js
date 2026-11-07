const router = require('express').Router();
const { q } = require('../db');
const { requireAuth, requireRole, wrap } = require('../lib/auth');
const { matchScore, BADGE_BONUS } = require('../lib/matching');
const { notifyNearbyStudents, push } = require('../lib/notify');
const MIN_STU = () => Number(process.env.MIN_STUDENT_TRUST) || 4.2;
const MIN_BIZ = () => Number(process.env.MIN_BUSINESS_TRUST) || 3.5;
const CATS = ['kirana','sweets','salon','cafe','sales','mobile','medical','event','edit','tuition','delivery','office','tourism'];

// Business posts a shift. First 2 listings are free, then an active membership is required.
router.post('/', requireAuth, requireRole('business'), wrap(async (req, res) => {
  const { title, category, description = '', pay, hoursText = '', skills = [], urgent = false, lat, lng } = req.body;
  if (!title || !CATS.includes(category) || !(Number(pay) >= 0)) return res.status(400).json({ error: 'title, category and pay are required' });
  const { rows: [b] } = await q(
    `SELECT free_listings_left, plan_expires > now() AS paid, location IS NOT NULL AS has_loc FROM businesses WHERE user_id=$1`, [req.user.id]);
  if (!b.has_loc && (lat == null || lng == null)) return res.status(400).json({ error: 'Set your shop location first' });
  if (!b.paid) {
    const { rowCount } = await q('UPDATE businesses SET free_listings_left = free_listings_left - 1 WHERE user_id=$1 AND free_listings_left > 0', [req.user.id]);
    if (!rowCount) return res.status(402).json({ error: 'Free listings used. Membership and listing charges apply.' });
  }
  const { rows: [job] } = await q(
    `INSERT INTO jobs(business_id,title,category,description,pay,hours_text,skills,urgent,location)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8, CASE WHEN $9::float8 IS NULL THEN (SELECT location FROM businesses WHERE user_id=$1)
                                            ELSE ST_SetSRID(ST_MakePoint($10::float8,$9::float8),4326)::geography END)
     RETURNING id, title, pay, skills, urgent`,
    [req.user.id, title, category, description, pay, hoursText, skills, !!urgent, lat ?? null, lng ?? null]);
  let notified = 0;
  if (job.urgent) {
    const { rows: [u] } = await q('SELECT name FROM users WHERE id=$1', [req.user.id]);
    notified = await notifyNearbyStudents(job, u.name);
  }
  res.status(201).json({ job, notifiedStudents: notified });
}));

// Student swipe deck: nearby open jobs, hides low-trust businesses, ranked by match score.
router.get('/feed', requireAuth, requireRole('student'), wrap(async (req, res) => {
  const radiusKm = Math.min(Number(req.query.radiusKm) || 5, 25);
  const { rows: [sp] } = await q('SELECT skills, location IS NOT NULL AS has_loc FROM student_profiles WHERE user_id=$1', [req.user.id]);
  if (!sp.has_loc) return res.status(400).json({ error: 'Set your location first' });
  const { rows: badges } = await q('SELECT category FROM skill_progress WHERE student_id=$1 AND badge_at IS NOT NULL', [req.user.id]);
  const badgeCats = badges.map((b) => b.category);
  const { rows } = await q(
    `SELECT j.id, j.title, j.category, j.description, j.pay, j.hours_text, j.skills, j.urgent,
            u.name AS business_name, b.rating AS business_rating,
            ST_Distance(j.location, sp.location) / 1000 AS dist_km
       FROM jobs j
       JOIN businesses b ON b.user_id = j.business_id
       JOIN users u ON u.id = b.user_id
       JOIN student_profiles sp ON sp.user_id = $1
      WHERE j.status='open' AND b.rating >= $2 AND ST_DWithin(j.location, sp.location, $3)
        AND NOT EXISTS (SELECT 1 FROM swipes s WHERE s.job_id=j.id AND s.student_id=$1)
      LIMIT 100`, [req.user.id, MIN_BIZ(), radiusKm * 1000]);
  const feed = rows.map((j) => {
    const hasBadge = badgeCats.includes(j.category);
    return {
      ...j, dist_km: Math.round(j.dist_km * 10) / 10,
      effective_pay: hasBadge ? Math.round(j.pay * (1 + BADGE_BONUS)) : j.pay, badge_bonus: hasBadge,
      match_score: matchScore({ distKm: j.dist_km, radiusKm, studentSkills: sp.skills, jobSkills: j.skills, hasBadge, bizRating: Number(j.business_rating) }),
    };
  }).sort((a, b) => (b.urgent - a.urgent) || (b.match_score - a.match_score));
  res.json(feed);
}));

router.post('/:id/swipe', requireAuth, requireRole('student'), wrap(async (req, res) => {
  const { direction } = req.body;
  if (!['like', 'pass', 'save'].includes(direction)) return res.status(400).json({ error: 'direction must be like, pass or save' });
  await q(`INSERT INTO swipes(student_id, job_id, direction) VALUES ($1,$2,$3)
           ON CONFLICT (student_id, job_id) DO UPDATE SET direction=EXCLUDED.direction`, [req.user.id, req.params.id, direction]);
  res.json({ ok: true });
}));

// Urgent jobs: first-come claim creates a confirmed shift instantly.
router.post('/:id/claim', requireAuth, requireRole('student'), wrap(async (req, res) => {
  const { rows: [j] } = await q(`SELECT id, business_id, title FROM jobs WHERE id=$1 AND urgent AND status='open'`, [req.params.id]);
  if (!j) return res.status(404).json({ error: 'This urgent shift is no longer open' });
  const { rows: [sp] } = await q('SELECT rating FROM student_profiles WHERE user_id=$1', [req.user.id]);
  if (Number(sp.rating) < MIN_STU()) return res.status(403).json({ error: 'Your trust score is too low to claim urgent shifts' });
  const { rows: [m] } = await q(
    `INSERT INTO matches(job_id, student_id, business_id, status) VALUES ($1,$2,$3,'confirmed') ON CONFLICT DO NOTHING RETURNING id`,
    [j.id, req.user.id, j.business_id]);
  if (!m) return res.status(409).json({ error: 'Already claimed' });
  await push([j.business_id], { title: 'Shift claimed', body: `A student claimed "${j.title}".`, data: { matchId: String(m.id) } });
  res.status(201).json({ matchId: m.id });
}));

// Business sees interested students; the reputation filter hides low-trust students.
router.get('/:id/applicants', requireAuth, requireRole('business'), wrap(async (req, res) => {
  const { rows: [j] } = await q('SELECT id, category FROM jobs WHERE id=$1 AND business_id=$2', [req.params.id, req.user.id]);
  if (!j) return res.status(404).json({ error: 'Job not found' });
  const minTrust = req.query.minTrust !== undefined ? Number(req.query.minTrust) : MIN_STU();
  const { rows } = await q(
    `SELECT u.id, u.name, sp.college, sp.skills, sp.rating, sp.ontime_pct, sp.cancels,
            (sk.badge_at IS NOT NULL) AS has_badge
       FROM swipes s JOIN users u ON u.id = s.student_id
       JOIN student_profiles sp ON sp.user_id = u.id
       LEFT JOIN skill_progress sk ON sk.student_id = u.id AND sk.category = $2
      WHERE s.job_id=$1 AND s.direction='like'
        AND NOT EXISTS (SELECT 1 FROM matches m WHERE m.job_id=s.job_id AND m.student_id=s.student_id)`, [j.id, j.category]);
  const visible = rows.filter((r) => Number(r.rating) >= minTrust)
    .sort((a, b) => (b.has_badge - a.has_badge) || (b.rating - a.rating));
  res.json({ applicants: visible, hiddenByReputationFilter: rows.length - visible.length });
}));

// Business accepts a student -> match (chat opens).
router.post('/:id/accept/:studentId', requireAuth, requireRole('business'), wrap(async (req, res) => {
  const { rows: [j] } = await q('SELECT id, title FROM jobs WHERE id=$1 AND business_id=$2', [req.params.id, req.user.id]);
  if (!j) return res.status(404).json({ error: 'Job not found' });
  const { rows: [like] } = await q(`SELECT 1 FROM swipes WHERE job_id=$1 AND student_id=$2 AND direction='like'`, [j.id, req.params.studentId]);
  if (!like) return res.status(400).json({ error: 'This student has not shown interest' });
  const { rows: [m] } = await q(
    `INSERT INTO matches(job_id, student_id, business_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING id`,
    [j.id, req.params.studentId, req.user.id]);
  if (!m) return res.status(409).json({ error: 'Already matched' });
  await push([Number(req.params.studentId)], { title: "It's a Shift Match!", body: `You matched for "${j.title}". Open chat.`, data: { matchId: String(m.id) } });
  res.status(201).json({ matchId: m.id });
}));
module.exports = router;
