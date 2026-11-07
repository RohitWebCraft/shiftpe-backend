const router = require('express').Router();
const crypto = require('crypto');
const { q } = require('../db');
const { sign, wrap } = require('../lib/auth');
const hash = (c) => crypto.createHash('sha256').update(c + process.env.JWT_SECRET).digest('hex');
const PHONE = /^\+?\d{10,13}$/;

router.post('/request-otp', wrap(async (req, res) => {
  const { phone, role, pilotCode } = req.body;
  if (process.env.PILOT_CODE && pilotCode !== process.env.PILOT_CODE) return res.status(403).json({ error: 'Invalid pilot code' });
  if (!PHONE.test(phone || '') || !['student', 'business'].includes(role)) return res.status(400).json({ error: 'Valid phone and role required' });
  const { rows: [r] } = await q(`SELECT COUNT(*)::int AS n FROM otps WHERE phone=$1 AND created_at > now() - interval '10 minutes'`, [phone]);
  if (r.n >= 3) return res.status(429).json({ error: 'Too many OTP requests. Try again in 10 minutes.' });
  const code = String(crypto.randomInt(100000, 999999));
  await q(`INSERT INTO otps(phone, code_hash, expires_at) VALUES ($1,$2, now() + interval '5 minutes')`, [phone, hash(code)]);
  // TODO production: send `code` via SMS (MSG91 / Twilio / Firebase Auth) here.
  res.json(process.env.NODE_ENV === 'production' ? { sent: true } : { sent: true, devOtp: code });
}));

router.post('/verify-otp', wrap(async (req, res) => {
  const { phone, otp, role } = req.body;
  const { rows: [o] } = await q(`SELECT id, code_hash FROM otps WHERE phone=$1 AND used=false AND expires_at > now() ORDER BY id DESC LIMIT 1`, [phone]);
  if (!o || o.code_hash !== hash(String(otp))) return res.status(401).json({ error: 'Wrong or expired OTP' });
  await q('UPDATE otps SET used=true WHERE id=$1', [o.id]);
  const { rows: [u] } = await q(
    `INSERT INTO users(phone, role) VALUES ($1,$2) ON CONFLICT (phone) DO UPDATE SET phone=EXCLUDED.phone RETURNING id, role, name`, [phone, role]);
  if (u.role === 'student') await q('INSERT INTO student_profiles(user_id) VALUES ($1) ON CONFLICT DO NOTHING', [u.id]);
  else await q('INSERT INTO businesses(user_id) VALUES ($1) ON CONFLICT DO NOTHING', [u.id]);
  res.json({ token: sign(u), user: u });
}));
module.exports = router;
