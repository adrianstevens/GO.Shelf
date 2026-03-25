#!/usr/bin/env node
import { program } from 'commander';

const BASE = process.env.GO_SHELF_URL || 'http://localhost:3001';

async function api(path, opts = {}) {
  const res = await fetch(`${BASE}${path}`, opts);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json();
}

function parseSize(str) {
  if (!str) return 0;
  const m = str.match(/([\d.]+)\s*(MB|GB|KB)/i);
  if (!m) return 0;
  const val = parseFloat(m[1]);
  const unit = m[2].toUpperCase();
  if (unit === 'KB') return val / 1024 / 1024;
  if (unit === 'MB') return val / 1024;
  return val; // GB
}

function formatSize(gb) {
  return gb < 1 ? `${(gb * 1024).toFixed(0)} MB` : `${gb.toFixed(1)} GB`;
}

function isPatch(name) {
  return /\bpatch\b/i.test(name || '');
}

program
  .name('go-shelf')
  .description('Browse and download GOG games from the command line')
  .version('1.0.0')
  .option('--url <url>', 'GO Shelf server URL', BASE);

// ── status ────────────────────────────────────────────────────────────────
program
  .command('status')
  .description('Show server and auth status')
  .action(async () => {
    try {
      const auth = await api('/api/auth/status');
      const stats = await api('/api/stats');
      console.log(`Server:        ${BASE}`);
      console.log(`Authenticated: ${auth.authenticated ? 'yes' : 'no'}`);
      console.log(`Scanned games: ${stats.scannedGames}`);
      console.log(`Scan running:  ${stats.scanRunning}`);
      console.log(`Downloaded:    ${stats.downloadedCount} files`);
    } catch (err) {
      console.error(`Cannot reach server at ${BASE}: ${err.message}`);
      process.exit(1);
    }
  });

// ── scan ──────────────────────────────────────────────────────────────────
program
  .command('scan')
  .description('Scan library and cache game details from GOG')
  .option('--force', 'Re-fetch already cached games')
  .action(async ({ force }) => {
    console.log('Starting scan…');
    await api('/api/scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ force: !!force }),
    });
    // Poll progress
    let last = 0;
    while (true) {
      await new Promise(r => setTimeout(r, 2000));
      const stats = await api('/api/stats');
      if (stats.scannedGames !== last) {
        last = stats.scannedGames;
        process.stdout.write(`\r  Scanned: ${stats.scannedGames} games…`);
      }
      if (!stats.scanRunning) break;
    }
    const stats = await api('/api/stats');
    console.log(`\nDone. ${stats.scannedGames} games cached.`);
  });

// ── list ──────────────────────────────────────────────────────────────────
program
  .command('list')
  .description('List your GOG library')
  .option('-s, --search <query>', 'Filter by title')
  .action(async ({ search }) => {
    const games = await api('/api/library');
    const filtered = search
      ? games.filter(g => g.title.toLowerCase().includes(search.toLowerCase()))
      : games;

    for (const g of filtered) {
      console.log(`  ${g.id.toString().padStart(10)}  ${g.title}`);
    }
    console.log(`\n${filtered.length} game(s)`);
  });

// ── info ──────────────────────────────────────────────────────────────────
program
  .command('info <game-id>')
  .description('Show available downloads for a game')
  .action(async (gameId) => {
    const details = await api(`/api/games/${gameId}`);
    console.log(`\n${details.title}\n${'─'.repeat(details.title.length)}`);

    for (const [lang, langs] of (details.downloads || [])) {
      for (const [platform, files] of Object.entries(langs)) {
        for (const f of files) {
          console.log(`  [${platform.padEnd(7)}] [${lang}]  ${f.name || f.manualUrl}  (${f.size || '?'})`);
        }
      }
    }

    if (details.dlcs?.length) {
      console.log('\nDLC:');
      for (const dlc of details.dlcs) console.log(`  ${dlc.title}`);
    }

    if (details.extras?.length) {
      console.log('\nExtras:');
      for (const e of details.extras) console.log(`  ${e.name}  (${e.size || '?'})`);
    }
  });

