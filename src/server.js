import express from 'express';
import axios from 'axios';
import { fileURLToPath } from 'url';
import { dirname, join, basename } from 'path';
import { existsSync } from 'fs';
import { getAuthUrl, exchangeCode, isAuthenticated, clearTokens } from './auth.js';
import { getLibrary, getGameDetails } from './gog-api.js';
import { getQueue, addToQueue, removeFromQueue, resumeQueue, verifyDownload, gameDir } from './downloader.js';
import { addClient } from './sse.js';
import { startScan, getScanStats, isScanRunning, installerBytes, checkForUpdates, isUpdateRunning } from './scanner.js';
import { getDb } from './db.js';
import config from '../config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();

// Optional HTTP basic auth — enabled when BASIC_AUTH=user:password is set
if (config.basicAuth) {
  const [user, ...rest] = config.basicAuth.split(':');
  const pass     = rest.join(':');
  const expected = Buffer.from(`${user}:${pass}`).toString('base64');
  app.use((req, res, next) => {
    if (req.headers.authorization === `Basic ${expected}`) return next();
    res.setHeader('WWW-Authenticate', 'Basic realm="gog-shelf"');
    res.status(401).send('Unauthorized');
  });
}

app.use(express.json());
app.use(express.static(join(__dirname, '..', 'public')));

// Auth --------------------------------------------------------------------

app.get('/auth/login', (_req, res) => res.redirect(getAuthUrl()));

// Called by the frontend after the user pastes the GOG redirect URL
app.post('/api/auth/exchange', async (req, res) => {
  try {
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: 'code is required' });
    await exchangeCode(code);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/auth/logout', (_req, res) => {
  clearTokens();
  res.json({ ok: true });
});

app.get('/api/auth/status', (_req, res) => {
  res.json({ authenticated: isAuthenticated() });
});

// Library -----------------------------------------------------------------

app.get('/api/library', async (req, res) => {
  try {
    const games = await getLibrary({ bust: req.query.refresh === '1' });
    res.json(games);
  } catch (err) {
    const status = err.message === 'Not authenticated' ? 401 : 500;
    res.status(status).json({ error: err.message });
  }
});

// Game details ------------------------------------------------------------

app.get('/api/games/:id', async (req, res) => {
  try {
    const details = await getGameDetails(req.params.id);
    res.json(details);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Game description (public GOG API) ----------------------------------------

app.get('/api/games/:id/description', async (req, res) => {
  try {
    const { data } = await axios.get(`https://api.gog.com/products/${req.params.id}`, {
      params: { expand: 'description' },
    });
    res.json({ description: data.description?.full || '' });
  } catch (err) {
    res.json({ description: '' });
  }
});

// Queue -------------------------------------------------------------------

app.get('/api/queue', (_req, res) => res.json(getQueue()));

app.post('/api/queue', (req, res) => {
  const { gameId, gameTitle, filename, manualUrl, platform, type, md5 } = req.body;
  if (!gameId || !manualUrl || !filename) {
    return res.status(400).json({ error: 'gameId, manualUrl, and filename are required' });
  }
  const id = addToQueue({ gameId, gameTitle, filename, manualUrl, platform, type, md5: md5 || null });
  res.json({ id });
});

app.post('/api/verify/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const item = getDb().prepare('SELECT * FROM queue WHERE id = ?').get(id);
  if (!item || item.status !== 'completed') {
    return res.status(400).json({ error: 'Item not found or not completed' });
  }
  const filePath = join(gameDir(item.game_title), item.filename);
  res.json({ ok: true });
  verifyDownload(id, filePath, item.md5_expected).catch(console.error);
});

app.delete('/api/queue/:id', (req, res) => {
  removeFromQueue(parseInt(req.params.id, 10));
  res.json({ ok: true });
});

// Scan --------------------------------------------------------------------

app.post('/api/scan', (req, res) => {
  if (isScanRunning()) return res.json({ ok: true, running: true });
  startScan({ force: req.body?.force === true }).catch(console.error);
  res.json({ ok: true, running: false });
});

app.post('/api/updates', (req, res) => {
  if (isUpdateRunning()) return res.json({ ok: true, running: true });
  checkForUpdates().catch(console.error);
  res.json({ ok: true, running: false });
});

app.get('/api/stats', (req, res) => {
  const platform = req.query.platform || 'windows';
  res.json({ ...getScanStats(platform), scanRunning: isScanRunning() });
});

// Cached game details — returns all scanned games with full download info --

app.get('/api/cache/details', (_req, res) => {
  const rows = getDb().prepare('SELECT game_id, title, data FROM game_details').all();
  const result = rows.map(row => {
    try { return { gameId: row.game_id, title: row.title, ...JSON.parse(row.data) }; }
    catch { return null; }
  }).filter(Boolean);
  res.json(result);
});

// Game metadata — map of gameId -> { bytes, releaseTimestamp } -----------

app.get('/api/sizes', (req, res) => {
  const platform = req.query.platform || 'windows';
  const rows = getDb().prepare('SELECT game_id, data, has_update FROM game_details').all();
  const result = {};
  for (const row of rows) {
    try {
      const details = JSON.parse(row.data);
      result[row.game_id] = {
        bytes: installerBytes(details, platform),
        releaseTimestamp: details.releaseTimestamp ?? 0,
        hasUpdate: row.has_update === 1,
      };
    } catch {}
  }
  res.json(result);
});

// File downloads — serve completed installers to the browser -------------

app.get('/dl/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const item = getDb()
    .prepare("SELECT filename, game_title FROM queue WHERE id = ? AND status = 'completed'")
    .get(id);
  if (!item) return res.status(404).json({ error: 'File not found' });
  const filePath = join(gameDir(item.game_title), item.filename);
  if (!existsSync(filePath)) return res.status(404).json({ error: 'File not found on disk' });
  res.download(filePath);
});

// SSE — live progress for downloads and scans ----------------------------

app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  res.write('event: connected\ndata: {}\n\n');
  addClient(res);
});

// -------------------------------------------------------------------------

app.listen(config.port, () => {
  console.log(`go-shelf running at ${config.host}`);
  resumeQueue();
});
