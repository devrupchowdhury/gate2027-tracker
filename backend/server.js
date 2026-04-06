require('dotenv').config();
const express  = require('express');
const cors     = require('cors');
const { ClerkExpressRequireAuth } = require('@clerk/clerk-sdk-node');
const { query, queryOne, initDB } = require('./db');
const { runAgent, getDailyBriefing } = require('./agents/mentor_agent');

const app  = express();
const PORT = process.env.PORT || 3001;

const ALLOWED = [
  'http://localhost:3000',
  'http://localhost:5500',
  'http://127.0.0.1:5500',
  process.env.FRONTEND_URL,
].filter(Boolean);

app.use(cors({
  origin: (origin, cb) => {
    if (!origin || ALLOWED.some(a => origin.startsWith(a))) return cb(null, true);
    cb(new Error('CORS: ' + origin));
  },
  credentials: true,
}));
app.use(express.json());

const requireAuth = ClerkExpressRequireAuth({});
const uid = req => req.auth?.userId;

// ── Public ────────────────────────────────────────────────
app.get('/api/health', (_, res) => res.json({ ok: true, ts: Date.now() }));
app.get('/api/config', (_, res) => res.json({ clerkPublishableKey: process.env.CLERK_PUBLISHABLE_KEY }));

// ══════════════════════════════════════════════
//  AGENT ENDPOINTS
// ══════════════════════════════════════════════

