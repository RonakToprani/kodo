# kōdō

personal productivity dashboard i built for myself. runs local, no cloud, no subscriptions. just dump your thoughts in and let it figure out the rest.

---

## what it does

type anything into the input — "call bank tmr, fix login bug, brunch this weekend" — and it:

- **categorizes it** using a local SLM (gemma via Ollama) into high / medium / low priority
- **estimates the time** in the background with a second model (qwen2.5:1.5b) so the timeline fills in without blocking you
- **detects dates** and pins it to the calendar automatically — supports natural language like `tomorrow`, `tmr`, `this weekend`, `next month`, `end of month`, `in 2 weeks`, `march 15`, `3/15`, etc.
- **keeps everything in sync** — open it on your phone or laptop, same data, because it's all SQLite on the server

---

## stack

- **Node.js + Express** — no framework overhead
- **better-sqlite3** — fast, embedded, zero config
- **Chart.js** — timeline + donut charts
- **Ollama** — local SLM inference, two models running in parallel
- **Vanilla JS** — no build step, no bundler, just files

---

## setup

**prereqs:** Node.js, Ollama running somewhere on your network with `gemma-fast` and `qwen2.5:1.5b` pulled

```bash
git clone https://github.com/RonakToprani/kodo.git
cd kodo/app
npm install
npm start
```

opens on `http://localhost:8080`

**point it at your Ollama instance** via the settings panel (gear icon) — set the host to wherever Ollama is running, e.g. `http://10.0.0.79:11434`

---

## features

- **brain dump input** — one box, handles everything. the AI cleans up the title and picks the priority
- **// section layout** — tasks split into now / next / later buckets
- **task timeline** — horizontal bar chart showing estimated hours per task, color-coded by priority
- **calendar** — dated tasks show up on the right day, persisted to DB so it survives refreshes
- **analytics** — streak, completion rate, activity heatmap, priority donut
- **4 themes** — midnight (default), paper, terminal, zen
- **inline time hints** — type `~2h` or `~30min` in your input to override the AI estimate
- **context menu** — right-click any task to edit, reprioritize, or complete it

---

## date parsing

understands a pretty wide range of phrases:

| input | resolves to |
|---|---|
| `today`, `tdy` | today |
| `tomorrow`, `tmr`, `tmw` | tomorrow |
| `this weekend` | coming saturday |
| `next weekend` | saturday of next week |
| `next week` | coming monday |
| `next month` | 1st of next month |
| `end of month` | last day of this month |
| `in 3 days` / `in 2 weeks` / `in 1 month` | relative offsets |
| `monday`, `next friday`, `this thursday` | nearest occurrence |
| `march 15`, `15 mar`, `3/15` | specific dates |
| `2026-04-20` | ISO format |

---

## env vars

| var | default | description |
|---|---|---|
| `PORT` | `8080` | server port |
| `OLLAMA_HOST` | `http://10.0.0.79:11434` | Ollama API base URL |
| `OLLAMA_MODEL` | `gemma-fast` | model used for categorization |

settings can also be changed at runtime from the UI and are persisted to the DB.

---

## project structure

```
app/
├── server.js          # Express API + SQLite
├── data/
│   └── tasks.db       # SQLite database (auto-created)
└── public/
    ├── index.html
    ├── style.css
    └── app.js
```

---

built for personal use on a home server / Pi setup. works great as a browser tab you keep open all day.