// ── download ──────────────────────────────────────────────────────────────
program
  .command('download <game-id>')
  .description('Queue downloads for a game')
  .option('-p, --platform <platform>', 'Platform: windows|linux|mac', 'windows')
  .option('--dlc', 'Include DLC installers')
  .option('--extras', 'Include extras (soundtracks, artbooks, etc.)')
  .action(async (gameId, { platform, dlc, extras }) => {
    const details = await api(`/api/games/${gameId}`);
    const queued = [];

    async function enqueue(files, type) {
      for (const f of files) {
        const res = await api('/api/queue', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            gameId, gameTitle: details.title,
            filename: f.manualUrl.split('/').pop(),
            manualUrl: f.manualUrl, platform, type,
          }),
        });
        queued.push({ name: f.name || f.manualUrl, id: res.id });
      }
    }

    for (const [, langs] of (details.downloads || [])) {
      await enqueue(langs[platform] || [], 'installer');
    }
    if (dlc) {
      for (const d of (details.dlcs || [])) {
        for (const [, langs] of (d.downloads || [])) await enqueue(langs[platform] || [], 'dlc');
      }
    }
    if (extras) await enqueue(details.extras || [], 'extra');

    if (queued.length === 0) {
      console.log(`No ${platform} files found.`);
    } else {
      console.log(`Queued ${queued.length} file(s):`);
      for (const q of queued) console.log(`  ${q.name}`);
    }
  });

// ── batch ─────────────────────────────────────────────────────────────────
program
  .command('batch')
  .description('Queue all English installers under a size limit (uses cached data)')
  .option('--max-gb <gb>', 'Maximum total installer size in GB', '1')
  .option('-p, --platform <platform>', 'Platform: windows|linux|mac', 'windows')
  .option('--dry-run', 'Show what would be queued without queuing')
  .action(async ({ maxGb, platform, dryRun }) => {
    const maxGB = parseFloat(maxGb);
    console.log(`Fetching cached game details from server…`);

    const games = await api('/api/cache/details');
    if (games.length === 0) {
      console.error('No cached data. Run: go-shelf scan');
      process.exit(1);
    }

    console.log(`${games.length} games cached. Max size: ${maxGB} GB, platform: ${platform}${dryRun ? ' (DRY RUN)' : ''}\n`);

    let queuedGames = 0, queuedFiles = 0, skipped = 0, errors = 0;

    for (const game of games) {
      if (!game.downloads?.length) continue;

      for (const [lang, platforms] of game.downloads) {
        if (lang !== 'English') continue;
        const files = (platforms[platform] || []).filter(f => !isPatch(f.name));
        if (!files.length) continue;

        const totalGB = files.reduce((sum, f) => sum + parseSize(f.size), 0);

        if (totalGB > maxGB) {
          console.log(`  skip  ${game.title} — ${formatSize(totalGB)} (>${maxGB} GB)`);
          skipped++;
          continue;
        }

        console.log(`  ${dryRun ? '[dry]' : '  ✓  '} ${game.title} — ${files.length} file(s), ${formatSize(totalGB)}`);

        if (!dryRun) {
          for (const f of files) {
            try {
              await api('/api/queue', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  gameId: game.gameId, gameTitle: game.title,
                  filename: f.manualUrl.split('/').pop(),
                  manualUrl: f.manualUrl, platform, type: 'installer',
                }),
              });
            } catch (err) {
              console.log(`    ✗ ${f.name}: ${err.message}`);
              errors++;
            }
          }
        }

        queuedGames++;
        queuedFiles += files.length;
      }
    }

    console.log(`\nDone. Games: ${queuedGames}, Files: ${queuedFiles}, Skipped: ${skipped}, Errors: ${errors}`);
  });

// ── queue ─────────────────────────────────────────────────────────────────
program
  .command('queue')
  .description('Show the download queue')
  .action(async () => {
    const items = await api('/api/queue');
    if (items.length === 0) {
      console.log('Queue is empty.');
      return;
    }
    for (const q of items) {
      const pct = q.bytes_total ? Math.round(q.bytes_downloaded / q.bytes_total * 100) : 0;
      const progress = q.status === 'downloading' ? ` ${pct}%` : '';
      console.log(`  [${q.status.padEnd(11)}]${progress.padStart(5)}  ${q.game_title} — ${q.filename}`);
    }
  });

program.parseAsync();
