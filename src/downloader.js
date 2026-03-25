import axios from 'axios';
import { createWriteStream, createReadStream, mkdirSync, existsSync, unlinkSync } from 'fs';
import { createHash } from 'crypto';
import { join } from 'path';
import { getDb } from './db.js';
import { getAccessToken } from './auth.js';
import { broadcast } from './sse.js';
import config from '../config.js';

// Turn a game title into a safe directory name
function sanitizeTitle(title) {
  return title
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')   // strip illegal fs chars
    .replace(/\s+/g, ' ')                       // collapse whitespace
    .trim()
    .slice(0, 200)                               // sane length limit
    || 'unknown';
}

export function gameDir(gameTitle) {
  return join(config.downloadDir, sanitizeTitle(gameTitle));
}

function computeMd5(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('md5');
    createReadStream(filePath)
      .on('data', d => hash.update(d))
      .on('end', () => resolve(hash.digest('hex')))
      .on('error', reject);
  });
}

export async function verifyDownload(id, filePath, expectedMd5) {
  const db = getDb();
  try {
    if (!existsSync(filePath)) {
      db.prepare("UPDATE queue SET verified = 'missing' WHERE id = ?").run(id);
      broadcast('verified', { id, status: 'missing' });
      return;
    }
    if (!expectedMd5) {
      // No checksum to compare — just confirm the file exists without reading it
      db.prepare("UPDATE queue SET verified = 'exists' WHERE id = ?").run(id);
      broadcast('verified', { id, status: 'exists' });
      return;
    }
    const computed = await computeMd5(filePath);
    const status = computed === expectedMd5.toLowerCase() ? 'ok' : 'fail';
    db.prepare('UPDATE queue SET verified = ? WHERE id = ?').run(status, id);
    broadcast('verified', { id, status, md5: computed });
  } catch (err) {
    db.prepare("UPDATE queue SET verified = 'error' WHERE id = ?").run(id);
    broadcast('verified', { id, status: 'error', error: err.message });
  }
}

// Queue management --------------------------------------------------------

export function getQueue() {
  return getDb().prepare('SELECT * FROM queue ORDER BY created_at DESC').all();
}

