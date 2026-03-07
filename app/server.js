const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 8080;
let OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://10.0.0.79:11434';
let OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'gemma-fast';
const MEMOS_HOST = process.env.MEMOS_HOST || 'http://localhost:5230';

// ── Middleware ────────────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Database ──────────────────────────────────────────────────
const dbPath = path.join(__dirname, 'data', 'tasks.db');
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT DEFAULT '',
    priority TEXT CHECK(priority IN ('high','medium','low')) DEFAULT 'medium',
    done INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    completed_at DATETIME,
    est_hours REAL DEFAULT NULL
  )
`);

// Add est_hours column when upgrading from v1
try { db.exec(`ALTER TABLE tasks ADD COLUMN est_hours REAL DEFAULT NULL`); } catch (_) {}

// ── Settings Table ────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )
`);

// Seed defaults (INSERT OR IGNORE — won't overwrite existing)
const seed = db.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)`);
seed.run('theme', 'midnight');
seed.run('ollama_host', OLLAMA_HOST);
seed.run('ollama_model', OLLAMA_MODEL);

// Load runtime settings from DB (overrides env defaults)
const storedHost  = db.prepare(`SELECT value FROM settings WHERE key='ollama_host'`).get();
const storedModel = db.prepare(`SELECT value FROM settings WHERE key='ollama_model'`).get();
if (storedHost)  OLLAMA_HOST  = storedHost.value;
if (storedModel) OLLAMA_MODEL = storedModel.value;

// ── Ollama System Prompt ──────────────────────────────────────
const SYSTEM_PROMPT = `You are a task organizer. Given a raw brain dump, return ONLY valid JSON with no extra text, no markdown, no code fences.

Format: {"priority":"high|medium|low","title":"concise action phrase max 6 words","description":"one short sentence of context"}

Rules:
- Rewrite the title to be clean, professional, and action-oriented (start with a verb)
- high: Urgent, time-sensitive, blocking, or critical
- medium: Important but not urgent, needs focus time
- low: Nice to have, can wait, quick or low effort

Examples of good titles: "Fix user login flow", "Update brand colors", "Review database storage"
Examples of bad titles: "oh yeah fix that login thing", "maybe update colors idk"`;

// ── Helper: parse SLM response ────────────────────────────────
function parseSLMResponse(content) {
  let cleaned = content
    .replace(/```json\s*/gi, '')
    .replace(/```\s*/g, '')
    .trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (match) cleaned = match[0];
  return JSON.parse(cleaned);
}

// ── Routes ────────────────────────────────────────────────────

// GET /api/tasks — active tasks grouped by priority
app.get('/api/tasks', (req, res) => {
  const all = db.prepare(
    'SELECT * FROM tasks WHERE done = 0 ORDER BY created_at DESC'
  ).all();
  res.json({
    high:   all.filter(t => t.priority === 'high'),
    medium: all.filter(t => t.priority === 'medium'),
    low:    all.filter(t => t.priority === 'low'),
  });
});

// GET /api/tasks/completed — paginated (must be before /:id)
app.get('/api/tasks/completed', (req, res) => {
  const page   = Math.max(1, parseInt(req.query.page)  || 1);
  const limit  = Math.max(1, parseInt(req.query.limit) || 15);
  const offset = (page - 1) * limit;
  const rows  = db.prepare(
    'SELECT * FROM tasks WHERE done = 1 ORDER BY completed_at DESC LIMIT ? OFFSET ?'
  ).all(limit, offset);
  const total = db.prepare('SELECT COUNT(*) as c FROM tasks WHERE done = 1').get().c;
  res.json({ tasks: rows, page, limit, total });
});

// POST /api/tasks — create manually (skip AI)
app.post('/api/tasks', (req, res) => {
  const { title, description = '', priority = 'medium' } = req.body;
  if (!title) return res.status(400).json({ error: 'Title is required' });

  const valid = ['high', 'medium', 'low'];
  const p = valid.includes(priority) ? priority : 'medium';

  const result = db.prepare(
    'INSERT INTO tasks (title, description, priority) VALUES (?, ?, ?)'
  ).run(title, description, p);

  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(result.lastInsertRowid);
  res.json(task);
});

// POST /api/categorize — send brain dump to Ollama, save result
app.post('/api/categorize', async (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: 'Text is required' });

  try {
    const ollamaRes = await fetch(`${OLLAMA_HOST}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user',   content: text },
        ],
        stream: false,
      }),
    });

    if (!ollamaRes.ok) throw new Error(`Ollama HTTP ${ollamaRes.status}`);

    const data   = await ollamaRes.json();
    const parsed = parseSLMResponse(data.message.content);

    const validPriorities = ['high', 'medium', 'low'];
    const priority    = validPriorities.includes(parsed.priority) ? parsed.priority : 'medium';
    const title       = (parsed.title || text.substring(0, 60)).substring(0, 100);
    const description = (parsed.description || '').substring(0, 200);

    const result = db.prepare(
      'INSERT INTO tasks (title, description, priority) VALUES (?, ?, ?)'
    ).run(title, description, priority);

    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(result.lastInsertRowid);
    res.json(task);

  } catch (err) {
    console.error('SLM error:', err.message);

    // Fallback: save with original text, priority = low
    const fallbackTitle = text.substring(0, 80);
    const result = db.prepare(
      'INSERT INTO tasks (title, description, priority) VALUES (?, ?, ?)'
    ).run(fallbackTitle, 'Auto-saved (AI unavailable)', 'low');

    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(result.lastInsertRowid);
    res.json({ ...task, fallback: true });
  }
});

