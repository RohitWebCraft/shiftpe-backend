// Work Reputation Score (1.0 - 5.0), used for BOTH students and businesses.
// Bayesian average of star ratings (new users start near 4.5, so one bad rating cannot sink them),
// minus penalties for cancellations and lateness in the last 90 days.
const PRIOR = 4.5, PRIOR_WEIGHT = 3;
const CANCEL_PENALTY = 0.4, LATE_PENALTY = 0.1;

function computeScore({ sumStars = 0, nRatings = 0, cancels90 = 0, late90 = 0 }) {
  const base = (sumStars + PRIOR * PRIOR_WEIGHT) / (nRatings + PRIOR_WEIGHT);
  const score = base - CANCEL_PENALTY * cancels90 - LATE_PENALTY * late90;
  return Math.round(Math.min(5, Math.max(1, score)) * 100) / 100;
}

// Recompute and store the score for a user after a shift ends, is cancelled, or is rated.
async function recompute(db, userId, role) {
  const { rows: [r] } = await db.query(
    'SELECT COALESCE(SUM(stars),0)::int AS s, COUNT(*)::int AS n FROM ratings WHERE ratee_id=$1', [userId]);
  const { rows: [c] } = await db.query(
    `SELECT COUNT(*)::int AS n FROM matches WHERE cancelled_by=$1 AND finished_at > now() - interval '90 days'`, [userId]);
  const score = computeScore({ sumStars: r.s, nRatings: r.n, cancels90: c.n, late90: 0 });
  if (role === 'business') {
    await db.query('UPDATE businesses SET rating=$2 WHERE user_id=$1', [userId, computeScore({ sumStars: r.s, nRatings: r.n, cancels90: c.n })]);
    return;
  }
  const { rows: [l] } = await db.query(
    `SELECT COUNT(*) FILTER (WHERE late_minutes > 10)::int AS late,
            COUNT(*)::int AS total
       FROM matches WHERE student_id=$1 AND status='completed' AND finished_at > now() - interval '90 days'`, [userId]);
  const final = computeScore({ sumStars: r.s, nRatings: r.n, cancels90: c.n, late90: l.late });
  const ontime = l.total ? Math.round(((l.total - l.late) / l.total) * 100) : 100;
  await db.query('UPDATE student_profiles SET rating=$2, ontime_pct=$3, cancels=$4 WHERE user_id=$1',
    [userId, final, ontime, c.n]);
}

module.exports = { computeScore, recompute };
