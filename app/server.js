const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 8080;
const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://10.0.0.79:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'gemma-fast';
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
    completed_at DATETIME
  )
`);

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
  // Strip markdown code fences if present
  let cleaned = content
    .replace(/```json\s*/gi, '')
    .replace(/```\s*/g, '')
    .trim();

  // Try to extract JSON object if there's extra text
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (match) cleaned = match[0];

  return JSON.parse(cleaned);
}

// ── Routes ────────────────────────────────────────────────────

// GET /api/tasks — all active tasks grouped by priority
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

// POST /api/categorize — send brain dump to SLM, save result
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
          { role: 'user', content: text },
        ],
        stream: false,
      }),
    });

    if (!ollamaRes.ok) {
      throw new Error(`Ollama HTTP ${ollamaRes.status}`);
    }

    const data = await ollamaRes.json();
    const parsed = parseSLMResponse(data.message.content);

    // Validate + sanitize
    const validPriorities = ['high', 'medium', 'low'];
    const priority = validPriorities.includes(parsed.priority) ? parsed.priority : 'medium';
    const title = (parsed.title || text.substring(0, 60)).substring(0, 100);
    const description = (parsed.description || '').substring(0, 200);

    // Persist
    const result = db.prepare(
      'INSERT INTO tasks (title, description, priority) VALUES (?, ?, ?)'
    ).run(title, description, priority);

    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(result.lastInsertRowid);
    res.json(task);

  } catch (err) {
    console.error('SLM error:', err.message);

    // Fallback: save with original text as medium priority
    const fallbackTitle = text.substring(0, 80);
    const result = db.prepare(
      'INSERT INTO tasks (title, description, priority) VALUES (?, ?, ?)'
    ).run(fallbackTitle, 'Auto-saved (AI unavailable)', 'medium');

    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(result.lastInsertRowid);
    res.json({ ...task, fallback: true });
  }
});

// PATCH /api/tasks/:id — update fields
app.patch('/api/tasks/:id', (req, res) => {
  const { id } = req.params;
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  if (!task) return res.status(404).json({ error: 'Task not found' });

  const { title, description, priority, done } = req.body;

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

// GET /api/stats — counts + 7-day history
app.get('/api/stats', (req, res) => {
  const counts = {
    high:      db.prepare("SELECT COUNT(*) as c FROM tasks WHERE priority='high'   AND done=0").get().c,
    medium:    db.prepare("SELECT COUNT(*) as c FROM tasks WHERE priority='medium' AND done=0").get().c,
    low:       db.prepare("SELECT COUNT(*) as c FROM tasks WHERE priority='low'    AND done=0").get().c,
    completed: db.prepare("SELECT COUNT(*) as c FROM tasks WHERE done=1").get().c,
  };

  // 7-day completion history
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const iso = d.toISOString().split('T')[0];
    const count = db.prepare(
      "SELECT COUNT(*) as c FROM tasks WHERE done=1 AND DATE(completed_at)=?"
    ).get(iso).c;
    days.push({
      date: iso,
      label: d.toLocaleDateString('en', { weekday: 'short' }),
      count,
    });
  }

  res.json({ counts, days });
});

// GET /api/config — expose runtime config to frontend
app.get('/api/config', (req, res) => {
  res.json({ memosUrl: MEMOS_HOST });
});

// ── Start ─────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Kōdō running → http://0.0.0.0:${PORT}`);
  console.log(`Ollama  → ${OLLAMA_HOST} (model: ${OLLAMA_MODEL})`);
  console.log(`Memos   → ${MEMOS_HOST}`);
});
