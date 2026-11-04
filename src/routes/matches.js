const router = require('express').Router();
const { pool, q } = require('../db');
const { requireAuth, wrap } = require('../lib/auth');
const { recompute } = require('../lib/reputation');
const { BADGE_NAMES } = require('../lib/matching');
const { push } = require('../lib/notify');
router.use(requireAuth);

async function load(req, res) {
  const { rows: [m] } = await q(
    `SELECT m.*, j.category, j.title FROM matches m JOIN jobs j ON j.id=m.job_id WHERE m.id=$1 AND (m.student_id=$2 OR m.business_id=$2)`,
    [req.params.id, req.user.id]);
  if (!m) res.status(404).json({ error: 'Match not found' });
  return m;
}

router.get('/', wrap(async (req, res) => {
  const col = req.user.role === 'student' ? 'student_id' : 'business_id';
  const { rows } = await q(
    `SELECT m.id, m.status, m.created_at, j.title, j.pay, j.category, us.name AS student_name, ub.name AS business_name
       FROM matches m JOIN jobs j ON j.id=m.job_id JOIN users us ON us.id=m.student_id JOIN users ub ON ub.id=m.business_id
      WHERE m.${col}=$1 ORDER BY m.id DESC`, [req.user.id]);
  res.json(rows);
}));

router.get('/:id/messages', wrap(async (req, res) => {
  const m = await load(req, res); if (!m) return;
  const { rows } = await q('SELECT id, sender_id, body, created_at FROM messages WHERE match_id=$1 ORDER BY id', [m.id]);
  res.json(rows);
}));

router.post('/:id/messages', wrap(async (req, res) => {
  const m = await load(req, res); if (!m) return;
  const body = String(req.body.body || '').trim().slice(0, 1000);
  if (!body) return res.status(400).json({ error: 'Message is empty' });
  const { rows: [msg] } = await q('INSERT INTO messages(match_id, sender_id, body) VALUES ($1,$2,$3) RETURNING id, created_at', [m.id, req.user.id, body]);
  await push([req.user.id === m.student_id ? m.business_id : m.student_id], { title: 'New message', body: body.slice(0, 80), data: { matchId: String(m.id) } });
  res.status(201).json(msg);
}));

router.post('/:id/confirm', wrap(async (req, res) => {
  const m = await load(req, res); if (!m) return;
  if (m.status !== 'chat') return res.status(409).json({ error: `Shift is already ${m.status}` });
  await q(`UPDATE matches SET status='confirmed' WHERE id=$1`, [m.id]);
  res.json({ status: 'confirmed' });
}));

// Business marks the shift done. Counts toward the Skill Unlock badge (10 successful shifts per category).
router.post('/:id/complete', wrap(async (req, res) => {
  const m = await load(req, res); if (!m) return;
  if (req.user.role !== 'business') return res.status(403).json({ error: 'Only the business can complete a shift' });
  if (m.status !== 'confirmed') return res.status(409).json({ error: 'Shift must be confirmed first' });
  const late = Math.max(0, parseInt(req.body.lateMinutes, 10) || 0);
  const db = await pool.connect();
  let unlocked = null;
  try {
    await db.query('BEGIN');
    await db.query(`UPDATE matches SET status='completed', late_minutes=$2, finished_at=now() WHERE id=$1`, [m.id, late]);
    const { rows: [sk] } = await db.query(
      `INSERT INTO skill_progress(student_id, category, completed) VALUES ($1,$2,1)
       ON CONFLICT (student_id, category) DO UPDATE SET completed = skill_progress.completed + 1 RETURNING completed, badge_at`,
      [m.student_id, m.category]);
    if (sk.completed >= 10 && !sk.badge_at) {
      await db.query('UPDATE skill_progress SET badge_at=now() WHERE student_id=$1 AND category=$2', [m.student_id, m.category]);
      unlocked = BADGE_NAMES[m.category];
    }
    await recompute(db, m.student_id, 'student');
    await db.query('COMMIT');
  } catch (e) { await db.query('ROLLBACK'); throw e; } finally { db.release(); }
  if (unlocked) await push([m.student_id], { title: '🏅 Badge unlocked', body: `You are now a ${unlocked}. Businesses will prefer you and pay more.` });
  res.json({ status: 'completed', badgeUnlocked: unlocked });
}));

// Cancelling a CONFIRMED shift hurts the canceller's reputation. Backing out during chat is free.
router.post('/:id/cancel', wrap(async (req, res) => {
  const m = await load(req, res); if (!m) return;
  if (!['chat', 'confirmed'].includes(m.status)) return res.status(409).json({ error: `Shift is already ${m.status}` });
  const penalised = m.status === 'confirmed';
  await q(`UPDATE matches SET status='cancelled', cancelled_by=$2, finished_at=now() WHERE id=$1`, [m.id, penalised ? req.user.id : null]);
  if (penalised) await recompute(pool, req.user.id, req.user.role);
  res.json({ status: 'cancelled', reputationPenalty: penalised });
}));

router.post('/:id/rate', wrap(async (req, res) => {
  const m = await load(req, res); if (!m) return;
  const stars = parseInt(req.body.stars, 10);
  if (m.status !== 'completed') return res.status(409).json({ error: 'You can rate after the shift is completed' });
  if (!(stars >= 1 && stars <= 5)) return res.status(400).json({ error: 'stars must be 1 to 5' });
  const rateeId = req.user.id === m.student_id ? m.business_id : m.student_id;
  const { rowCount } = await q('INSERT INTO ratings(match_id, rater_id, ratee_id, stars) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING', [m.id, req.user.id, rateeId, stars]);
  if (!rowCount) return res.status(409).json({ error: 'Already rated' });
  await recompute(pool, rateeId, req.user.id === m.student_id ? 'business' : 'student');
  res.json({ ok: true });
}));
module.exports = router;
