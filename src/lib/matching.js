// Match score (0-100): rule-based first, swap for ML later when you have data.
function matchScore({ distKm, radiusKm, studentSkills = [], jobSkills = [], hasBadge, bizRating }) {
  const dist = Math.max(0, 1 - distKm / radiusKm);                       // closer is better
  const overlap = jobSkills.length ? jobSkills.filter((s) => studentSkills.includes(s)).length / jobSkills.length : 0.5;
  const trust = (bizRating - 1) / 4;
  const total = 0.35 * dist + 0.35 * overlap + 0.2 * trust + (hasBadge ? 0.1 : 0);
  return Math.round(Math.min(1, total) * 100);
}
const BADGE_NAMES = { kirana:'Trusted Shop Helper', sweets:'Mithai Counter Pro', salon:'Verified Salon Helper', cafe:'Verified Barista', sales:'Weekend Sales Pro', mobile:'Mobile Shop Pro', medical:'Trusted Medical Helper', event:'Event Star', edit:'Trusted Editor', tuition:'Trusted Tutor', delivery:'Delivery Pro', office:'Office Helper Pro', tourism:'Local Guide' };
const BADGE_BONUS = 0.15; // badge holders get +15% payout on shifts in that category
module.exports = { matchScore, BADGE_NAMES, BADGE_BONUS };
