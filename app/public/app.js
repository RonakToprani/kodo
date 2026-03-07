/* ═══════════════════════════════════════════════════════════
   Kōdō — Frontend Logic
   ═══════════════════════════════════════════════════════════ */

// ── State ─────────────────────────────────────────────────
let tasks = { high: [], medium: [], low: [] };
let stats = { counts: { high: 0, medium: 0, low: 0, completed: 0 }, days: [] };
let donutChart = null;
let barChart = null;
let currentMode = localStorage.getItem('kodo-mode') || 'default';
let contextTarget = null;

// ── DOM References ────────────────────────────────────────
const taskInput       = document.getElementById('task-input');
const loadingEl       = document.getElementById('loading-indicator');
const inputHint       = document.getElementById('input-hint');
const modeToggle      = document.getElementById('mode-toggle');
const notesToggle     = document.getElementById('notes-toggle');
const notesPanel      = document.getElementById('notes-panel');
const notesOverlay    = document.getElementById('notes-overlay');
const notesClose      = document.getElementById('notes-close');
const memosIframe     = document.getElementById('memos-iframe');
const contextMenu     = document.getElementById('context-menu');

// ── Initialize ────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  applyMode(currentMode);
  await Promise.all([loadTasks(), loadStats()]);
  initCharts();
  taskInput.focus();
});

// ── Input Handler ─────────────────────────────────────────
taskInput.addEventListener('keydown', async (e) => {
  if (e.key !== 'Enter') return;
  const text = taskInput.value.trim();
  if (!text) return;

  // Lock input
  taskInput.value = '';
  taskInput.disabled = true;
  taskInput.classList.add('processing');
  loadingEl.classList.remove('hidden');
  inputHint.textContent = 'Thinking...';

  try {
    const res = await fetch('/api/categorize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    const task = await res.json();

    // Add to local state + render with animation
    tasks[task.priority].unshift(task);
    renderBucket(task.priority, true);
    await refreshStats();

    if (task.fallback) {
      inputHint.textContent = 'Saved (AI was unavailable) — Press Enter to add another';
    } else {
      inputHint.textContent = 'Done — Press Enter to add another';
    }
  } catch (err) {
    console.error('Categorize failed:', err);
    inputHint.textContent = 'Something went wrong — try again';
  } finally {
    taskInput.disabled = false;
    taskInput.classList.remove('processing');
    loadingEl.classList.add('hidden');
    taskInput.focus();

    // Reset hint after 3s
    setTimeout(() => {
      inputHint.textContent = 'Press Enter \u2014 AI will categorize it for you';
    }, 3000);
  }
});

// ── Load Tasks ────────────────────────────────────────────
async function loadTasks() {
  try {
    const res = await fetch('/api/tasks');
    tasks = await res.json();
    renderBucket('high');
    renderBucket('medium');
    renderBucket('low');
  } catch (err) {
    console.error('Failed to load tasks:', err);
  }
}

// ── Render Bucket ─────────────────────────────────────────
function renderBucket(priority, animate = false) {
  const container = document.getElementById(`tasks-${priority}`);
  const countEl   = document.getElementById(`count-${priority}`);
  const emptyEl   = document.getElementById(`empty-${priority}`);
  const list = tasks[priority] || [];

  const active = list.filter(t => !t.done);
  countEl.textContent = active.length;
  emptyEl.style.display = active.length === 0 ? 'block' : 'none';

  container.innerHTML = list.map((task, i) => `
    <div class="task-item ${task.done ? 'done' : ''} ${animate && i === 0 ? 'entering' : ''}"
         data-id="${task.id}"
         oncontextmenu="showContextMenu(event, ${task.id}, '${priority}')">
      <div class="task-check"
           onclick="event.stopPropagation(); toggleTask(${task.id}, ${task.done ? 0 : 1})"></div>
      <div class="task-content"
           onclick="event.stopPropagation(); toggleTask(${task.id}, ${task.done ? 0 : 1})">
        <div class="task-title">${esc(task.title)}</div>
        ${task.description ? `<div class="task-description">${esc(task.description)}</div>` : ''}
      </div>
      <div class="task-actions">
        <button onclick="event.stopPropagation(); showContextMenu(event, ${task.id}, '${priority}')"
                title="More options">\u22EF</button>
      </div>
    </div>
  `).join('');
}

// ── Toggle Task Done ──────────────────────────────────────
async function toggleTask(id, done) {
  try {
    await fetch(`/api/tasks/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ done }),
    });
    await loadTasks();
    await refreshStats();
  } catch (err) {
    console.error('Toggle failed:', err);
  }
}

// ── Delete Task ───────────────────────────────────────────
async function deleteTask(id) {
  try {
    await fetch(`/api/tasks/${id}`, { method: 'DELETE' });
    await loadTasks();
    await refreshStats();
  } catch (err) {
    console.error('Delete failed:', err);
  }
}

// ── Move Task ─────────────────────────────────────────────
async function moveTask(id, newPriority) {
  try {
    await fetch(`/api/tasks/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ priority: newPriority }),
    });
    await loadTasks();
    await refreshStats();
  } catch (err) {
    console.error('Move failed:', err);
  }
}