// Main chat endpoint — streams back agent response
app.post('/api/agent/chat', requireAuth, async (req, res) => {
  try {
    const { message } = req.body;
    if (!message?.trim()) return res.status(400).json({ error: 'Message required' });
    const result = await runAgent(uid(req), message);
    res.json(result);
  } catch (err) {
    console.error('Agent error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Daily briefing — proactive summary on page load
app.get('/api/agent/briefing', requireAuth, async (req, res) => {
  try {
    const result = await getDailyBriefing(uid(req));
    res.json(result);
  } catch (err) {
    console.error('Briefing error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Conversation history
app.get('/api/agent/history', requireAuth, async (req, res) => {
  const rows = await query(
    'SELECT id, role, content, created_at FROM agent_messages WHERE user_id=$1 ORDER BY created_at ASC',
    [uid(req)]
  );
  res.json(rows);
});

// Clear conversation
app.delete('/api/agent/history', requireAuth, async (req, res) => {
  await query('DELETE FROM agent_messages WHERE user_id=$1', [uid(req)]);
  res.json({ ok: true });
});

// Today's plan
app.get('/api/agent/plan', requireAuth, async (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  const row = await queryOne('SELECT * FROM study_plans WHERE user_id=$1 AND date=$2', [uid(req), today]);
  res.json(row || null);
});

// ══════════════════════════════════════════════
//  SESSIONS
// ══════════════════════════════════════════════
app.get('/api/sessions', requireAuth, async (req, res) => {
  res.json(await query('SELECT * FROM sessions WHERE user_id=$1 ORDER BY date DESC', [uid(req)]));
});

app.post('/api/sessions', requireAuth, async (req, res) => {
  const { date, subject, hours, score, productivity, notes } = req.body;
  const row = await queryOne(
    'INSERT INTO sessions (user_id,date,subject,hours,score,productivity,notes) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
    [uid(req), date, subject, hours, score ?? null, productivity, notes ?? '']
  );
  res.json(row);
});

app.delete('/api/sessions/:id', requireAuth, async (req, res) => {
  await query('DELETE FROM sessions WHERE id=$1 AND user_id=$2', [req.params.id, uid(req)]);
  res.json({ ok: true });
});

// ══════════════════════════════════════════════
//  ERRORS
// ══════════════════════════════════════════════
app.get('/api/errors', requireAuth, async (req, res) => {
  res.json(await query('SELECT * FROM errors WHERE user_id=$1 ORDER BY date DESC', [uid(req)]));
});

app.post('/api/errors', requireAuth, async (req, res) => {
  const { date, subject, type, topic, description } = req.body;
  const row = await queryOne(
    'INSERT INTO errors (user_id,date,subject,type,topic,description) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
    [uid(req), date, subject, type, topic ?? '', description ?? '']
  );
  res.json(row);
});

app.delete('/api/errors/:id', requireAuth, async (req, res) => {
  await query('DELETE FROM errors WHERE id=$1 AND user_id=$2', [req.params.id, uid(req)]);
  res.json({ ok: true });
});

// ══════════════════════════════════════════════
//  PYQs
// ══════════════════════════════════════════════
app.get('/api/pyqs', requireAuth, async (req, res) => {
  res.json(await query('SELECT * FROM pyqs WHERE user_id=$1', [uid(req)]));
});

app.post('/api/pyqs', requireAuth, async (req, res) => {
  const { subject, round, accuracy, date } = req.body;
  const row = await queryOne(
    `INSERT INTO pyqs (user_id,subject,round,accuracy,date) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (user_id,subject,round) DO UPDATE SET accuracy=EXCLUDED.accuracy, date=EXCLUDED.date RETURNING *`,
    [uid(req), subject, round, accuracy, date]
  );
  res.json(row);
});

// ══════════════════════════════════════════════
//  STATS (for dashboard)
// ══════════════════════════════════════════════
app.get('/api/stats', requireAuth, async (req, res) => {
  const u = uid(req);
  const [th, av, tc, ec, sc, sh, l7, ad] = await Promise.all([
    queryOne('SELECT COALESCE(SUM(hours),0)::numeric(10,1) as v FROM sessions WHERE user_id=$1', [u]),
    queryOne('SELECT ROUND(AVG(score)::numeric,1) as v FROM sessions WHERE user_id=$1 AND score IS NOT NULL', [u]),
    queryOne('SELECT COUNT(*) as v FROM sessions WHERE user_id=$1 AND score IS NOT NULL', [u]),
    queryOne('SELECT COUNT(*) as v FROM errors WHERE user_id=$1', [u]),
    queryOne('SELECT COUNT(DISTINCT subject) as v FROM sessions WHERE user_id=$1', [u]),
    query('SELECT subject,ROUND(SUM(hours)::numeric,1) as hours FROM sessions WHERE user_id=$1 GROUP BY subject ORDER BY hours DESC', [u]),
    query(`SELECT date,ROUND(SUM(hours)::numeric,1) as hours,ROUND(AVG(score)::numeric,0) as avg_score FROM sessions WHERE user_id=$1 AND date>=(CURRENT_DATE-INTERVAL '6 days')::text GROUP BY date ORDER BY date`, [u]),
    query(`SELECT DISTINCT date FROM sessions WHERE user_id=$1 AND date>=(CURRENT_DATE-INTERVAL '60 days')::text`, [u]),
  ]);
  res.json({ totalHours: parseFloat(th?.v||0), avgScore: av?.v ? parseFloat(av.v) : null, testCount: parseInt(tc?.v||0), errorCount: parseInt(ec?.v||0), subjectCount: parseInt(sc?.v||0), subjectHours: sh, last7: l7, activeDates: ad.map(r=>r.date) });
});

// ══════════════════════════════════════════════
//  MOTIVATION
// ══════════════════════════════════════════════
app.get('/api/motivation', requireAuth, async (req, res) => {
  res.json(await query('SELECT * FROM motivation WHERE user_id=$1 ORDER BY created_at DESC LIMIT 50', [uid(req)]));
});
app.post('/api/motivation', requireAuth, async (req, res) => {
  const row = await queryOne('INSERT INTO motivation (user_id,type,content) VALUES ($1,$2,$3) RETURNING *', [uid(req), req.body.type, req.body.content]);
  res.json(row);
});
app.delete('/api/motivation/:id', requireAuth, async (req, res) => {
  await query('DELETE FROM motivation WHERE id=$1 AND user_id=$2', [req.params.id, uid(req)]);
  res.json({ ok: true });
});

// ── Start ─────────────────────────────────────────────────
initDB().then(() => {
  app.listen(PORT, () => console.log(`🚀 GATE Agent API → http://localhost:${PORT}`));
}).catch(err => { console.error('DB init failed:', err); process.exit(1); });
