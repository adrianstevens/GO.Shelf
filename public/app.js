/* go-shelf frontend */

// ── State ──────────────────────────────────────────────────────────────────
let allGames       = [];
let queueItems     = [];
let gameSizes      = {};   // gameId -> { bytes, releaseTimestamp }
let libraryPlatform     = 'windows';  // global platform for sizes/stats
let activePlatform      = 'windows';  // platform selected inside the modal
let modalGameId         = null;
let currentView         = 'grid';
let currentCategory     = '';
let dlFilter            = 'all'; // 'all' | 'yes' | 'no'
let currentModalDetails = null;

// ── Sort ───────────────────────────────────────────────────────────────────
let currentSort = 'name-asc';

// Extract "YYYY-MM-DD" string from a library product's releaseDate object,
// falling back to the GOG catalog timestamp from scanned game details.
function releaseDate(game) {
  const d = game.releaseDate?.date?.slice(0, 10);
  if (d) return d;
  const ts = gameSizes[String(game.id)]?.releaseTimestamp;
  if (ts) return new Date(ts * 1000).toISOString().slice(0, 10);
  return '';
}

function sortedGames(games) {
  const sorted = [...games];
  switch (currentSort) {
    case 'name-asc':   return sorted.sort((a, b) => a.title.localeCompare(b.title));
    case 'name-desc':  return sorted.sort((a, b) => b.title.localeCompare(a.title));
    case 'year-desc':  return sorted.sort((a, b) => releaseDate(b).localeCompare(releaseDate(a)));
    case 'year-asc':   return sorted.sort((a, b) => {
      const da = releaseDate(a), db = releaseDate(b);
      // Push unknown dates to the bottom
      if (!da && !db) return 0;
      if (!da) return 1;
      if (!db) return -1;
      return da.localeCompare(db);
    });
    case 'size-desc':  return sorted.sort((a, b) => (gameSizes[String(b.id)]?.bytes ?? 0) - (gameSizes[String(a.id)]?.bytes ?? 0));
    case 'size-asc':   return sorted.sort((a, b) => (gameSizes[String(a.id)]?.bytes ?? 0) - (gameSizes[String(b.id)]?.bytes ?? 0));
    default:           return sorted;
  }
}

// Return the highest-priority active queue item for a game.
// Priority: downloading > queued > failed > completed
function getGameStatus(gameId) {
  const id = String(gameId);
  for (const status of ['downloading', 'queued', 'failed', 'completed']) {
    const item = queueItems.find(q => (q.game_id === id || q.gameId === id) && q.status === status);
    if (item) return item;
  }
  return null;
}

// ── DOM refs ───────────────────────────────────────────────────────────────
const loginScreen   = document.getElementById('login-screen');
const libraryScreen = document.getElementById('library-screen');
const libraryMeta   = document.getElementById('library-meta');
const gameGrid      = document.getElementById('game-grid');
const searchInput   = document.getElementById('search');
const sortSelect    = document.getElementById('sort-select');
const viewToggle    = document.getElementById('view-toggle');
const viewGridBtn   = document.getElementById('view-grid');
const viewListBtn   = document.getElementById('view-list');
const gameList      = document.getElementById('game-list');
const platformToggle   = document.getElementById('platform-toggle');
const platBtns         = { windows: document.getElementById('plat-windows'), linux: document.getElementById('plat-linux'), mac: document.getElementById('plat-mac') };
const catFilter        = document.getElementById('cat-filter');
const dlFilterSelect   = document.getElementById('dl-filter');
const refreshBtn       = document.getElementById('refresh-btn');
const logoutBtn        = document.getElementById('logout-btn');
const queueToggle   = document.getElementById('queue-toggle');
const queueBadge    = document.getElementById('queue-badge');
const queuePanel    = document.getElementById('queue-panel');
const queueClose    = document.getElementById('queue-close');
const queueList     = document.getElementById('queue-list');

// ── Boot ───────────────────────────────────────────────────────────────────
(async () => {
  const { authenticated } = await api('/api/auth/status');
  if (!authenticated) {
    show(loginScreen);
    setupLoginFlow();
    return;
  }
  showLibrary();
  connectSSE();
  loadQueue();
  loadStats();
  loadSizes();
})();

