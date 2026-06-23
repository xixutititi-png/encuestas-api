const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const app = express();

app.use(cors());
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

function auth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No autorizado' });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Token inválido' });
  }
}

/* =========================
   ARCHIVOS ESTÁTICOS
========================= */
app.use('/admin', express.static(path.join(__dirname, 'admin-panel')));

app.get('/admin', (_, res) => {
  res.sendFile(path.join(__dirname, 'admin-panel', 'index.html'));
});

app.get('/', (_, res) => {
  res.json({
    status: 'ok',
    message: 'API de encuestas activa'
  });
});

/* =========================
   AUTH
========================= */
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const { rows } = await pool.query(
      'SELECT * FROM admins WHERE email = $1',
      [email]
    );

    if (!rows[0] || !bcrypt.compareSync(password, rows[0].password_hash)) {
      return res.status(401).json({ error: 'Credenciales incorrectas' });
    }

    const token = jwt.sign(
      { id: rows[0].id, email },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({ token });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* =========================
   SURVEYS ADMIN
========================= */
app.get('/api/surveys', auth, async (_, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT s.*, COUNT(r.id)::int AS responses
      FROM surveys s
      LEFT JOIN responses r ON r.survey_id = s.id
      GROUP BY s.id
      ORDER BY s.created_at DESC
    `);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/surveys', auth, async (req, res) => {
  const { title, description, slug, status, questions } = req.body;
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const { rows: [survey] } = await client.query(
      `INSERT INTO surveys (title, description, slug, status)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [title, description, slug, status || 'draft']
    );

    for (let qi = 0; qi < questions.length; qi++) {
      const q = questions[qi];

      const { rows: [question] } = await client.query(
        `INSERT INTO questions (survey_id, text, type, sort_order)
         VALUES ($1, $2, $3, $4)
         RETURNING *`,
        [survey.id, q.text, q.type || 'single', qi]
      );

      if (q.options) {
        for (let oi = 0; oi < q.options.length; oi++) {
          await client.query(
            `INSERT INTO question_options (question_id, label, sort_order)
             VALUES ($1, $2, $3)`,
            [question.id, q.options[oi], oi]
          );
        }
      }
    }

    await client.query('COMMIT');
    res.status(201).json({ id: survey.id });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

app.patch('/api/surveys/:id', auth, async (req, res) => {
  try {
    const { title, description, status } = req.body;
    await pool.query(
      `UPDATE surveys
       SET title = COALESCE($1, title),
           description = COALESCE($2, description),
           status = COALESCE($3, status)
       WHERE id = $4`,
      [title, description, status, req.params.id]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/surveys/:id', auth, async (req, res) => {
  try {
    await pool.query('DELETE FROM surveys WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* =========================
   PUBLIC SURVEY
========================= */
app.get('/api/public/surveys/:slug', async (req, res) => {
  try {
    const { rows: [survey] } = await pool.query(
      `SELECT id, title, description, slug
       FROM surveys
       WHERE slug = $1 AND status = 'live'`,
      [req.params.slug]
    );

    if (!survey) {
      return res.status(404).json({ error: 'Encuesta no encontrada' });
    }

    const { rows: questions } = await pool.query(
      `SELECT
         q.id,
         q.text,
         q.type,
         json_agg(
           json_build_object('id', o.id, 'label', o.label)
           ORDER BY o.sort_order
         ) AS options
       FROM questions q
       LEFT JOIN question_options o ON o.question_id = q.id
       WHERE q.survey_id = $1
       GROUP BY q.id
       ORDER BY q.sort_order`,
      [survey.id]
    );

    res.json({ ...survey, questions });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/public/responses', async (req, res) => {
  const { survey_id, age_range, source_channel, answers } = req.body;
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const { rows: [response] } = await client.query(
      `INSERT INTO responses (survey_id, age_range, source_channel)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [survey_id, age_range, source_channel || 'web']
    );

    for (const a of answers) {
      await client.query(
        `INSERT INTO response_answers
         (response_id, question_id, option_id, open_text)
         VALUES ($1, $2, $3, $4)`,
        [response.id, a.question_id, a.option_id || null, a.open_text || null]
      );
    }

    await client.query('COMMIT');
    res.status(201).json({ ok: true, id: response.id });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

/* =========================
   RESULTS
========================= */
app.get('/api/surveys/:id/results', auth, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        q.id AS question_id,
        q.text AS question_text,
        o.label AS option_label,
        COUNT(ra.id)::int AS count,
        ROUND(
          COUNT(ra.id) * 100.0 /
          NULLIF(SUM(COUNT(ra.id)) OVER (PARTITION BY q.id), 0), 1
        ) AS pct
      FROM questions q
      JOIN question_options o ON o.question_id = q.id
      LEFT JOIN response_answers ra ON ra.option_id = o.id
      WHERE q.survey_id = $1
      GROUP BY q.id, q.text, o.id, o.label
      ORDER BY q.sort_order, o.sort_order
    `, [req.params.id]);

    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/surveys/:id/results/by-age', auth, async (req, res) => {
  try {
    const { question_id } = req.query;

    const { rows } = await pool.query(`
      SELECT
        r.age_range,
        o.label AS option_label,
        COUNT(ra.id)::int AS count,
        ROUND(
          COUNT(ra.id) * 100.0 /
          NULLIF(SUM(COUNT(ra.id)) OVER (PARTITION BY r.age_range), 0), 1
        ) AS pct
      FROM responses r
      JOIN response_answers ra ON ra.response_id = r.id
      JOIN question_options o ON o.id = ra.option_id
      WHERE r.survey_id = $1 AND ra.question_id = $2
      GROUP BY r.age_range, o.id, o.label
      ORDER BY r.age_range, o.label
    `, [req.params.id, question_id]);

    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/surveys/:id/stats/daily', auth, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT DATE(created_at) AS day, COUNT(*)::int AS count
      FROM responses
      WHERE survey_id = $1
      GROUP BY day
      ORDER BY day DESC
      LIMIT 14
    `, [req.params.id]);

    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor en puerto ${PORT}`));