const assert = require('assert');
const { computeScore } = require('../src/lib/reputation');
const { matchScore } = require('../src/lib/matching');

assert.strictEqual(computeScore({}), 4.5, 'new users start at the prior');
assert.ok(computeScore({ sumStars: 5 * 10, nRatings: 10 }) > 4.8, 'consistent 5-star work lifts the score');
assert.ok(computeScore({ sumStars: 1, nRatings: 1 }) > 3.5, 'one bad rating cannot sink a new user');
const twoCancels = computeScore({ sumStars: 24, nRatings: 5, cancels90: 2 });
assert.ok(twoCancels < 4.2, 'two cancellations drop a student under the 4.2 filter, got ' + twoCancels);
assert.strictEqual(computeScore({ cancels90: 50 }), 1, 'score never goes below 1');
const near = matchScore({ distKm: 0.5, radiusKm: 5, studentSkills: ['Billing'], jobSkills: ['Billing'], hasBadge: false, bizRating: 4.8 });
const far = matchScore({ distKm: 4.5, radiusKm: 5, studentSkills: [], jobSkills: ['Billing'], hasBadge: false, bizRating: 4.8 });
assert.ok(near > far, 'nearby skilled match scores higher');
console.log('All tests passed. twoCancels =', twoCancels, ' near/far =', near, far);
