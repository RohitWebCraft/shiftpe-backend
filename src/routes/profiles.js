const router = require('express').Router();
const { q } = require('../db');
const { requireAuth, requireRole, wrap } = require('../lib/auth');
const { BADGE_NAMES } = require('../lib/matching');

router.get('/students/me', requireAuth, requireRole('student'), wrap(async (req, res) => {
  const { rows: [p] } = await q(
    `SELECT u.name, sp.age, sp.college, sp.skills, sp.available_now, sp.rating, sp.ontime_pct, sp.cancels
       FROM users u JOIN student_profiles sp ON sp.user_id=u.id WHERE u.id=$1`, [req.user.id]);
  const { rows: prog } = await q('SELECT category, completed, badge_at FROM skill_progress WHERE student_id=$1', [req.user.id]);
  res.json({ ...p, skillProgress: prog.map((x) => ({ ...x, badge: BADGE_NAMES[x.category], unlocked: !!x.badge_at, target: 10 })) });
}));

router.put('/students/me', requireAuth, requireRole('student'), wrap(async (req, res) => {
  const { name, age, college, skills = [], lat, lng, availableNow } = req.body;
  if (age !== undefined && Number(age) < 18) return res.status(403).json({ error: 'ShiftPe is for users 18 and above' });
  await q('UPDATE users SET name=COALESCE($2,name) WHERE id=$1', [req.user.id, name]);
  await q(
    `UPDATE student_profiles SET age=COALESCE($2,age), college=COALESCE($3,college), skills=$4,
       available_now=COALESCE($5,available_now),
       location = CASE WHEN $6::float8 IS NULL THEN location ELSE ST_SetSRID(ST_MakePoint($7::float8,$6::float8),4326)::geography END
     WHERE user_id=$1`, [req.user.id, age, college, skills, availableNow, lat ?? null, lng ?? null]);
  res.json({ ok: true });
}));

router.post('/device-token', requireAuth, wrap(async (req, res) => {
  await q('INSERT INTO device_tokens(user_id, token) VALUES ($1,$2) ON CONFLICT DO NOTHING', [req.user.id, req.body.token]);
  res.json({ ok: true });
}));

router.get('/businesses/me', requireAuth, requireRole('business'), wrap(async (req, res) => {
  const { rows: [b] } = await q(
    `SELECT u.name, b.rating, b.free_listings_left, b.plan_expires FROM users u JOIN businesses b ON b.user_id=u.id WHERE u.id=$1`, [req.user.id]);
  res.json(b);
}));

router.put('/businesses/me', requireAuth, requireRole('business'), wrap(async (req, res) => {
  const { name, lat, lng } = req.body;
  await q('UPDATE users SET name=COALESCE($2,name) WHERE id=$1', [req.user.id, name]);
  if (lat != null && lng != null)
    await q('UPDATE businesses SET location=ST_SetSRID(ST_MakePoint($2,$3),4326)::geography WHERE user_id=$1', [req.user.id, lng, lat]);
  res.json({ ok: true });
}));

// DEV ONLY stand-in for Razorpay webhook: activates a 30-day membership.
router.post('/billing/dev-activate', requireAuth, requireRole('business'), wrap(async (req, res) => {
  if (process.env.NODE_ENV === 'production') return res.status(404).end();
  await q(`UPDATE businesses SET plan_expires = now() + interval '30 days' WHERE user_id=$1`, [req.user.id]);
  res.json({ ok: true });
}));
module.exports = router;