// ── Context Menu ──────────────────────────────────────────
function showContextMenu(e, taskId, currentPriority) {
  e.preventDefault();
  e.stopPropagation();
  contextTarget = { id: taskId, priority: currentPriority };

  // Position menu
  const x = e.clientX || e.touches?.[0]?.clientX || 0;
  const y = e.clientY || e.touches?.[0]?.clientY || 0;
  contextMenu.style.left = Math.min(x, window.innerWidth - 180) + 'px';
  contextMenu.style.top  = Math.min(y, window.innerHeight - 200) + 'px';
  contextMenu.classList.remove('hidden');

  // Highlight current priority
  contextMenu.querySelectorAll('[data-action^="move-"]').forEach(btn => {
    const p = btn.dataset.action.replace('move-', '');
    btn.style.opacity = p === currentPriority ? '0.4' : '1';
    btn.style.pointerEvents = p === currentPriority ? 'none' : 'auto';
  });
}

// Context menu actions
contextMenu.addEventListener('click', (e) => {
  const action = e.target.dataset.action;
  if (!action || !contextTarget) return;

  if (action === 'delete') {
    deleteTask(contextTarget.id);
  } else if (action.startsWith('move-')) {
    const newPriority = action.replace('move-', '');
    moveTask(contextTarget.id, newPriority);
  }

  hideContextMenu();
});

function hideContextMenu() {
  contextMenu.classList.add('hidden');
  contextTarget = null;
}

// Close context menu on click elsewhere
document.addEventListener('click', hideContextMenu);
document.addEventListener('touchstart', (e) => {
  if (!contextMenu.contains(e.target)) hideContextMenu();
});

// ── Stats & Charts ────────────────────────────────────────
async function loadStats() {
  try {
    const res = await fetch('/api/stats');
    stats = await res.json();
  } catch (err) {
    console.error('Stats failed:', err);
  }
}

async function refreshStats() {
  await loadStats();
  updateCharts();
}

