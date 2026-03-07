/* ═══════════════════════════════════════════════════════════
   Kōdō v2 — Frontend Logic
   ═══════════════════════════════════════════════════════════ */

// ── State ─────────────────────────────────────────────────────
let tasks     = { high: [], medium: [], low: [] };
let analytics = { streak: 0, completionRate: 0, avgTime: 0, dailyCompletions: [], prioritySplit: { now: 0, next: 0, later: 0 }, activeTasks: [] };
let calendarTasks  = [];
let calYear, calMonth;
let timelineChart  = null;
let donutChart     = null;
let currentTheme   = 'midnight';
let contextTarget  = null;
let completedPage  = 1;
let completedTotal = 0;
let memosLoaded    = false;
let restoredPriority = null; // used to animate restored task into correct bucket

// ── DOM refs ──────────────────────────────────────────────────
const taskInput    = document.getElementById('task-input');
const submitBtn    = document.getElementById('submit-btn');
const datePreview  = document.getElementById('date-preview');
const contextMenu  = document.getElementById('context-menu');
const panelOverlay = document.getElementById('panel-overlay');

// ── Init ──────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  // 1. Fetch config → apply theme immediately (prevents flash)
  try {
    const cfg = await fetch('/api/config').then(r => r.json());
    applyTheme(cfg.theme || 'midnight');

    // Populate settings panel inputs
    document.getElementById('settings-host').value  = cfg.ollamaHost  || 'http://localhost:11434';
    document.getElementById('settings-model').value = cfg.ollamaModel || 'gemma-fast';
  } catch (_) {
    applyTheme('midnight');
  }

  // 2. Load tasks + analytics in parallel
  await loadData();

  // 3. Build calendar
  buildCalendar();

  // 4. Focus input
  taskInput.focus();
});

// ── Load all data ─────────────────────────────────────────────
async function loadData() {
  try {
    const [tasksData, analyticsData] = await Promise.all([
      fetch('/api/tasks').then(r => r.json()),
      fetch('/api/analytics').then(r => r.json()),
    ]);
    tasks     = tasksData;
    analytics = analyticsData;
  } catch (err) {
    console.error('loadData failed:', err);
  }

  renderBuckets();
  updateStatCards();
  buildCharts();
  buildHeatmap();
  renderCalendar();
}

// ── Theme System ──────────────────────────────────────────────
function applyTheme(name) {
  currentTheme = name;
  document.documentElement.setAttribute('data-theme', name);
  highlightTC(name);
}

function setTheme(name) {
  applyTheme(name);
  // Persist to server
  fetch('/api/settings', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ theme: name }),
  }).catch(() => {});
  // Rebuild charts after CSS vars settle
  setTimeout(() => {
    buildCharts();
    buildHeatmap();
  }, 60);
}

function highlightTC(name) {
  document.querySelectorAll('.theme-card').forEach(card => {
    card.classList.toggle('active', card.dataset.theme === name);
  });
}

// ── Process Input — Two-Track ─────────────────────────────────
async function processInput() {
  const raw = taskInput.value.trim();
  if (!raw) return;

  // Lock UI
  taskInput.value = '';
  taskInput.disabled = true;
  submitBtn.disabled = true;
  submitBtn.textContent = 'Processing...';
  datePreview.classList.remove('show');

  // Extract calendar tasks from raw input (titles are raw for now)
  const datedTasks    = extractDatedTasks(raw);
  const calendarStart = calendarTasks.length;
  datedTasks.forEach(dt => calendarTasks.push(dt));

  // Client-side estimate scrape (Track B, step 1 — instant)
  const scraped  = scrapeEstimate(raw);
  const cleaned  = raw.replace(/~[\d.]+\s*(h|min)\b/gi, '').trim();

  try {
    // Track A — main AI call (blocks until task is rendered)
    const res  = await fetch('/api/categorize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: cleaned }),
    });
    const task = await res.json();

    // Backfill calendar entries with the SLM-rephrased title
    for (let i = calendarStart; i < calendarStart + datedTasks.length; i++) {
      calendarTasks[i].title = task.title;
    }

    // Inject into local state + render immediately
    tasks[task.priority].unshift(task);
    restoredPriority = task.priority;
    renderBuckets(true);
    restoredPriority = null;
    renderCalendar();

    // Track B — background estimate (UI never waits for this)
    if (scraped !== null) {
      updateTaskEstimate(task.id, scraped);
    } else {
      // Call qwen2.5:1.5b with the clean rephrased title
      callQwen(task.title).then(hrs => {
        if (hrs !== null) updateTaskEstimate(task.id, hrs);
      });
    }

    await refreshAnalytics();

  } catch (err) {
    console.error('processInput error:', err);
  } finally {
    taskInput.disabled = false;
    submitBtn.disabled = false;
    submitBtn.textContent = 'Process →';
    taskInput.focus();
  }
}