function setupLoginFlow() {
  // Show paste step after user clicks the sign-in link
  document.getElementById('login-link').addEventListener('click', () => {
    document.getElementById('paste-step').style.display = '';
  });

  document.getElementById('submit-code').addEventListener('click', async () => {
    const raw = document.getElementById('redirect-url').value.trim();
    const errEl = document.getElementById('auth-error');
    errEl.style.display = 'none';

    // Accept either the full URL or just the code
    let code = raw;
    try {
      const url = new URL(raw);
      code = url.searchParams.get('code') || raw;
    } catch {}

    if (!code) {
      errEl.textContent = 'No code found in URL.';
      errEl.style.display = '';
      return;
    }

    try {
      await api('/api/auth/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      });
      location.reload();
    } catch (err) {
      errEl.textContent = `Failed: ${err.message}`;
      errEl.style.display = '';
    }
  });
}

// ── Stats & scan ──────────────────────────────────────────────────────────
const scanBtn          = document.getElementById('scan-btn');
const updateBtn        = document.getElementById('update-btn');
const scanStatus       = document.getElementById('scan-status');
const scanProgressFill = document.getElementById('scan-progress-fill');
const statGames        = document.getElementById('stat-games');
const statTotalSize    = document.getElementById('stat-total-size');
const statDownloaded   = document.getElementById('stat-downloaded');

async function loadStats() {
  try {
    const s = await api(`/api/stats?platform=${libraryPlatform}`);
    updateStats(s, allGames.length || undefined);
  } catch {}
}

async function loadSizes() {
  try {
    gameSizes = await api(`/api/sizes?platform=${libraryPlatform}`);
    renderGames(allGames);
  } catch {}
}

function updateStats({ scannedGames, totalBytes, downloadedBytes, downloadedCount, scanRunning }, total) {
  const n = total ?? allGames.length;
  statGames.textContent = n ? `${n} games` : '—';
  statTotalSize.textContent = scannedGames
    ? `${fmtBytes(totalBytes)}${scannedGames < n ? ` (${scannedGames}/${n} scanned)` : ''}`
    : '—';
  statDownloaded.textContent = downloadedCount
    ? `${fmtBytes(downloadedBytes)} (${downloadedCount} files)`
    : downloadedCount === 0 ? 'None yet' : '—';

  if (scanRunning) {
    scanBtn.disabled = true;
    scanBtn.textContent = 'Scanning…';
  } else {
    scanBtn.disabled = false;
    scanBtn.textContent = scannedGames >= n && n > 0 ? 'Rescan' : 'Scan Collection';
    if (scannedGames > 0) {
      scanStatus.textContent = `${scannedGames}/${n} games scanned`;
      scanProgressFill.style.width = n ? `${Math.round(scannedGames / n * 100)}%` : '0%';
    } else {
      scanStatus.textContent = 'Not scanned';
      scanProgressFill.style.width = '0%';
    }
  }
}

scanBtn.addEventListener('click', async () => {
  const force = scanBtn.textContent === 'Rescan';
  scanBtn.disabled = true;
  scanBtn.textContent = 'Starting…';
  await api('/api/scan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ force }),
  });
});

updateBtn.addEventListener('click', async () => {
  updateBtn.disabled = true;
  updateBtn.textContent = 'Starting…';
  await api('/api/updates', { method: 'POST' });
});

// ── Library ────────────────────────────────────────────────────────────────
async function showLibrary() {
  show(libraryScreen);
  refreshBtn.style.display      = '';
  logoutBtn.style.display       = '';
  queueToggle.style.display     = '';
  platformToggle.style.display  = '';
  viewToggle.style.display      = '';
  sortSelect.style.display      = '';
  catFilter.style.display        = '';
  dlFilterSelect.style.display   = '';

  libraryMeta.textContent = 'Loading library…';
  gameGrid.innerHTML = '';

  try {
    allGames = await api('/api/library');
    buildCategoryFilter();
    renderGames(allGames);
    libraryMeta.textContent = '';
    loadStats();
  } catch (err) {
    libraryMeta.textContent = `Error: ${err.message}`;
  }
}

function renderGames(games) {
  if (currentView === 'list') renderListView(games);
  else renderGridView(games);
  const shown = filteredSorted(games).length;
  const total = allGames.length;
  statGames.textContent = shown < total ? `${shown} of ${total} games` : `${total} games`;
}

function filteredSorted(games) {
  const q = searchInput.value.trim().toLowerCase();
  let filtered = q ? games.filter(g => g.title.toLowerCase().includes(q)) : games;
  if (currentCategory) filtered = filtered.filter(g => g.category === currentCategory);
  if (dlFilter !== 'all') {
    const isDownloaded = g => queueItems.some(qi => (qi.game_id === String(g.id) || qi.gameId === String(g.id)) && qi.status === 'completed');
    filtered = filtered.filter(dlFilter === 'yes' ? isDownloaded : g => !isDownloaded(g));
  }
  return sortedGames(filtered);
}

function buildCategoryFilter() {
  const cats = [...new Set(allGames.map(g => g.category).filter(Boolean))].sort();
  catFilter.innerHTML = '<option value="">All categories</option>' +
    cats.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
  catFilter.value = currentCategory;
}

