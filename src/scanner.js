import { getDb } from './db.js';
import { getLibrary, getGameDetails } from './gog-api.js';
import { broadcast } from './sse.js';

const DELAY_MS = 250; // between API calls — polite rate limit

let scanRunning = false;

// Parse GOG's human-readable size strings ("2 GB", "500 MB") to bytes.
export function parseSize(str) {
  if (!str) return 0;
  const m = String(str).match(/([\d.,]+)\s*(B|KB|MB|GB|TB)?/i);
  if (!m) return 0;
  const n = parseFloat(m[1].replace(',', ''));
  const mult = { B: 1, KB: 1024, MB: 1048576, GB: 1073741824, TB: 1099511627776 };
  return Math.round(n * (mult[(m[2] || 'B').toUpperCase()] || 1));
}

// Pick one language entry from a downloads array — English preferred.
function pickLanguage(downloads, platform) {
  if (!downloads?.length) return [];
  const english = downloads.find(([lang]) => /english/i.test(lang));
  const [, langs] = english ?? downloads[0];
  return langs?.[platform] ?? [];
}

// Sum installer bytes for a given platform from a details object.
// Only counts one language to avoid multiplying multi-language duplicates.
export function installerBytes(details, platform = 'windows') {
  let total = 0;
  for (const f of pickLanguage(details.downloads, platform)) total += parseSize(f.size);
  for (const dlc of (details.dlcs || [])) {
    for (const f of pickLanguage(dlc.downloads, platform)) total += parseSize(f.size);
  }
  return total;
}

export function isScanRunning() { return scanRunning; }

// Build a version fingerprint from all installer version strings in a details object.
function versionSig(details) {
  const versions = [];
  for (const [, langs] of (details.downloads || [])) {
    for (const files of Object.values(langs)) {
      for (const f of (files || [])) {
        if (f.version) versions.push(`${f.name}:${f.version}`);
      }
    }
  }
  for (const dlc of (details.dlcs || [])) {
    for (const [, langs] of (dlc.downloads || [])) {
      for (const files of Object.values(langs)) {
        for (const f of (files || [])) {
          if (f.version) versions.push(`dlc:${f.name}:${f.version}`);
        }
      }
    }
  }
  return versions.sort().join('|');
}

let updateRunning = false;
export function isUpdateRunning() { return updateRunning; }

export async function checkForUpdates() {
  if (updateRunning) return;
  updateRunning = true;

  try {
    const db = getDb();
    const rows = db.prepare('SELECT game_id, data FROM game_details').all();
    const total = rows.length;
    let done = 0, updates = 0;

    broadcast('update:start', { total });

    for (const row of rows) {
      try {
        const cached = JSON.parse(row.data);
        const fresh = await fetchWithRetry(() => getGameDetails(row.game_id));

        if (versionSig(cached) !== versionSig(fresh)) {
          db.prepare(`
            UPDATE game_details SET data = ?, has_update = 1, fetched_at = strftime('%s','now')
            WHERE game_id = ?
          `).run(JSON.stringify(fresh), row.game_id);
          updates++;
          broadcast('update:found', { gameId: row.game_id });
        }
      } catch (err) {
        broadcast('update:error', { gameId: row.game_id, error: err.message });
      }

      done++;
      broadcast('update:progress', { done, total });
      await sleep(DELAY_MS);
    }

    broadcast('update:complete', { done, total, updates });
  } finally {
    updateRunning = false;
  }
}

export async function startScan({ force = false } = {}) {
  if (scanRunning) return;
  scanRunning = true;

  try {
    const games = await getLibrary();
    const db = getDb();
    const total = games.length;
    let done = 0;
    let errors = 0;

    broadcast('scan:start', { total });

    for (const game of games) {
      const existing = db.prepare('SELECT game_id FROM game_details WHERE game_id = ?').get(String(game.id));
      if (existing && !force) {
        done++;
        broadcast('scan:progress', { done, total, gameId: game.id, gameTitle: game.title });
        continue;
      }

      try {
        const details = await fetchWithRetry(() => getGameDetails(game.id));
        db.prepare(`
          INSERT INTO game_details (game_id, title, data)
          VALUES (?, ?, ?)
          ON CONFLICT(game_id) DO UPDATE SET
            title      = excluded.title,
            data       = excluded.data,
            fetched_at = strftime('%s', 'now')
        `).run(String(game.id), game.title, JSON.stringify(details));
      } catch (err) {
        errors++;
        broadcast('scan:error', { gameId: game.id, error: err.message });
      }

      done++;
      broadcast('scan:progress', { done, total, gameId: game.id, gameTitle: game.title });
      await sleep(DELAY_MS);
    }

    broadcast('scan:complete', { done, total, errors });
  } finally {
    scanRunning = false;
  }
}

export function getScanStats(platform = 'windows') {
  const db = getDb();

  const scanned = db.prepare('SELECT COUNT(*) as n FROM game_details').get().n;
  const totalGames = scanned; // we use the cached count; library total comes from the client

  // Sum installer sizes across all scanned games
  let totalBytes = 0;
  for (const row of db.prepare('SELECT data FROM game_details').all()) {
    try { totalBytes += installerBytes(JSON.parse(row.data), platform); } catch {}
  }

  // Downloaded: sum bytes_total of completed queue items
  const dl = db.prepare(`
    SELECT COALESCE(SUM(bytes_total), 0) as bytes, COUNT(*) as count
    FROM queue WHERE status = 'completed'
  `).get();

  return {
    scannedGames: scanned,
    totalBytes,
    downloadedBytes: dl.bytes,
    downloadedCount: dl.count,
  };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchWithRetry(fn, retries = 3) {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (err.response?.status === 429 && attempt < retries - 1) {
        await sleep(2000 * (attempt + 1)); // 2s, 4s, 6s back-off
        continue;
      }
      throw err;
    }
  }
}