// POST /api/estimate — background time estimate via qwen2.5:1.5b
app.post('/api/estimate', async (req, res) => {
  const { text } = req.body;
  if (!text) return res.json({ hours: null });

  try {
    const resp = await fetch(`${OLLAMA_HOST}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'qwen2.5:1.5b',
        messages: [
          {
            role: 'system',
            content: 'Estimate hours for ONE person to complete a single task. Reply with ONLY a decimal number (e.g. 0.25). Examples: "reply to email"=0.1, "send a text"=0.1, "make a phone call"=0.25, "book appointment"=0.25, "review short doc"=0.25, "short meeting"=0.5, "review PR"=0.5, "write short doc"=1, "implement small feature"=1.5, "implement feature"=2, "debug complex issue"=3, "build new system"=4. Most personal tasks are under 1 hour. Never exceed 8.',
          },
          { role: 'user', content: text },
        ],
        stream: false,
        options: { num_predict: 8, temperature: 0 },
      }),
    });

    if (!resp.ok) return res.json({ hours: null });

    const data  = await resp.json();
    const raw   = data.message?.content?.trim() || '';
    // Extract first number from response (handles "2 hours", "about 1.5", etc.)
    const match = raw.match(/\d+(\.\d+)?/);
    if (!match) return res.json({ hours: null });
    // Clamp to a sane per-task range: 0.1h–8h
    let hours = Math.min(8, Math.max(0.1, parseFloat(match[0])));

    // Keyword-based caps: small models over-estimate simple tasks.
    // Only apply when no dev/implementation keyword is present.
    const lower = text.toLowerCase();
    const isDev = /\b(implement|build|create|develop|code|refactor|migrate|deploy|architect)\b/.test(lower);
    if (!isDev) {
      if (/\b(call|phone|ring)\b/.test(lower))                                       hours = Math.min(hours, 0.25);
      if (/\b(book|schedule|appointment)\b/.test(lower))                             hours = Math.min(hours, 0.25);
      if (/\b(send|reply|write).{0,20}(email|text|message|dm|slack)\b/i.test(lower)) hours = Math.min(hours, 0.25);
      if (/\b(check|look up|verify|review)\b/.test(lower))                           hours = Math.min(hours, 0.5);
    }

    res.json({ hours: isNaN(hours) ? null : Math.round(hours * 4) / 4 }); // round to nearest 0.25
  } catch {
    res.json({ hours: null });
  }
});

// PATCH /api/tasks/:id — update fields (title, description, priority, done, est_hours)
app.patch('/api/tasks/:id', (req, res) => {
  const { id } = req.params;
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  if (!task) return res.status(404).json({ error: 'Task not found' });

  const { title, description, priority, done, est_hours } = req.body;

  if (title !== undefined) {
    db.prepare('UPDATE tasks SET title = ? WHERE id = ?').run(title, id);
  }
  if (description !== undefined) {
    db.prepare('UPDATE tasks SET description = ? WHERE id = ?').run(description, id);
  }
  if (priority !== undefined) {
    const valid = ['high', 'medium', 'low'];
    if (valid.includes(priority)) {
      db.prepare('UPDATE tasks SET priority = ? WHERE id = ?').run(priority, id);
    }
  }
  if (done !== undefined) {
    const completedAt = done ? new Date().toISOString() : null;
    db.prepare('UPDATE tasks SET done = ?, completed_at = ? WHERE id = ?')
      .run(done ? 1 : 0, completedAt, id);
  }
  if (est_hours !== undefined) {
    db.prepare('UPDATE tasks SET est_hours = ? WHERE id = ?').run(est_hours, id);
  }

  const updated = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  res.json(updated);
});

// DELETE /api/tasks/:id
app.delete('/api/tasks/:id', (req, res) => {
  const { id } = req.params;
  const result = db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
  if (result.changes === 0) return res.status(404).json({ error: 'Task not found' });
  res.json({ success: true });
});

// POST /api/tasks/bulk — bulk operations
app.post('/api/tasks/bulk', (req, res) => {
  const { action, ids } = req.body;

  if (action === 'clear-completed') {
    db.prepare('DELETE FROM tasks WHERE done = 1').run();
  } else if (action === 'complete-all') {
    const completedAt = new Date().toISOString();
    db.prepare('UPDATE tasks SET done = 1, completed_at = ? WHERE done = 0').run(completedAt);
  } else if (action === 'delete' && Array.isArray(ids) && ids.length) {
    const ph = ids.map(() => '?').join(',');
    db.prepare(`DELETE FROM tasks WHERE id IN (${ph})`).run(...ids);
  } else if (action === 'complete' && Array.isArray(ids) && ids.length) {
    const completedAt = new Date().toISOString();
    const ph = ids.map(() => '?').join(',');
    db.prepare(`UPDATE tasks SET done = 1, completed_at = ? WHERE id IN (${ph})`).run(completedAt, ...ids);
  }

  res.json({ success: true });
});

// GET /api/analytics
app.get('/api/analytics', (req, res) => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // Streak: consecutive days with at least one completion (walking back from today)
  let streak = 0;
  for (let i = 0; i < 365; i++) {
    const d   = new Date(today);
    d.setDate(d.getDate() - i);
    const iso = d.toISOString().split('T')[0];
    const cnt = db.prepare(
      "SELECT COUNT(*) as c FROM tasks WHERE done=1 AND DATE(completed_at)=?"
    ).get(iso).c;
    if (cnt > 0) { streak++; }
    else if (i > 0) break; // allow today to be 0 without breaking streak
  }

  // Completion rate
  const totalTasks = db.prepare("SELECT COUNT(*) as c FROM tasks").get().c;
  const doneTasks  = db.prepare("SELECT COUNT(*) as c FROM tasks WHERE done=1").get().c;
  const completionRate = totalTasks > 0 ? Math.round((doneTasks / totalTasks) * 100) : 0;

  // Avg time in hours (creation → completion)
  const avgRow = db.prepare(
    "SELECT AVG((julianday(completed_at) - julianday(created_at)) * 24) as avg FROM tasks WHERE done=1 AND completed_at IS NOT NULL"
  ).get();
  const avgTime = avgRow.avg ? Math.round(avgRow.avg * 10) / 10 : 0;

  // 14-day completions
  const dailyCompletions = [];
  for (let i = 13; i >= 0; i--) {
    const d   = new Date(today);
    d.setDate(d.getDate() - i);
    const iso = d.toISOString().split('T')[0];
    const cnt = db.prepare(
      "SELECT COUNT(*) as c FROM tasks WHERE done=1 AND DATE(completed_at)=?"
    ).get(iso).c;
    dailyCompletions.push({
      date:  iso,
      label: d.toLocaleDateString('en', { weekday: 'narrow' }),
      count: cnt,
    });
  }

  // Priority split (active tasks only)
  const prioritySplit = {
    now:   db.prepare("SELECT COUNT(*) as c FROM tasks WHERE priority='high'   AND done=0").get().c,
    next:  db.prepare("SELECT COUNT(*) as c FROM tasks WHERE priority='medium' AND done=0").get().c,
    later: db.prepare("SELECT COUNT(*) as c FROM tasks WHERE priority='low'    AND done=0").get().c,
  };

  // Active tasks with est_hours for timeline chart
  const activeTasks = db.prepare(
    "SELECT id, title, priority, est_hours FROM tasks WHERE done=0 ORDER BY created_at DESC"
  ).all();

  res.json({ streak, completionRate, avgTime, dailyCompletions, prioritySplit, activeTasks });
});

// GET /api/settings
app.get('/api/settings', (req, res) => {
  const rows     = db.prepare('SELECT key, value FROM settings').all();
  const settings = {};
  rows.forEach(r => { settings[r.key] = r.value; });
  res.json(settings);
});

// PATCH /api/settings
app.patch('/api/settings', (req, res) => {
  const allowed = ['theme', 'ollama_host', 'ollama_model'];
  const upsert  = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');

  for (const key of allowed) {
    if (req.body[key] !== undefined) {
      upsert.run(key, req.body[key]);
      if (key === 'ollama_host')  OLLAMA_HOST  = req.body[key];
      if (key === 'ollama_model') OLLAMA_MODEL = req.body[key];
    }
  }

  res.json({ success: true });
});

// GET /api/config — startup config (theme, ollama, memos)
app.get('/api/config', (req, res) => {
  const rows     = db.prepare('SELECT key, value FROM settings').all();
  const settings = {};
  rows.forEach(r => { settings[r.key] = r.value; });

  res.json({
    memosUrl:    MEMOS_HOST,
    theme:       settings.theme       || 'midnight',
    ollamaHost:  settings.ollama_host  || OLLAMA_HOST,
    ollamaModel: settings.ollama_model || OLLAMA_MODEL,
  });
});

// GET /api/export — download all tasks as JSON
app.get('/api/export', (req, res) => {
  const all = db.prepare('SELECT * FROM tasks ORDER BY created_at DESC').all();
  res.setHeader('Content-Disposition', 'attachment; filename="kodo-tasks.json"');
  res.setHeader('Content-Type', 'application/json');
  res.json(all);
});

// GET /api/stats — legacy endpoint (kept for compatibility)
app.get('/api/stats', (req, res) => {
  const counts = {
    high:      db.prepare("SELECT COUNT(*) as c FROM tasks WHERE priority='high'   AND done=0").get().c,
    medium:    db.prepare("SELECT COUNT(*) as c FROM tasks WHERE priority='medium' AND done=0").get().c,
    low:       db.prepare("SELECT COUNT(*) as c FROM tasks WHERE priority='low'    AND done=0").get().c,
    completed: db.prepare("SELECT COUNT(*) as c FROM tasks WHERE done=1").get().c,
  };

  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d   = new Date();
    d.setDate(d.getDate() - i);
    const iso = d.toISOString().split('T')[0];
    const cnt = db.prepare(
      "SELECT COUNT(*) as c FROM tasks WHERE done=1 AND DATE(completed_at)=?"
    ).get(iso).c;
    days.push({ date: iso, label: d.toLocaleDateString('en', { weekday: 'short' }), count: cnt });
  }

  res.json({ counts, days });
});

// ── Start ─────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Kōdō v2 running → http://0.0.0.0:${PORT}`);
  console.log(`Ollama  → ${OLLAMA_HOST} (model: ${OLLAMA_MODEL})`);
  console.log(`Memos   → ${MEMOS_HOST}`);
});
