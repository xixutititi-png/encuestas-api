-- Ejecutar una sola vez en Railway PostgreSQL

CREATE TABLE IF NOT EXISTS admins (
  id            SERIAL PRIMARY KEY,
  email         TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS surveys (
  id          SERIAL PRIMARY KEY,
  title       TEXT NOT NULL,
  description TEXT,
  slug        TEXT UNIQUE NOT NULL,
  status      TEXT DEFAULT 'draft'
    CHECK (status IN ('draft','live','closed')),
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS questions (
  id         SERIAL PRIMARY KEY,
  survey_id  INT REFERENCES surveys(id) ON DELETE CASCADE,
  text       TEXT NOT NULL,
  type       TEXT DEFAULT 'single'
    CHECK (type IN ('single','multiple','open')),
  sort_order INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS question_options (
  id          SERIAL PRIMARY KEY,
  question_id INT REFERENCES questions(id) ON DELETE CASCADE,
  label       TEXT NOT NULL,
  sort_order  INT DEFAULT 0
);

CREATE TABLE IF NOT EXISTS responses (
  id             SERIAL PRIMARY KEY,
  survey_id      INT REFERENCES surveys(id) ON DELETE CASCADE,
  age_range      TEXT,
  source_channel TEXT DEFAULT 'web',
  created_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS response_answers (
  id          SERIAL PRIMARY KEY,
  response_id INT REFERENCES responses(id) ON DELETE CASCADE,
  question_id INT REFERENCES questions(id),
  option_id   INT REFERENCES question_options(id),
  open_text   TEXT
);

-- Índices para consultas rápidas
CREATE INDEX IF NOT EXISTS idx_responses_survey ON responses(survey_id);
CREATE INDEX IF NOT EXISTS idx_ra_question      ON response_answers(question_id);
CREATE INDEX IF NOT EXISTS idx_ra_response      ON response_answers(response_id);
CREATE INDEX IF NOT EXISTS idx_responses_age    ON responses(survey_id, age_range);

-- Admin inicial: admin@encuestas.mx / Admin1234
INSERT INTO admins (email, password_hash)
VALUES (
  'admin@encuestas.mx',
  '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LnImaS6Yd0K'
) ON CONFLICT DO NOTHING;