function initCharts() {
  // Global Chart.js defaults
  Chart.defaults.color = '#475569';
  Chart.defaults.borderColor = 'rgba(255,255,255,0.04)';
  Chart.defaults.font.family = "-apple-system, BlinkMacSystemFont, 'SF Pro Display', sans-serif";

  // Donut
  const donutCtx = document.getElementById('donut-chart');
  donutChart = new Chart(donutCtx, {
    type: 'doughnut',
    data: {
      labels: ['Now', 'Next', 'Later'],
      datasets: [{
        data: [
          stats.counts.high || 0,
          stats.counts.medium || 0,
          stats.counts.low || 0,
        ],
        backgroundColor: ['#ef4444', '#f59e0b', '#10b981'],
        borderWidth: 0,
        spacing: 4,
        borderRadius: 6,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: true,
      cutout: '74%',
      plugins: {
        legend: {
          display: true,
          position: 'bottom',
          labels: {
            padding: 14,
            usePointStyle: true,
            pointStyle: 'circle',
            font: { size: 11, weight: '500' },
          },
        },
        tooltip: {
          backgroundColor: '#1a1a2e',
          titleFont: { size: 12 },
          bodyFont: { size: 12 },
          padding: 10,
          cornerRadius: 8,
          borderColor: 'rgba(255,255,255,0.1)',
          borderWidth: 1,
        },
      },
    },
  });

  // Bar chart
  const barCtx = document.getElementById('bar-chart');
  barChart = new Chart(barCtx, {
    type: 'bar',
    data: {
      labels: (stats.days || []).map(d => d.label),
      datasets: [{
        label: 'Completed',
        data: (stats.days || []).map(d => d.count),
        backgroundColor: 'rgba(99, 102, 241, 0.5)',
        hoverBackgroundColor: 'rgba(99, 102, 241, 0.8)',
        borderRadius: 8,
        borderSkipped: false,
        barThickness: 20,
        maxBarThickness: 28,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        y: {
          beginAtZero: true,
          ticks: { stepSize: 1, font: { size: 10 } },
          grid: { color: 'rgba(255,255,255,0.03)' },
        },
        x: {
          grid: { display: false },
          ticks: { font: { size: 10 } },
        },
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#1a1a2e',
          padding: 10,
          cornerRadius: 8,
          borderColor: 'rgba(255,255,255,0.1)',
          borderWidth: 1,
        },
      },
    },
  });
}

function updateCharts() {
  if (donutChart) {
    donutChart.data.datasets[0].data = [
      stats.counts.high || 0,
      stats.counts.medium || 0,
      stats.counts.low || 0,
    ];
    donutChart.update('none'); // skip animation for snappy feel
  }

  if (barChart) {
    barChart.data.labels = (stats.days || []).map(d => d.label);
    barChart.data.datasets[0].data = (stats.days || []).map(d => d.count);
    barChart.update('none');
  }
}

// ── Mode Toggle ───────────────────────────────────────────
const MODES = ['default', 'focus', 'board'];
const MODE_ICONS = {
  default: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>`,
  focus: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="9" y1="3" x2="9" y2="21"/></svg>`,
  board: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>`,
};

function applyMode(mode) {
  document.body.classList.remove('mode-focus', 'mode-board');
  if (mode !== 'default') {
    document.body.classList.add(`mode-${mode}`);
  }
  modeToggle.innerHTML = MODE_ICONS[mode] || MODE_ICONS.default;
  modeToggle.title = `View: ${mode.charAt(0).toUpperCase() + mode.slice(1)}`;
  localStorage.setItem('kodo-mode', mode);
  currentMode = mode;
}

modeToggle.addEventListener('click', () => {
  const idx = MODES.indexOf(currentMode);
  const next = MODES[(idx + 1) % MODES.length];
  applyMode(next);
});

// ── Notes Panel ───────────────────────────────────────────
let memosLoaded = false;

function openNotes() {
  notesPanel.classList.add('open');
  notesOverlay.classList.remove('hidden');
  notesOverlay.classList.add('visible');
  notesToggle.classList.add('active');

  if (!memosLoaded) {
    fetch('/api/config')
      .then(r => r.json())
      .then(cfg => {
        memosIframe.src = cfg.memosUrl;
        memosLoaded = true;
      })
      .catch(() => {
        memosIframe.src = 'about:blank';
      });
  }
}

function closeNotes() {
  notesPanel.classList.remove('open');
  notesOverlay.classList.remove('visible');
  notesOverlay.classList.add('hidden');
  notesToggle.classList.remove('active');
}

notesToggle.addEventListener('click', () => {
  notesPanel.classList.contains('open') ? closeNotes() : openNotes();
});

notesClose.addEventListener('click', closeNotes);
notesOverlay.addEventListener('click', closeNotes);

// ── Keyboard Shortcut: Escape ─────────────────────────────
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (notesPanel.classList.contains('open')) {
      closeNotes();
    }
    hideContextMenu();
  }
});

// ── Utility ───────────────────────────────────────────────
function esc(str) {
  const el = document.createElement('span');
  el.textContent = str || '';
  return el.innerHTML;
}