// Enter key also triggers processInput
taskInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') processInput();
});

// ── Estimate helpers ──────────────────────────────────────────
function scrapeEstimate(text) {
  const hMatch   = text.match(/~([\d.]+)\s*h\b/i);
  if (hMatch) return parseFloat(hMatch[1]);
  const minMatch = text.match(/~([\d.]+)\s*min\b/i);
  if (minMatch) return Math.round((parseFloat(minMatch[1]) / 60) * 10) / 10;
  return null;
}

async function callQwen(title) {
  try {
    const res  = await fetch('/api/estimate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: title }),
    });
    const data = await res.json();
    return data.hours !== undefined ? data.hours : null;
  } catch {
    return null;
  }
}

async function updateTaskEstimate(id, hours) {
  try {
    await fetch(`/api/tasks/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ est_hours: hours }),
    });
    // Re-fetch analytics to update timeline chart only
    const analyticsData = await fetch('/api/analytics').then(r => r.json());
    analytics = analyticsData;
    buildCharts();
  } catch (_) {}
}

// ── Analytics refresh ─────────────────────────────────────────
async function refreshAnalytics() {
  try {
    analytics = await fetch('/api/analytics').then(r => r.json());
    updateStatCards();
    buildCharts();
    buildHeatmap();
  } catch (_) {}
}

// ── Stat Cards ────────────────────────────────────────────────
function updateStatCards() {
  document.getElementById('stat-streak').textContent  = analytics.streak || 0;
  document.getElementById('stat-rate').textContent    = (analytics.completionRate || 0) + '%';
  const avg = analytics.avgTime || 0;
  document.getElementById('stat-avgtime').textContent = avg > 0 ? avg + 'h' : '—';
}

// ── Charts ────────────────────────────────────────────────────
function buildCharts() {
  if (timelineChart) { timelineChart.destroy(); timelineChart = null; }
  if (donutChart)    { donutChart.destroy();    donutChart    = null; }

  const cs        = getComputedStyle(document.documentElement);
  const nowColor  = cs.getPropertyValue('--now').trim();
  const nextColor = cs.getPropertyValue('--next').trim();
  const laterColor= cs.getPropertyValue('--later').trim();
  const bg2       = cs.getPropertyValue('--bg2').trim();
  const border    = cs.getPropertyValue('--border').trim();
  const text2     = cs.getPropertyValue('--text-2').trim();
  const text3     = cs.getPropertyValue('--text-3').trim();

  // — Timeline (horizontal bar) ——————————
  const activeTasks    = analytics.activeTasks || [];
  const tasksWithTime  = activeTasks.filter(t => t.est_hours && t.est_hours > 0);
  const timelineWrap   = document.getElementById('timeline-chart-wrap');
  const timelineEmpty  = document.getElementById('timeline-empty');
  const timelineCanvas = document.getElementById('timeline-chart');

  if (tasksWithTime.length === 0) {
    timelineCanvas.style.display = 'none';
    timelineEmpty.classList.remove('hidden');
  } else {
    timelineCanvas.style.display = '';
    timelineEmpty.classList.add('hidden');

    const labels      = tasksWithTime.map(t => t.title.substring(0, 28));
    const barColors   = tasksWithTime.map(t =>
      t.priority === 'high' ? nowColor + 'aa' : t.priority === 'medium' ? nextColor + 'aa' : laterColor + 'aa'
    );
    const bdColors    = tasksWithTime.map(t =>
      t.priority === 'high' ? nowColor : t.priority === 'medium' ? nextColor : laterColor
    );

    timelineChart = new Chart(timelineCanvas, {
      type: 'bar',
      data: {
        labels,
        datasets: [{
          data: tasksWithTime.map(t => t.est_hours),
          backgroundColor: barColors,
          borderColor:     bdColors,
          borderWidth: 1,
          borderRadius: 6,
          borderSkipped: false,
        }],
      },
      options: {
        indexAxis: 'y',
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: bg2,
            borderColor: border,
            borderWidth: 1,
            callbacks: { label: ctx => ` ${ctx.raw}h` },
          },
        },
        scales: {
          x: {
            beginAtZero: true,
            grid: { color: border + '44' },
            ticks: {
              callback: v => v + 'h',
              font: { family: "'JetBrains Mono', monospace", size: 10 },
              color: text3,
            },
          },
          y: {
            grid: { display: false },
            ticks: {
              font: { family: "'Syne', sans-serif", size: 11 },
              color: text2,
            },
          },
        },
      },
    });
  }

  // — Priority Donut ————————————————————
  const ps       = analytics.prioritySplit || { now: 0, next: 0, later: 0 };
  const donutCtx = document.getElementById('donut-chart');
  if (donutCtx) {
    donutChart = new Chart(donutCtx, {
      type: 'doughnut',
      data: {
        labels: ['Now', 'Next', 'Later'],
        datasets: [{
          data: [ps.now, ps.next, ps.later],
          backgroundColor: [nowColor, nextColor, laterColor],
          borderWidth: 0,
          spacing: 2,
        }],
      },
      options: {
        cutout: '68%',
        maintainAspectRatio: false,
        plugins: {
          legend: {
            display: true,
            position: 'bottom',
            labels: {
              font: { family: "'JetBrains Mono', monospace", size: 9 },
              color: text2,
              padding: 8,
              usePointStyle: true,
              pointStyle: 'circle',
            },
          },
          tooltip: {
            backgroundColor: bg2,
            borderColor: border,
            borderWidth: 1,
          },
        },
      },
    });
  }
}

// ── Heatmap ────────────────────────────────────────────────────
function buildHeatmap() {
  const heatmap = document.getElementById('heatmap');
  const data    = analytics.dailyCompletions || [];
  const maxCnt  = Math.max(...data.map(d => d.count), 1);

  heatmap.innerHTML = data.map(d => {
    const pct    = d.count / maxCnt;
    const height = d.count === 0 ? 6 : Math.max(14, pct * 100);
    const opacity= d.count === 0 ? 0.1 : 0.15 + pct * 0.85;
    return `
      <div class="heatmap-col">
        <div class="heatmap-bar" title="${d.count} tasks" style="height:${height}px;opacity:${opacity}"></div>
        <span class="heatmap-lbl">${esc(d.label)}</span>
      </div>`;
  }).join('');
}

// ── Bucket Rendering ──────────────────────────────────────────
function renderBuckets(animate = false) {
  renderBucket('high',   'now',   animate);
  renderBucket('medium', 'next',  animate);
  renderBucket('low',    'later', animate);
}

function renderBucket(priority, slot, animate) {
  const container = document.getElementById(`tasks-${slot}`);
  const countEl   = document.getElementById(`count-${slot}`);
  if (!container) return;

  const list = tasks[priority] || [];
  countEl.textContent = list.length;

  if (list.length === 0) {
    container.innerHTML = '<div class="bucket-empty">All clear</div>';
    return;
  }

  container.innerHTML = list.map((task, i) => {
    const isNew = animate && i === 0 && restoredPriority === priority;
    return `
      <div class="task-card ${isNew ? 'task-entering' : ''}"
           data-id="${task.id}"
           oncontextmenu="showContextMenu(event,${task.id},'${priority}')">
        <button class="task-card-check"
                onclick="event.stopPropagation();completeTask(${task.id},'${priority}')"
                title="Complete"></button>
        <div class="task-card-body">
          <div class="task-card-title" data-id="${task.id}">${esc(task.title)}</div>
          ${task.description ? `<div class="task-card-desc">${esc(task.description)}</div>` : ''}
        </div>
        ${task.est_hours ? `<span class="task-card-time">~${task.est_hours}h</span>` : ''}
      </div>`;
  }).join('');
}

// ── Task Actions ──────────────────────────────────────────────
async function completeTask(id, priority) {
  const taskEls = document.querySelector(`[data-id="${id}"].task-card`);
  if (taskEls) {
    taskEls.style.transition = 'opacity 250ms, transform 250ms';
    taskEls.style.opacity    = '0';
    taskEls.style.transform  = 'translateX(12px)';
    await new Promise(r => setTimeout(r, 250));
  }

  try {
    await fetch(`/api/tasks/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ done: 1 }),
    });
    // Remove from local state
    tasks[priority] = tasks[priority].filter(t => t.id !== id);
    renderBuckets();
    await refreshAnalytics();
  } catch (err) {
    console.error('completeTask failed:', err);
    await loadData();
  }
}

