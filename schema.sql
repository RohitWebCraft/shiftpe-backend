CREATE EXTENSION IF NOT EXISTS postgis;

CREATE TABLE IF NOT EXISTS users (
  id          BIGSERIAL PRIMARY KEY,
  phone       TEXT UNIQUE NOT NULL,
  role        TEXT NOT NULL CHECK (role IN ('student','business')),
  name        TEXT NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS otps (
  id          BIGSERIAL PRIMARY KEY,
  phone       TEXT NOT NULL,
  code_hash   TEXT NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  used        BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS student_profiles (
  user_id       BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  age           INT,
  college       TEXT,
  skills        TEXT[] NOT NULL DEFAULT '{}',
  available_now BOOLEAN NOT NULL DEFAULT false,
  location      GEOGRAPHY(Point,4326),
  rating        NUMERIC(3,2) NOT NULL DEFAULT 4.50,   -- work reputation score
  ontime_pct    INT NOT NULL DEFAULT 100,
  cancels       INT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS businesses (
  user_id             BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  location            GEOGRAPHY(Point,4326),
  rating              NUMERIC(3,2) NOT NULL DEFAULT 4.50,
  free_listings_left  INT NOT NULL DEFAULT 2,
  plan_expires        TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS jobs (
  id           BIGSERIAL PRIMARY KEY,
  business_id  BIGINT NOT NULL REFERENCES businesses(user_id) ON DELETE CASCADE,
  title        TEXT NOT NULL,
  category     TEXT NOT NULL CHECK (category IN ('cafe','sales','edit','event')),
  description  TEXT NOT NULL DEFAULT '',
  pay          INT NOT NULL CHECK (pay >= 0),
  hours_text   TEXT NOT NULL DEFAULT '',
  skills       TEXT[] NOT NULL DEFAULT '{}',
  urgent       BOOLEAN NOT NULL DEFAULT false,
  status       TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','filled','closed')),
  location     GEOGRAPHY(Point,4326) NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS jobs_loc_idx ON jobs USING GIST (location);
CREATE INDEX IF NOT EXISTS students_loc_idx ON student_profiles USING GIST (location);

CREATE TABLE IF NOT EXISTS swipes (
  student_id  BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  job_id      BIGINT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  direction   TEXT NOT NULL CHECK (direction IN ('like','pass','save')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (student_id, job_id)
);

-- A match = business accepted a student who liked the job (or student claimed an urgent job)
CREATE TABLE IF NOT EXISTS matches (
  id            BIGSERIAL PRIMARY KEY,
  job_id        BIGINT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  student_id    BIGINT NOT NULL REFERENCES users(id),
  business_id   BIGINT NOT NULL REFERENCES businesses(user_id),
  status        TEXT NOT NULL DEFAULT 'chat' CHECK (status IN ('chat','confirmed','completed','cancelled')),
  late_minutes  INT NOT NULL DEFAULT 0,
  cancelled_by  BIGINT REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at   TIMESTAMPTZ,
  UNIQUE (job_id, student_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id          BIGSERIAL PRIMARY KEY,
  match_id    BIGINT NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  sender_id   BIGINT NOT NULL REFERENCES users(id),
  body        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ratings (
  match_id   BIGINT NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  rater_id   BIGINT NOT NULL REFERENCES users(id),
  ratee_id   BIGINT NOT NULL REFERENCES users(id),
  stars      INT NOT NULL CHECK (stars BETWEEN 1 AND 5),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (match_id, rater_id)
);

-- Skill unlock system
CREATE TABLE IF NOT EXISTS skill_progress (
  student_id  BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category    TEXT NOT NULL,
  completed   INT NOT NULL DEFAULT 0,
  badge_at    TIMESTAMPTZ,                -- set when completed reaches 10
  PRIMARY KEY (student_id, category)
);

CREATE TABLE IF NOT EXISTS device_tokens (
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token   TEXT NOT NULL,
  PRIMARY KEY (user_id, token)
);

CREATE TABLE IF NOT EXISTS notifications (
  id       BIGSERIAL PRIMARY KEY,
  user_id  BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  job_id   BIGINT REFERENCES jobs(id) ON DELETE CASCADE,
  sent_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
