# ShiftPe Backend

Tinder-style part-time job matching for students. Node.js + Express + PostgreSQL/PostGIS.

## Run it (5 minutes)

```bash
cp .env.example .env          # then set JWT_SECRET to a long random string
docker compose up -d          # PostgreSQL with PostGIS
npm install
npm run migrate               # creates all tables
npm start                     # API on http://localhost:3000
npm test                      # reputation + matching unit tests (no database needed)
```

## Try the whole flow (curl)

```bash
API=http://localhost:3000

# 1. Business logs in (dev mode returns the OTP in the response)
curl -s -XPOST $API/auth/request-otp -H 'content-type: application/json' -d '{"phone":"9000000001","role":"business"}'
curl -s -XPOST $API/auth/verify-otp  -H 'content-type: application/json' -d '{"phone":"9000000001","otp":"<devOtp>","role":"business"}'   # -> token B

# 2. Business sets shop location and posts an URGENT shift (nearby students get a push)
curl -XPUT  $API/businesses/me -H "authorization: Bearer $B" -H 'content-type: application/json' -d '{"name":"Cafe Kapi","lat":22.7196,"lng":75.8577}'
curl -XPOST $API/jobs -H "authorization: Bearer $B" -H 'content-type: application/json' \
  -d '{"title":"Evening Rush Counter Staff","category":"cafe","pay":600,"hoursText":"6 PM - 10 PM","skills":["Billing"],"urgent":true}'

# 3. Student logs in the same way (role "student"), then:
curl -XPUT $API/students/me -H "authorization: Bearer $S" -H 'content-type: application/json' \
  -d '{"name":"Aarav","age":20,"college":"IPS Academy","skills":["Billing"],"lat":22.72,"lng":75.86,"availableNow":true}'
curl $API/jobs/feed -H "authorization: Bearer $S"            # swipe deck
curl -XPOST $API/jobs/1/swipe -H "authorization: Bearer $S" -H 'content-type: application/json' -d '{"direction":"like"}'
```

## Endpoints

| Method | Path | Who | What |
|---|---|---|---|
| POST | /auth/request-otp, /auth/verify-otp | all | Phone OTP login, returns JWT |
| GET/PUT | /students/me | student | Profile, skills, location, badge progress |
| GET/PUT | /businesses/me | business | Shop profile, free listings left |
| POST | /device-token | all | Save FCM token for push |
| POST | /jobs | business | Post shift (2 free, then membership). `urgent:true` pings nearby students |
| GET | /jobs/feed | student | Swipe deck, ranked by match score |
| POST | /jobs/:id/swipe | student | like / pass / save |
| POST | /jobs/:id/claim | student | First-come claim for an urgent shift |
| GET | /jobs/:id/applicants | business | Interested students (reputation filter via `?minTrust=`) |
| POST | /jobs/:id/accept/:studentId | business | Create the Shift Match |
| GET/POST | /matches/:id/messages | both | Chat |
| POST | /matches/:id/confirm, /complete, /cancel, /rate | both | Shift lifecycle |

## How your 3 features work

1. **Urgent Hiring** - `src/lib/notify.js`: PostGIS finds available, trusted students within `URGENT_RADIUS_KM` of the shop, skips anyone already pinged 3 times today, then sends FCM push.
2. **Work Reputation Score** - `src/lib/reputation.js`: Bayesian average of star ratings minus penalties for cancelled confirmed shifts and late arrivals (last 90 days). Students under `MIN_STUDENT_TRUST` are hidden from businesses; businesses under `MIN_BUSINESS_TRUST` are hidden from students.
3. **Skill Unlock** - `src/routes/matches.js` (`/complete`): every completed shift adds to `skill_progress`. At 10 in a category the badge unlocks (Verified Barista, Trusted Editor, Weekend Sales Pro, Event Star), the student ranks higher with businesses and sees +15% pay.

## Before you launch (not done yet)

- **SMS OTP:** `routes/auth.js` has a TODO. Plug in MSG91 / Twilio / Firebase Auth. Dev mode returns the OTP in the response, production does not.
- **Payments:** `/billing/dev-activate` is a dev stand-in. Replace with Razorpay checkout + webhook that sets `plan_expires`.
- **Real push:** `npm i firebase-admin` and set `FIREBASE_SERVICE_ACCOUNT`.
- **Real-time chat:** chat is REST polling now; move to WebSockets (Socket.IO) when you have users.
- **Hardening:** rate limiting (express-rate-limit), input validation (zod), helmet, restrict CORS, student ID/college verification.
- **Legal:** the API blocks under-18 profiles. Check local labour, payment and DPDP privacy rules with a lawyer before launch.
- Tested here: syntax of all files and the reputation/matching unit tests. The API has not been run against a live database, so expect to fix small bugs on first run.