async function deleteTask(id, priority) {
  try {
    await fetch(`/api/tasks/${id}`, { method: 'DELETE' });
    tasks[priority] = (tasks[priority] || []).filter(t => t.id !== id);
    renderBuckets();
    await refreshAnalytics();
  } catch (err) {
    console.error('deleteTask failed:', err);
  }
}

async function moveTask(id, fromPriority, toPriority) {
  try {
    await fetch(`/api/tasks/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ priority: toPriority }),
    });
    await loadData();
  } catch (err) {
    console.error('moveTask failed:', err);
  }
}

// ── Inline Edit ───────────────────────────────────────────────
function startEditTask(id) {
  const titleEl = document.querySelector(`.task-card-title[data-id="${id}"]`);
  if (!titleEl) return;

  const original = titleEl.textContent;
  const input    = document.createElement('input');
  input.type      = 'text';
  input.value     = original;
  input.className = 'inline-edit-input';

  titleEl.replaceWith(input);
  input.focus();
  input.select();

  const save = async () => {
    const newTitle = input.value.trim() || original;
    try {
      await fetch(`/api/tasks/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: newTitle }),
      });
      await loadData();
    } catch (_) {
      await loadData();
    }
  };

  const cancel = () => {
    input.replaceWith(titleEl);
  };

  input.addEventListener('keydown', e => {
    if (e.key === 'Enter')  { e.preventDefault(); save(); }
    if (e.key === 'Escape') { e.preventDefault(); cancel(); }
  });
  input.addEventListener('blur', save);
}