function renderGridView(games) {
  gameList.style.display = 'none';
  gameGrid.style.display = '';
  const filtered = filteredSorted(games);
  gameGrid.innerHTML = '';
  for (const g of filtered) {
    const card = document.createElement('div');
    card.className = 'game-card';
    card.dataset.id = g.id;
    const sz = gameSizes[String(g.id)];
    const bytes = sz?.bytes;
    const hasUpdate = sz?.hasUpdate;
    const downloaded = queueItems.some(q => (q.game_id === String(g.id) || q.gameId === String(g.id)) && q.status === 'completed');
    const statusItem = getGameStatus(g.id);
    let progressPct = 0;
    if (statusItem && statusItem.status !== 'completed') {
      card.classList.add(statusItem.status);
      if (statusItem.status === 'downloading' && statusItem.bytes_total) {
        progressPct = Math.round(statusItem.bytes_downloaded / statusItem.bytes_total * 100);
      }
    } else if (downloaded) {
      card.classList.add('downloaded');
    } else if (hasUpdate) {
      card.classList.add('has-update');
    }
    const sizeText = hasUpdate && !statusItem
      ? '<span class="update-tag">↑ Update</span>'
      : bytes ? (downloaded ? '✓ ' : '') + fmtBytes(bytes) : '';
    card.innerHTML = `
      <img src="https:${g.image}_196.jpg" alt="" loading="lazy" onerror="this.style.display='none'" />
      <div class="game-card-title" title="${esc(g.title)}">${esc(g.title)}</div>
      <div class="game-card-size">${sizeText}</div>
      <div class="card-progress"><div class="card-progress-fill" style="width:${progressPct}%"></div></div>
    `;
    card.addEventListener('click', () => openModal(g));
    gameGrid.appendChild(card);
  }
  if (filtered.length === 0) {
    gameGrid.innerHTML = '<p style="color:var(--muted);padding:1rem">No games found.</p>';
  }
}

function renderListView(games) {
  gameGrid.style.display = 'none';
  gameList.style.display = '';
  const filtered = filteredSorted(games);

  const sortField = currentSort.split('-')[0];
  const sortDir   = currentSort.split('-')[1];

  function colHeader(label, field) {
    const active = sortField === field;
    const arrow  = active ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '';
    return `<div class="sortable${active ? ' active' : ''}" data-col="${field}">${label}${arrow}</div>`;
  }

  gameList.innerHTML = `
    <div class="list-header">
      <div></div>
      ${colHeader('Title', 'name')}
      ${colHeader('Year', 'year')}
      <div>Category</div>
      ${colHeader('Size', 'size')}
      <div></div>
    </div>
    ${filtered.length === 0 ? '<p style="color:var(--muted);padding:1rem">No games found.</p>' : ''}
  `;

  for (const g of filtered) {
    const id = String(g.id);
    const sz = gameSizes[id];
    const bytes = sz?.bytes;
    const hasUpdate = sz?.hasUpdate;
    const downloaded = queueItems.some(q => (q.game_id === id || q.gameId === id) && q.status === 'completed');
    const statusItem = getGameStatus(g.id);
    const rd = releaseDate(g);
    const year = rd ? rd.slice(0, 4) : '—';

    let sizeText = bytes ? (downloaded ? '✓ ' : '') + fmtBytes(bytes) : '—';
    let sizeClass = 'list-size';
    if (statusItem && statusItem.status !== 'completed') {
      if (statusItem.status === 'downloading') {
        const pct = statusItem.bytes_total ? Math.round(statusItem.bytes_downloaded / statusItem.bytes_total * 100) : 0;
        sizeText = `${pct}%`;
        sizeClass += ' status-downloading';
      } else if (statusItem.status === 'queued') {
        sizeText = 'Queued';
        sizeClass += ' status-queued';
      } else if (statusItem.status === 'failed') {
        sizeText = 'Failed';
        sizeClass += ' status-failed';
      }
    } else if (downloaded) {
      sizeClass += ' downloaded';
    } else if (hasUpdate) {
      sizeText = '↑ Update';
      sizeClass += ' status-update';
    }

    const row = document.createElement('div');
    row.className = 'list-row';
    row.dataset.id = g.id;
    row.innerHTML = `
      <img class="list-thumb" src="https:${g.image}_196.jpg" alt="" loading="lazy" onerror="this.style.background='var(--border)';this.style.display='block'" />
      <div class="list-title" title="${esc(g.title)}">${esc(g.title)}</div>
      <div class="list-year">${year}</div>
      <div class="list-cat">${esc(g.category || '—')}</div>
      <div class="${sizeClass}">${sizeText}</div>
      <div class="list-action"><button class="btn btn-primary" style="font-size:.75rem;padding:.25rem .5rem">+</button></div>
    `;
    row.querySelector('.list-title').addEventListener('click', () => openModal(g));
    row.querySelector('img').addEventListener('click', () => openModal(g));
    row.querySelector('.btn').addEventListener('click', e => { e.stopPropagation(); openModal(g); });
    gameList.appendChild(row);
  }

  // Column sort clicks
  gameList.querySelectorAll('.sortable').forEach(el => {
    el.addEventListener('click', () => {
      const field = el.dataset.col;
      const current = currentSort;
      if (current.startsWith(field)) {
        currentSort = current.endsWith('asc') ? `${field}-desc` : `${field}-asc`;
      } else {
        currentSort = field === 'name' ? 'name-asc' : `${field}-desc`;
      }
      sortSelect.value = currentSort;
      renderGames(allGames);
    });
  });
}