export function addToQueue({ gameId, gameTitle, filename, manualUrl, platform, type = 'installer', md5 = null }) {
  if (!manualUrl || !manualUrl.startsWith('/')) {
    throw new Error(`Invalid manualUrl: ${JSON.stringify(manualUrl)}`);
  }
  const db = getDb();

  const existing = db.prepare("SELECT id, status FROM queue WHERE manual_url = ?").get(manualUrl);

  if (existing) {
    if (existing.status === 'completed') {
      // Allow re-downloading (e.g. after a game update) — remove the old entry
      db.prepare("DELETE FROM queue WHERE id = ?").run(existing.id);
    } else if (existing.status === 'failed') {
      // Re-queue failed items
      db.prepare("UPDATE queue SET status = 'queued', error = NULL, bytes_downloaded = 0, updated_at = strftime('%s','now') WHERE id = ?")
        .run(existing.id);
      scheduleQueue();
      return existing.id;
    } else {
      // queued or downloading — skip
      return existing.id;
    }
  }

  const { lastInsertRowid } = db.prepare(`
    INSERT INTO queue (game_id, game_title, filename, manual_url, platform, type, md5_expected)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(gameId, gameTitle, filename, manualUrl, platform, type, md5);

  // Include both snake_case and camelCase so SSE consumers can use either
  broadcast('queued', { id: lastInsertRowid, game_id: gameId, gameId, game_title: gameTitle, gameTitle, filename, manual_url: manualUrl, platform, type });
  scheduleQueue();
  return lastInsertRowid;
}

export function removeFromQueue(id) {
  const { changes } = getDb().prepare("DELETE FROM queue WHERE id = ? AND status NOT IN ('downloading')").run(id);
  if (changes > 0) broadcast('removed', { id });
}

// Download engine ---------------------------------------------------------

let isProcessing = false;

function scheduleQueue() {
  if (!isProcessing) processQueue();
}

async function processQueue() {
  if (isProcessing) return;
  isProcessing = true;
  try {
    let item;
    while ((item = getDb().prepare("SELECT * FROM queue WHERE status = 'queued' ORDER BY created_at ASC LIMIT 1").get())) {
      await downloadItem(item);
    }
  } finally {
    isProcessing = false;
  }
}

async function downloadItem(item) {
  const db = getDb();
  const update = db.prepare("UPDATE queue SET status = ?, updated_at = strftime('%s','now') WHERE id = ?");

  update.run('downloading', item.id);
  broadcast('downloading', { id: item.id });

  let destPath; // declared outside try so the catch block can clean it up
  try {
    const token = await getAccessToken();

    // First resolve the redirect to get the real filename from the CDN URL
    const redirectResp = await axios.get(`https://www.gog.com${item.manual_url}`, {
      headers: { Authorization: `Bearer ${token}` },
      maxRedirects: 0,
      validateStatus: s => s >= 200 && s < 400,
    });
    const cdnUrl = redirectResp.headers.location || `https://www.gog.com${item.manual_url}`;
    const urlFilename = decodeURIComponent(cdnUrl.split('/').pop().split('?')[0]);

    const response = await axios.get(cdnUrl, {
      responseType: 'stream',
      maxRedirects: 10,
    });

    const filename = urlFilename || item.filename;
    const totalBytes = parseInt(response.headers['content-length'] || '0', 10);

    db.prepare("UPDATE queue SET bytes_total = ?, filename = ? WHERE id = ?").run(totalBytes, filename, item.id);

    const gameFolder = gameDir(item.game_title);
    mkdirSync(gameFolder, { recursive: true });
    destPath     = join(gameFolder, filename);
    const writer = createWriteStream(destPath);

    let downloaded = 0;
    let lastBroadcast = 0;

    response.data.on('data', chunk => {
      downloaded += chunk.length;
      const now = Date.now();
      if (now - lastBroadcast > 500) {
        db.prepare("UPDATE queue SET bytes_downloaded = ? WHERE id = ?").run(downloaded, item.id);
        broadcast('progress', {
          id: item.id,
          bytesDownloaded: downloaded,
          bytesTotal: totalBytes,
          percent: totalBytes ? Math.round(downloaded / totalBytes * 100) : 0,
        });
        lastBroadcast = now;
      }
    });

    await new Promise((resolve, reject) => {
      writer.on('finish', resolve);
      writer.on('error', reject);
      response.data.on('error', reject);
      response.data.pipe(writer);
    });

    db.prepare(`
      UPDATE queue SET status = 'completed', bytes_downloaded = bytes_total, updated_at = strftime('%s','now')
      WHERE id = ?
    `).run(item.id);
    // Clear the has_update flag now that the user has the latest installer
    db.prepare("UPDATE game_details SET has_update = 0 WHERE game_id = ?").run(item.game_id);
    broadcast('completed', { id: item.id, game_id: item.game_id, filename });
    // Verify file integrity in background — don't block next queue item
    verifyDownload(item.id, destPath, item.md5_expected).catch(console.error);

  } catch (err) {
    // Remove any partial file so a retry starts fresh
    try { if (destPath) unlinkSync(destPath); } catch {}
    db.prepare(`
      UPDATE queue SET status = 'failed', error = ?, updated_at = strftime('%s','now')
      WHERE id = ?
    `).run(err.message, item.id);
    broadcast('failed', { id: item.id, error: err.message });
  }
}

export function resumeQueue() {
  // Mark any downloads interrupted by a server restart as queued again
  getDb().prepare("UPDATE queue SET status = 'queued' WHERE status = 'downloading'").run();
  processQueue();
}