// ── Context Menu ──────────────────────────────────────────────
function showContextMenu(e, taskId, priority) {
  e.preventDefault();
  e.stopPropagation();
  contextTarget = { id: taskId, priority };

  const x = Math.min(e.clientX || 0, window.innerWidth  - 180);
  const y = Math.min(e.clientY || 0, window.innerHeight - 220);
  contextMenu.style.left = x + 'px';
  contextMenu.style.top  = y + 'px';
  contextMenu.classList.remove('hidden');

  // Dim "move to current" option
  contextMenu.querySelectorAll('[data-action^="move-"]').forEach(btn => {
    const p = btn.dataset.action.replace('move-', '');
    btn.style.opacity       = p === priority ? '0.35' : '1';
    btn.style.pointerEvents = p === priority ? 'none'  : 'auto';
  });
}

function hideContextMenu() {
  contextMenu.classList.add('hidden');
  contextTarget = null;
}

contextMenu.addEventListener('click', e => {
  const action = e.target.dataset.action;
  if (!action || !contextTarget) return;

  const { id, priority } = contextTarget;

  if (action === 'edit') {
    startEditTask(id);
  } else if (action === 'delete') {
    deleteTask(id, priority);
  } else if (action.startsWith('move-')) {
    const newPriority = action.replace('move-', '');
    moveTask(id, priority, newPriority);
  }

  hideContextMenu();
});

document.addEventListener('click', e => {
  if (!contextMenu.contains(e.target)) hideContextMenu();
});
document.addEventListener('touchstart', e => {
  if (!contextMenu.contains(e.target)) hideContextMenu();
});