// ── In-place download status updates ───────────────────────────────────────
function updateGameCard(gameId) {
  const card = gameGrid.querySelector(`[data-id="${gameId}"]`);
  if (!card) return;
  const fill = card.querySelector('.card-progress-fill');
  const sizeEl = card.querySelector('.game-card-size');
  if (!fill) return;

  const id = String(gameId);
  const sz = gameSizes[id];
  const bytes = sz?.bytes;
  const hasUpdate = sz?.hasUpdate;
  const downloaded = queueItems.some(q => (q.game_id === id || q.gameId === id) && q.status === 'completed');
  const statusItem = getGameStatus(gameId);

  card.classList.remove('queued', 'downloading', 'failed', 'downloaded', 'has-update');

  if (statusItem && statusItem.status !== 'completed') {
    card.classList.add(statusItem.status);
    if (statusItem.status === 'downloading' && statusItem.bytes_total) {
      fill.style.width = `${Math.round(statusItem.bytes_downloaded / statusItem.bytes_total * 100)}%`;
    } else {
      fill.style.width = '0%';
    }
    if (sizeEl) sizeEl.innerHTML = bytes ? fmtBytes(bytes) : '';
  } else {
    fill.style.width = '0%';
    if (downloaded) {
      card.classList.add('downloaded');
      if (sizeEl) sizeEl.textContent = bytes ? '✓ ' + fmtBytes(bytes) : '✓';
    } else if (hasUpdate) {
      card.classList.add('has-update');
      if (sizeEl) sizeEl.innerHTML = '<span class="update-tag">↑ Update</span>';
    } else {
      if (sizeEl) sizeEl.textContent = bytes ? fmtBytes(bytes) : '';
    }
  }
}

function updateGameRow(gameId) {
  const row = gameList.querySelector(`[data-id="${gameId}"]`);
  if (!row) return;
  const sizeEl = row.querySelector('.list-size');
  if (!sizeEl) return;

  const id = String(gameId);
  const sz = gameSizes[id];
  const bytes = sz?.bytes;
  const hasUpdate = sz?.hasUpdate;
  const downloaded = queueItems.some(q => (q.game_id === id || q.gameId === id) && q.status === 'completed');
  const statusItem = getGameStatus(gameId);

  sizeEl.className = 'list-size';
  if (statusItem && statusItem.status !== 'completed') {
    if (statusItem.status === 'downloading') {
      const pct = statusItem.bytes_total ? Math.round(statusItem.bytes_downloaded / statusItem.bytes_total * 100) : 0;
      sizeEl.textContent = `${pct}%`;
      sizeEl.classList.add('status-downloading');
    } else if (statusItem.status === 'queued') {
      sizeEl.textContent = 'Queued';
      sizeEl.classList.add('status-queued');
    } else if (statusItem.status === 'failed') {
      sizeEl.textContent = 'Failed';
      sizeEl.classList.add('status-failed');
    }
  } else if (downloaded) {
    sizeEl.textContent = bytes ? '✓ ' + fmtBytes(bytes) : '✓';
    sizeEl.classList.add('downloaded');
  } else if (hasUpdate) {
    sizeEl.textContent = '↑ Update';
    sizeEl.classList.add('status-update');
  } else {
    sizeEl.textContent = bytes ? fmtBytes(bytes) : '—';
  }
}

function updateGameElement(gameId) {
  if (currentView === 'grid') updateGameCard(gameId);
  else updateGameRow(gameId);
}


searchInput.addEventListener('input', () => renderGames(allGames));
sortSelect.addEventListener('change', () => { currentSort = sortSelect.value; renderGames(allGames); });
Object.entries(platBtns).forEach(([plat, btn]) => {
  btn.addEventListener('click', async () => {
    libraryPlatform = plat;
    activePlatform  = plat;
    Object.values(platBtns).forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    await Promise.all([loadSizes(), loadStats()]);
  });
});

catFilter.addEventListener('change', () => { currentCategory = catFilter.value; renderGames(allGames); });
dlFilterSelect.addEventListener('change', () => { dlFilter = dlFilterSelect.value; renderGames(allGames); });

viewGridBtn.addEventListener('click', () => {
  currentView = 'grid';
  viewGridBtn.classList.add('active');
  viewListBtn.classList.remove('active');
  sortSelect.style.display = '';
  renderGames(allGames);
});

viewListBtn.addEventListener('click', () => {
  currentView = 'list';
  viewListBtn.classList.add('active');
  viewGridBtn.classList.remove('active');
  sortSelect.style.display = 'none'; // column headers handle sorting
  renderGames(allGames);
});

refreshBtn.addEventListener('click', async () => {
  libraryMeta.textContent = 'Refreshing…';
  gameGrid.innerHTML = '';
  allGames = await api('/api/library?refresh=1');
  renderGames(allGames);
  libraryMeta.textContent = `${allGames.length} games`;
});