// ── Panels ────────────────────────────────────────────────────
function openPanel(id) {
  // Close any open panels first
  document.querySelectorAll('.panel.open').forEach(p => p.classList.remove('open'));
  document.getElementById(id).classList.add('open');
  panelOverlay.classList.add('visible');

  // Update active state on header buttons
  document.querySelectorAll('.btn').forEach(b => b.classList.remove('active'));
  if (id === 'panel-completed') document.getElementById('btn-completed').classList.add('active');
  if (id === 'panel-settings')  document.getElementById('btn-settings').classList.add('active');
  if (id === 'panel-notes')     document.getElementById('btn-notes').classList.add('active');
}

function closeAllPanels() {
  document.querySelectorAll('.panel.open').forEach(p => p.classList.remove('open'));
  panelOverlay.classList.remove('visible');
  document.querySelectorAll('.btn').forEach(b => {
    if (b.id !== 'btn-today') b.classList.remove('active');
  });
}

// Header button handlers
document.getElementById('btn-settings').addEventListener('click', () => {
  openPanel('panel-settings');
});

document.getElementById('btn-completed').addEventListener('click', () => {
  openPanel('panel-completed');
  loadCompleted();
});

document.getElementById('btn-today').addEventListener('click', () => {
  shiftMonth(0);
  closeAllPanels();
  document.getElementById('calendar-section') &&
    document.querySelector('.calendar-section').scrollIntoView({ behavior: 'smooth' });
});

document.getElementById('btn-notes').addEventListener('click', () => {
  if (!memosLoaded) {
    fetch('/api/config').then(r => r.json()).then(cfg => {
      document.getElementById('memos-iframe').src = cfg.memosUrl || 'about:blank';
      memosLoaded = true;
    }).catch(() => {});
  }
  openPanel('panel-notes');
});

// ── Completed Panel ───────────────────────────────────────────
async function loadCompleted() {
  completedPage = 1;
  try {
    const data = await fetch(`/api/tasks/completed?page=1&limit=15`).then(r => r.json());
    completedTotal = data.total;
    renderCompleted(data.tasks, false);
    updateLoadMoreBtn();
  } catch (err) {
    console.error('loadCompleted failed:', err);
  }
}

async function loadMoreCompleted() {
  completedPage++;
  try {
    const data = await fetch(`/api/tasks/completed?page=${completedPage}&limit=15`).then(r => r.json());
    renderCompleted(data.tasks, true);
    updateLoadMoreBtn();
  } catch (err) {
    console.error('loadMoreCompleted failed:', err);
  }
}

function updateLoadMoreBtn() {
  const btn    = document.getElementById('load-more-btn');
  const loaded = completedPage * 15;
  btn.classList.toggle('hidden', loaded >= completedTotal);
}

function renderCompleted(items, append) {
  const list = document.getElementById('completed-list');
  const html = items.map(item => {
    const slot  = item.priority === 'high' ? 'now' : item.priority === 'medium' ? 'next' : 'later';
    const color = `var(--${slot})`;
    return `
      <div class="completed-item" data-id="${item.id}" data-priority="${item.priority}">
        <div class="completed-item-info">
          <span class="completed-dot" style="background:${color}"></span>
          <span class="completed-title">${esc(item.title)}</span>
        </div>
        <div class="completed-item-meta">
          <span class="completed-time">${formatRelativeTime(item.completed_at)}</span>
          <button class="restore-btn" onclick="restoreTask(${item.id},'${item.priority}')">↩ restore</button>
        </div>
      </div>`;
  }).join('');

  if (append) {
    list.insertAdjacentHTML('beforeend', html);
  } else {
    list.innerHTML = html;
  }
}