logoutBtn.addEventListener('click', async () => {
  await api('/auth/logout', { method: 'POST' });
  location.reload();
});

// ── Game modal ─────────────────────────────────────────────────────────────
async function openModal(game) {
  modalGameId = game.id;
  activePlatform = libraryPlatform;

  const overlay = document.createElement('div');
  overlay.className = 'overlay';
  overlay.id = 'modal-overlay';

  const meta = gameSizes[String(game.id)];
  const rd = releaseDate(game);
  const hasExactDate = !!game.releaseDate?.date;
  const releaseYear = rd ? rd.slice(0, 4) : null;
  const metaLine = [
    releaseYear ? `${hasExactDate ? 'Released' : 'Added to GOG'} ${releaseYear}` : '',
    meta?.bytes ? fmtBytes(meta.bytes) : '',
  ].filter(Boolean).join(' · ');

  overlay.innerHTML = `
    <div class="modal">
      <div class="modal-header">
        <img class="modal-cover" src="https:${game.image}_196.jpg" alt="" onerror="this.style.display='none'" />
        <div class="modal-info">
          <h2>${esc(game.title)}</h2>
          ${metaLine ? `<div style="font-size:.8rem;color:var(--muted);margin-bottom:.4rem">${esc(metaLine)}</div>` : ''}
          <div class="platform-tabs" id="platform-tabs"></div>
        </div>
        <button class="modal-close" id="modal-close">✕</button>
      </div>
      <div class="modal-body" id="modal-body">
        <p style="color:var(--muted)">Loading…</p>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);
  document.getElementById('modal-close').addEventListener('click', closeModal);
  overlay.addEventListener('click', e => { if (e.target === overlay) closeModal(); });

  try {
    const [details, descResp] = await Promise.all([
      api(`/api/games/${game.id}`),
      api(`/api/games/${game.id}/description`),
    ]);
    details._description = descResp.description || '';
    renderModal(details);
  } catch (err) {
    document.getElementById('modal-body').innerHTML =
      `<p style="color:var(--accent2)">Failed to load: ${esc(err.message)}</p>`;
  }
}

function renderModal(details) {
  currentModalDetails = details;
  const { downloads = [], extras = [], dlcs = [], _description = '' } = details;

  // Collect available platforms
  const platforms = new Set();
  for (const [, langs] of downloads) {
    for (const p of Object.keys(langs)) platforms.add(p);
  }

  const tabsEl = document.getElementById('platform-tabs');
  tabsEl.innerHTML = '';
  for (const p of ['windows', 'linux', 'mac']) {
    if (!platforms.has(p)) continue;
    const btn = document.createElement('button');
    btn.className = 'tab' + (p === activePlatform ? ' active' : '');
    btn.textContent = p.charAt(0).toUpperCase() + p.slice(1);
    btn.addEventListener('click', () => {
      activePlatform = p;
      document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.textContent.toLowerCase() === p));
      renderModalBody(downloads, extras, dlcs, _description);
    });
    tabsEl.appendChild(btn);
  }

  // If selected platform not available, pick first
  if (!platforms.has(activePlatform) && platforms.size) {
    activePlatform = [...platforms][0];
  }

  renderModalBody(downloads, extras, dlcs, _description);
}

function renderModalBody(downloads, extras, dlcs, description) {
  const body = document.getElementById('modal-body');
  const parts = [];

  if (description) {
    parts.push(`<div class="game-description">${description}</div>`);
  }

  // Installers for active platform — deduplicate by manualUrl (GOG lists the
  // same file under multiple language entries for multi-language packages)
  const seen = new Set();
  const installers = [];
  for (const [lang, langs] of downloads) {
    const files = langs[activePlatform] || [];
    for (const f of files) {
      if (seen.has(f.manualUrl)) continue;
      seen.add(f.manualUrl);
      installers.push({ ...f, lang });
    }
  }

  if (installers.length) {
    parts.push('<div class="section-title">Installer</div>');
    for (const f of installers) {
      parts.push(dlItem({
        gameId: modalGameId,
        name: f.name || filename(f.manualUrl),
        meta: [f.version, f.size].filter(Boolean).join(' · '),
        manualUrl: f.manualUrl,
        platform: activePlatform,
        type: 'installer',
        md5: f.md5 || null,
      }));
    }
  }

  // DLC
  for (const dlc of dlcs) {
    const dlcSeen = new Set();
    const dlcInstallers = [];
    for (const [, langs] of (dlc.downloads || [])) {
      const files = langs[activePlatform] || [];
      for (const f of files) {
        if (dlcSeen.has(f.manualUrl)) continue;
        dlcSeen.add(f.manualUrl);
        dlcInstallers.push({ ...f });
      }
    }
    if (!dlcInstallers.length) continue;
    parts.push(`<div class="section-title">DLC — ${esc(dlc.title)}</div>`);
    for (const f of dlcInstallers) {
      parts.push(dlItem({
        gameId: modalGameId,
        name: f.name || filename(f.manualUrl),
        meta: [f.version, f.size].filter(Boolean).join(' · '),
        manualUrl: f.manualUrl,
        platform: activePlatform,
        type: 'dlc',
        md5: f.md5 || null,
      }));
    }
  }

  // Extras (platform-agnostic)
  if (extras.length) {
    parts.push('<div class="section-title">Extras</div>');
    for (const e of extras) {
      parts.push(dlItem({
        gameId: modalGameId,
        name: e.name || filename(e.manualUrl),
        meta: e.size || '',
        manualUrl: e.manualUrl,
        platform: null,
        type: 'extra',
      }));
    }
  }

  if (parts.length) {
    const queueAllHtml = `<button id="queue-all-btn" class="btn btn-outline" style="width:100%;margin-bottom:.75rem">Queue All ${activePlatform.charAt(0).toUpperCase()+activePlatform.slice(1)} Installers + DLC</button>`;
    body.innerHTML = queueAllHtml + parts.join('');
  } else {
    body.innerHTML = '<p class="empty-state">Nothing available for this platform.</p>';
  }

  // Wire up queue buttons
  body.querySelectorAll('[data-queue]').forEach(btn => {
    const d = btn.dataset;
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      btn.textContent = '✓';
      btn.classList.add('queued');
      await queueDownload({
        gameId: d.gameId,
        gameTitle: d.gameTitle,
        filename: d.filename,
        manualUrl: d.manualUrl,
        platform: d.platform || null,
        type: d.type,
        md5: d.md5 || null,
      });
    });
  });

  document.getElementById('queue-all-btn')?.addEventListener('click', () =>
    queueAll(downloads, dlcs)
  );
}

async function queueAll(downloads, dlcs) {
  const btn = document.getElementById('queue-all-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Queueing…'; }

  const seen = new Set();
  const toQueue = [];
  const gameTitle = document.querySelector('.modal-info h2')?.textContent || '';

  for (const [, langs] of downloads) {
    for (const f of (langs[activePlatform] || [])) {
      if (seen.has(f.manualUrl) || queueItems.some(q => q.manual_url === f.manualUrl || q.manualUrl === f.manualUrl)) continue;
      seen.add(f.manualUrl);
      toQueue.push({ filename: filename(f.manualUrl), manualUrl: f.manualUrl, type: 'installer', md5: f.md5 || null });
    }
  }
  for (const dlc of dlcs) {
    for (const [, langs] of (dlc.downloads || [])) {
      for (const f of (langs[activePlatform] || [])) {
        if (seen.has(f.manualUrl) || queueItems.some(q => q.manual_url === f.manualUrl || q.manualUrl === f.manualUrl)) continue;
        seen.add(f.manualUrl);
        toQueue.push({ filename: filename(f.manualUrl), manualUrl: f.manualUrl, type: 'dlc', md5: f.md5 || null });
      }
    }
  }

  for (const item of toQueue) {
    await queueDownload({ gameId: modalGameId, gameTitle, platform: activePlatform, ...item });
  }

  if (btn) btn.textContent = toQueue.length ? `Queued ${toQueue.length} files` : 'Already queued';
}

function dlItem({ gameId, name, meta, manualUrl, platform, type, md5 }) {
  const fn = filename(manualUrl);
  const matchUrl  = q => q.manual_url === manualUrl || q.manualUrl === manualUrl;
  const completed = queueItems.find(q => matchUrl(q) && q.status === 'completed');
  const inQueue   = !completed && queueItems.some(matchUrl);

  let action;
  if (completed) {
    action = `<a class="btn btn-success" href="/dl/${completed.id}" download>↓ Download</a>`;
  } else {
    action = `
      <button class="btn ${inQueue ? 'btn-outline queued' : 'btn-primary'}" ${inQueue ? 'disabled' : ''}
        data-queue="1"
        data-game-id="${gameId}"
        data-game-title="${esc(document.querySelector('.modal-info h2')?.textContent || '')}"
        data-filename="${esc(fn)}"
        data-manual-url="${esc(manualUrl)}"
        data-platform="${esc(platform || '')}"
        data-type="${esc(type)}"
        data-md5="${esc(md5 || '')}"
      >${inQueue ? '✓ Queued' : '+ Queue'}</button>`;
  }

  return `
    <div class="dl-item">
      <div class="dl-item-info">
        <div class="dl-item-name" title="${esc(name)}">${esc(name)}</div>
        ${meta ? `<div class="dl-item-meta">${esc(meta)}</div>` : ''}
      </div>
      ${action}
    </div>
  `;
}

function closeModal() {
  document.getElementById('modal-overlay')?.remove();
  modalGameId = null;
}

// ── Queue ──────────────────────────────────────────────────────────────────
queueToggle.addEventListener('click', () => queuePanel.classList.add('open'));
queueClose.addEventListener('click',  () => queuePanel.classList.remove('open'));

async function loadQueue() {
  queueItems = await api('/api/queue');
  renderQueue();
}

async function queueDownload(item) {
  const result = await api('/api/queue', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(item),
  });
  if (!queueItems.find(q => q.id === result.id)) {
    queueItems.unshift({
      ...item,
      id: result.id,
      game_id: item.gameId,
      manual_url: item.manualUrl,
      status: 'queued',
      bytes_downloaded: 0,
      bytes_total: 0,
    });
    renderQueue();
    updateGameElement(item.gameId);
  }
}

function verifiedBadge(status) {
  if (status === 'ok')      return '<span class="verified-ok" title="MD5 verified ✓">✓ Verified</span>';
  if (status === 'exists')  return '<span class="verified-ok" title="File found on disk">✓ Found</span>';
  if (status === 'fail')    return '<span class="verified-fail" title="MD5 mismatch!">⚠ Mismatch</span>';
  if (status === 'missing') return '<span class="verified-missing" title="File not found on disk">✗ Missing</span>';
  if (status === 'error')   return '<span class="verified-fail" title="Verification error">⚠ Error</span>';
  return '';
}

function renderQueue() {
  const active = queueItems.filter(q => q.status !== 'completed');
  queueBadge.textContent = active.length;
  queueBadge.style.display = active.length ? '' : 'none';

  if (queueItems.length === 0) {
    queueList.innerHTML = '<p class="empty-state">No downloads yet.</p>';
    return;
  }

  queueList.innerHTML = queueItems.map(q => {
    const pct = q.bytes_total ? Math.round(q.bytes_downloaded / q.bytes_total * 100) : 0;
    const statusLabel = {
      queued:      'Waiting…',
      downloading: `${pct}% — ${fmtBytes(q.bytes_downloaded)} / ${fmtBytes(q.bytes_total)}`,
      completed:   '',
      failed:      `Failed: ${q.error || 'unknown error'}`,
    }[q.status] ?? q.status;

    const footer = q.status === 'completed' ? `
      <div class="queue-item-footer">
        <div class="queue-item-status status-completed">${verifiedBadge(q.verified)} Completed</div>
        <button class="btn btn-outline verify-btn" data-verify="${q.id}" style="font-size:.65rem;padding:.15rem .4rem">
          ${q.verified ? 'Re-verify' : 'Verify'}
        </button>
      </div>` : `
      <div class="queue-item-status status-${q.status}">${statusLabel}</div>`;

    return `
      <div class="queue-item" id="qi-${q.id}">
        <div class="queue-item-header">
          <div class="queue-item-title" title="${esc(q.game_title)}">${esc(q.game_title)}</div>
          ${q.status !== 'downloading' && q.status !== 'completed'
            ? `<button class="queue-item-delete" data-id="${q.id}" title="Remove">✕</button>` : ''}
        </div>
        <div class="queue-item-file">${esc(q.filename)}</div>
        <div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div>
        ${footer}
      </div>
    `;
  }).join('');

  queueList.querySelectorAll('[data-id]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = parseInt(btn.dataset.id, 10);
      await api(`/api/queue/${id}`, { method: 'DELETE' });
      queueItems = queueItems.filter(q => q.id !== id);
      renderQueue();
    });
  });

  queueList.querySelectorAll('[data-verify]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = parseInt(btn.dataset.verify, 10);
      btn.disabled = true;
      btn.textContent = 'Checking…';
      await api(`/api/verify/${id}`, { method: 'POST' });
    });
  });
}

// ── SSE ────────────────────────────────────────────────────────────────────
let _sseSource = null;
function connectSSE() {
  if (_sseSource) { _sseSource.close(); _sseSource = null; }
  const es = new EventSource('/api/events');
  _sseSource = es;

  es.addEventListener('queued', e => {
    const d = JSON.parse(e.data);
    if (!queueItems.find(q => q.id === d.id)) {
      queueItems.unshift({ ...d, status: 'queued', bytes_downloaded: 0, bytes_total: 0 });
      renderQueue();
      updateGameElement(d.game_id);
    }
  });

  es.addEventListener('downloading', e => {
    const { id } = JSON.parse(e.data);
    const item = queueItems.find(q => q.id === id);
    if (item) {
      item.status = 'downloading';
      renderQueue();
      updateGameElement(item.game_id || item.gameId);
    }
  });

  es.addEventListener('progress', e => {
    const { id, bytesDownloaded, bytesTotal } = JSON.parse(e.data);
    const item = queueItems.find(q => q.id === id);
    if (item) {
      item.bytes_downloaded = bytesDownloaded;
      item.bytes_total      = bytesTotal;
      // Update queue panel inline
      const el = document.getElementById(`qi-${id}`);
      if (el) {
        const pct = bytesTotal ? Math.round(bytesDownloaded / bytesTotal * 100) : 0;
        el.querySelector('.progress-fill').style.width = `${pct}%`;
        el.querySelector('.queue-item-status').textContent =
          `${pct}% — ${fmtBytes(bytesDownloaded)} / ${fmtBytes(bytesTotal)}`;
      }
      // Update card/row inline
      updateGameElement(item.game_id || item.gameId);
    }
  });

  es.addEventListener('completed', e => {
    const { id, game_id, filename: completedFilename } = JSON.parse(e.data);
    const item = queueItems.find(q => q.id === id);
    if (item) {
      item.status = 'completed';
      if (completedFilename) item.filename = completedFilename;
      const gid = game_id || item.game_id || item.gameId;
      if (gid && gameSizes[String(gid)]) gameSizes[String(gid)].hasUpdate = false;
      renderQueue();
      updateGameElement(gid);
      if (dlFilter !== 'all') renderGames(allGames);
      // Refresh modal buttons if this game's details are open
      if (modalGameId && String(modalGameId) === String(gid) && currentModalDetails) {
        renderModalBody(currentModalDetails.downloads || [], currentModalDetails.extras || [], currentModalDetails.dlcs || [], currentModalDetails._description || '');
      }
    }
  });

  es.addEventListener('verified', e => {
    const { id, status } = JSON.parse(e.data);
    const item = queueItems.find(q => q.id === id);
    if (item) {
      item.verified = status;
      const el = document.getElementById(`qi-${id}`);
      if (el) {
        const footer = el.querySelector('.queue-item-footer');
        if (footer) {
          const statusEl = footer.querySelector('.queue-item-status');
          if (statusEl) statusEl.innerHTML = `${verifiedBadge(status)} Completed`;
          const btn = footer.querySelector('.verify-btn');
          if (btn) { btn.disabled = false; btn.textContent = 'Re-verify'; }
        }
      }
    }
  });

  es.addEventListener('failed', e => {
    const { id, error } = JSON.parse(e.data);
    const item = queueItems.find(q => q.id === id);
    if (item) {
      item.status = 'failed';
      item.error = error;
      renderQueue();
      updateGameElement(item.game_id || item.gameId);
    }
  });

  es.addEventListener('removed', e => {
    const { id } = JSON.parse(e.data);
    const item = queueItems.find(q => q.id === id);
    queueItems = queueItems.filter(q => q.id !== id);
    renderQueue();
    if (item) updateGameElement(item.game_id || item.gameId);
  });

  // Scan events
  es.addEventListener('scan:start', e => {
    const { total } = JSON.parse(e.data);
    scanBtn.disabled = true;
    scanBtn.textContent = 'Scanning…';
    scanStatus.textContent = `0/${total} scanned`;
    scanProgressFill.style.width = '0%';
  });

  es.addEventListener('scan:progress', e => {
    const { done, total } = JSON.parse(e.data);
    const pct = Math.round(done / total * 100);
    scanProgressFill.style.width = `${pct}%`;
    scanStatus.textContent = `${done}/${total} scanned`;
    // Refresh sizes every 20 games
    if (done % 20 === 0) loadSizes();
  });

  es.addEventListener('scan:complete', async e => {
    await loadStats();
    await loadSizes();
  });

  // Update-check events
  es.addEventListener('update:start', e => {
    const { total } = JSON.parse(e.data);
    updateBtn.disabled = true;
    updateBtn.textContent = `0/${total}…`;
  });

  es.addEventListener('update:progress', e => {
    const { done, total } = JSON.parse(e.data);
    updateBtn.textContent = `${done}/${total}…`;
  });

  es.addEventListener('update:found', e => {
    const { gameId } = JSON.parse(e.data);
    const id = String(gameId);
    if (gameSizes[id]) gameSizes[id].hasUpdate = true;
    updateGameElement(id);
  });

  es.addEventListener('update:complete', e => {
    const { updates } = JSON.parse(e.data);
    updateBtn.disabled = false;
    updateBtn.textContent = updates > 0 ? `${updates} updated!` : 'Check Updates';
    // Reset button label after a few seconds if updates were found
    if (updates > 0) setTimeout(() => { updateBtn.textContent = 'Check Updates'; }, 5000);
  });

  es.onerror = () => { es.close(); _sseSource = null; setTimeout(connectSSE, 3000); };
}

// ── Helpers ────────────────────────────────────────────────────────────────
async function api(url, opts = {}) {
  const res = await fetch(url, opts);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || res.statusText);
  }
  return res.json();
}

function show(el) {
  for (const e of [loginScreen, libraryScreen]) e.style.display = 'none';
  el.style.display = '';
}

function esc(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function filename(url) {
  return (url || '').split('/').pop().split('?')[0] || url;
}

function fmtBytes(b) {
  if (!b) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(b) / Math.log(k)), sizes.length - 1);
  return `${(b / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}

function updateStickyTops() {
  const hdrH = document.querySelector('header').offsetHeight;
  const statsH = document.getElementById('stats-bar').offsetHeight;
  document.documentElement.style.setProperty('--header-h', `${hdrH}px`);
  document.documentElement.style.setProperty('--list-top', `${hdrH + statsH}px`);
}
updateStickyTops();
window.addEventListener('resize', updateStickyTops);