async function restoreTask(id, priority) {
  const item = document.querySelector(`.completed-item[data-id="${id}"]`);
  if (item) {
    item.style.transition = 'opacity 280ms, transform 280ms';
    item.style.opacity    = '0';
    item.style.transform  = 'translateX(16px)';
    await new Promise(r => setTimeout(r, 280));
    item.remove();
  }

  try {
    await fetch(`/api/tasks/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ done: 0 }),
    });

    completedTotal--;
    updateLoadMoreBtn();

    // Re-fetch and animate the restored task into its bucket
    restoredPriority = priority;
    await loadData();
    restoredPriority = null;

    // Briefly flash the count badge
    const slot  = priority === 'high' ? 'now' : priority === 'medium' ? 'next' : 'later';
    const badge = document.getElementById(`count-${slot}`);
    if (badge) {
      badge.style.transition = 'transform 0.2s';
      badge.style.transform  = 'scale(1.4)';
      setTimeout(() => { badge.style.transform = 'scale(1)'; }, 200);
    }
  } catch (err) {
    console.error('restoreTask failed:', err);
    await loadData();
  }
}

function formatRelativeTime(ts) {
  if (!ts) return '';
  const diff  = Date.now() - new Date(ts).getTime();
  const mins  = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days  = Math.floor(diff / 86400000);
  if (mins  <  1) return 'just now';
  if (mins  < 60) return `${mins}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days  ===1) return 'Yesterday';
  return `${days}d ago`;
}

// ── Settings Panel Actions ────────────────────────────────────
async function saveOllamaConfig() {
  const host  = document.getElementById('settings-host').value.trim();
  const model = document.getElementById('settings-model').value.trim();
  if (!host || !model) return;

  try {
    await fetch('/api/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ollama_host: host, ollama_model: model }),
    });
  } catch (err) {
    console.error('saveOllamaConfig failed:', err);
  }
}

async function bulkAction(action) {
  try {
    await fetch('/api/tasks/bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action }),
    });
    await loadData();
    if (document.getElementById('panel-completed').classList.contains('open')) {
      loadCompleted();
    }
  } catch (err) {
    console.error('bulkAction failed:', err);
  }
}

// ── Calendar ──────────────────────────────────────────────────
function buildCalendar() {
  const now = new Date();
  calYear   = now.getFullYear();
  calMonth  = now.getMonth();
  renderCalendar();
  updateTodayBtn();
}

function shiftMonth(dir) {
  if (dir === 0) {
    const now = new Date();
    calYear   = now.getFullYear();
    calMonth  = now.getMonth();
  } else {
    calMonth += dir;
    if (calMonth > 11) { calMonth = 0; calYear++; }
    if (calMonth <  0) { calMonth = 11; calYear--; }
  }
  renderCalendar();
  updateTodayBtn();
}

function updateTodayBtn() {
  const now     = new Date();
  const isToday = calYear === now.getFullYear() && calMonth === now.getMonth();
  document.getElementById('btn-today').classList.toggle('active', isToday);
}

function renderCalendar() {
  const MONTHS    = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const label     = document.getElementById('cal-month-label');
  const grid      = document.getElementById('cal-grid');
  if (!label || !grid) return;

  label.textContent = `${MONTHS[calMonth]} ${calYear}`;

  // Rebuild grid from scratch (DOW headers + day cells)
  grid.innerHTML = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun']
    .map(d => `<div class="cal-dow">${d}</div>`).join('');

  const today     = new Date();
  const firstDay  = new Date(calYear, calMonth, 1);
  // Mon = 0 ... Sun = 6
  let startOffset = firstDay.getDay() - 1;
  if (startOffset < 0) startOffset = 6;

  const daysInMonth = new Date(calYear, calMonth + 1, 0).getDate();
  const daysInPrev  = new Date(calYear, calMonth, 0).getDate();
  const totalCells  = Math.ceil((startOffset + daysInMonth) / 7) * 7;

  const cells = [];

  for (let i = 0; i < totalCells; i++) {
    let day, month, year, isOtherMonth = false;

    if (i < startOffset) {
      day   = daysInPrev - startOffset + i + 1;
      month = calMonth - 1;
      year  = calYear;
      if (month < 0) { month = 11; year--; }
      isOtherMonth = true;
    } else if (i >= startOffset + daysInMonth) {
      day   = i - startOffset - daysInMonth + 1;
      month = calMonth + 1;
      year  = calYear;
      if (month > 11) { month = 0; year++; }
      isOtherMonth = true;
    } else {
      day   = i - startOffset + 1;
      month = calMonth;
      year  = calYear;
    }

    const isToday = !isOtherMonth &&
                    day   === today.getDate() &&
                    month === today.getMonth() &&
                    year  === today.getFullYear();

    // Collect tasks for this cell
    const cellDate  = `${year}-${String(month + 1).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
    const dayTasks  = calendarTasks.filter(t => {
      const d = t.date;
      return d.getFullYear() === year && d.getMonth() === month && d.getDate() === day;
    });

    const hasTasks   = dayTasks.length > 0;
    const visibleChips = dayTasks.slice(0, 3);
    const overflow     = dayTasks.length - visibleChips.length;

    const chipsHtml = visibleChips.map(t => {
      const slot = t.priority === 'high' ? 'now' : t.priority === 'medium' ? 'next' : 'later';
      return `<span class="cal-chip cal-chip-${slot}">${esc(t.title.substring(0,14))}</span>`;
    }).join('') + (overflow > 0 ? `<span class="cal-chip cal-chip-more">+${overflow} more</span>` : '');

    cells.push(`
      <div class="cal-day${isOtherMonth ? ' other-month' : ''}${isToday ? ' today' : ''}${hasTasks ? ' has-tasks' : ''}">
        <span class="cal-day-num">${day}</span>
        ${hasTasks ? `<div class="cal-chips">${chipsHtml}</div>` : ''}
      </div>`);
  }

  grid.innerHTML += cells.join('');
}

// ── Date Preview ──────────────────────────────────────────────
function previewDate(val) {
  if (!val.trim()) {
    datePreview.classList.remove('show');
    return;
  }

  const fragments = val.split(/[,;]/);
  for (const frag of fragments) {
    const date = parseDate(frag.trim());
    if (date) {
      const formatted = date.toLocaleDateString('en', { weekday: 'short', day: 'numeric', month: 'short' });
      const title     = frag.replace(/~[\d.]+\s*(h|min)\b/gi, '').trim().substring(0, 30);
      datePreview.textContent = `📅 detected: "${title}" → ${formatted}`;
      datePreview.classList.add('show');
      return;
    }
  }
  datePreview.classList.remove('show');
}

// ── Extract Dated Tasks from Raw Input ────────────────────────
function extractDatedTasks(raw) {
  const fragments = raw.split(/[,;]/);
  const result    = [];
  const today     = new Date();
  today.setHours(0,0,0,0);

  for (const frag of fragments) {
    const trimmed = frag.trim();
    const date    = parseDate(trimmed);
    if (!date) continue;

    const title     = trimmed.replace(/~[\d.]+\s*(h|min)\b/gi, '').trim();
    const diffDays  = Math.round((date - today) / 86400000);
    const priority  = diffDays <= 1 ? 'high' : diffDays <= 6 ? 'medium' : 'low';
    result.push({ title, date, priority });
  }
  return result;
}

// ── Client-Side Date Parser ───────────────────────────────────
function parseDate(text) {
  const t      = text.toLowerCase();
  const today  = new Date();
  today.setHours(0,0,0,0);

  if (/\btoday\b/.test(t)) return new Date(today);

  if (/\btomorrow\b/.test(t)) {
    const d = new Date(today); d.setDate(d.getDate() + 1); return d;
  }

  // "this weekend" → coming Saturday
  if (/\bthis weekend\b/.test(t)) {
    const d    = new Date(today);
    const curr = d.getDay(); // 0=Sun,6=Sat
    const diff = curr === 6 ? 0 : 6 - curr;
    d.setDate(d.getDate() + diff);
    return d;
  }

  // "next weekend" → Saturday of next week
  if (/\bnext weekend\b/.test(t)) {
    const d    = new Date(today);
    const curr = d.getDay();
    const diff = curr === 6 ? 7 : 6 - curr + 7;
    d.setDate(d.getDate() + diff);
    return d;
  }

  // "next week" → coming Monday
  if (/\bnext week\b/.test(t)) {
    const d    = new Date(today);
    const curr = d.getDay();
    const daysToMon = curr === 0 ? 1 : 8 - curr;
    d.setDate(d.getDate() + daysToMon);
    return d;
  }

  // "next month" → 1st of next month
  if (/\bnext month\b/.test(t)) {
    const d = new Date(today);
    d.setMonth(d.getMonth() + 1, 1);
    return d;
  }

  // "end of month" / "end of the month"
  if (/\bend of (the )?month\b/.test(t)) {
    const d = new Date(today.getFullYear(), today.getMonth() + 1, 0);
    return d;
  }

  // "in X days"
  const inDays = t.match(/\bin (\d+) days?\b/);
  if (inDays) {
    const d = new Date(today); d.setDate(d.getDate() + parseInt(inDays[1])); return d;
  }

  // "in X weeks"
  const inWeeks = t.match(/\bin (\d+) weeks?\b/);
  if (inWeeks) {
    const d = new Date(today); d.setDate(d.getDate() + parseInt(inWeeks[1]) * 7); return d;
  }

  // "in X months"
  const inMonths = t.match(/\bin (\d+) months?\b/);
  if (inMonths) {
    const d = new Date(today); d.setMonth(d.getMonth() + parseInt(inMonths[1])); return d;
  }

  const DAYS = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];

  const nextDay = t.match(/\bnext\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/);
  if (nextDay) {
    const target = DAYS.indexOf(nextDay[1]);
    const d      = new Date(today);
    const curr   = d.getDay();
    let diff     = target - curr;
    if (diff <= 0) diff += 7;
    d.setDate(d.getDate() + diff);
    return d;
  }

  const thisDay = t.match(/\bthis\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/);
  if (thisDay) {
    const target = DAYS.indexOf(thisDay[1]);
    const d      = new Date(today);
    const curr   = d.getDay();
    let diff     = target - curr;
    if (diff < 0) diff += 7;
    d.setDate(d.getDate() + diff);
    return d;
  }

  // Standalone weekday name → next occurrence
  for (let i = 0; i < DAYS.length; i++) {
    if (new RegExp(`\\b${DAYS[i]}\\b`).test(t)) {
      const d    = new Date(today);
      const curr = d.getDay();
      let diff   = i - curr;
      if (diff <= 0) diff += 7;
      d.setDate(d.getDate() + diff);
      return d;
    }
  }

  const MONTHS = ['january','february','march','april','may','june','july','august','september','october','november','december'];
  const MON_SHORT = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];

  // "Month D" or "Month Dth"
  const monthFirst = t.match(/\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec)\s+(\d{1,2})(?:st|nd|rd|th)?\b/);
  if (monthFirst) {
    const mIdx  = MONTHS.indexOf(monthFirst[1]) !== -1 ? MONTHS.indexOf(monthFirst[1]) : MON_SHORT.indexOf(monthFirst[1]);
    const day   = parseInt(monthFirst[2]);
    if (mIdx >= 0 && day >= 1 && day <= 31) {
      const d = new Date(today.getFullYear(), mIdx, day);
      if (d < today) d.setFullYear(d.getFullYear() + 1);
      return d;
    }
  }

  // "D Month" or "Dth Month"
  const dayFirst = t.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec)\b/);
  if (dayFirst) {
    const day  = parseInt(dayFirst[1]);
    const mIdx = MONTHS.indexOf(dayFirst[2]) !== -1 ? MONTHS.indexOf(dayFirst[2]) : MON_SHORT.indexOf(dayFirst[2]);
    if (mIdx >= 0 && day >= 1 && day <= 31) {
      const d = new Date(today.getFullYear(), mIdx, day);
      if (d < today) d.setFullYear(d.getFullYear() + 1);
      return d;
    }
  }

  // MM/DD (e.g. 3/15 = March 15)
  const mmdd = t.match(/\b(\d{1,2})\/(\d{1,2})\b/);
  if (mmdd) {
    const month = parseInt(mmdd[1]) - 1;
    const day   = parseInt(mmdd[2]);
    if (month >= 0 && month <= 11 && day >= 1 && day <= 31) {
      const d = new Date(today.getFullYear(), month, day);
      if (d < today) d.setFullYear(d.getFullYear() + 1);
      return d;
    }
  }

  // YYYY-MM-DD or YYYY/MM/DD
  const iso = t.match(/\b(\d{4})[-/](\d{1,2})[-/](\d{1,2})\b/);
  if (iso) {
    const d = new Date(parseInt(iso[1]), parseInt(iso[2]) - 1, parseInt(iso[3]));
    if (!isNaN(d)) return d;
  }

  return null;
}

// ── Keyboard Shortcuts ────────────────────────────────────────
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    closeAllPanels();
    hideContextMenu();
  }
});

// ── Utility ───────────────────────────────────────────────────
function esc(str) {
  const el = document.createElement('span');
  el.textContent = str || '';
  return el.innerHTML;
}
