#!/usr/bin/env node
import { program } from 'commander';
import { getAuthUrl, exchangeCode, isAuthenticated, clearTokens } from '../src/auth.js';
import { getLibrary, getGameDetails } from '../src/gog-api.js';
import { addToQueue, getQueue } from '../src/downloader.js';
import { createServer } from 'http';
import open from 'open';

program
  .name('go-shelf')
  .description('Browse and download GOG games from the command line')
  .version('1.0.0');

// ── auth login ─────────────────────────────────────────────────────────────
program
  .command('login')
  .description('Authenticate with your GOG account')
  .action(async () => {
    if (isAuthenticated()) {
      console.log('Already authenticated.');
      return;
    }

    // Spin up a one-shot local server to catch the OAuth callback
    await new Promise((resolve, reject) => {
      const server = createServer(async (req, res) => {
        const url = new URL(req.url, 'http://localhost:9999');
        if (url.pathname !== '/callback') return;

        const code = url.searchParams.get('code');
        if (!code) {
          res.end('Missing code. Try again.');
          server.close(reject);
          return;
        }
        try {
          await exchangeCode(code);
          res.end('<h2>Authenticated! You can close this tab.</h2>');
          console.log('\n✓ Authenticated successfully.');
          server.close(resolve);
        } catch (err) {
          res.end(`Authentication failed: ${err.message}`);
          server.close(() => reject(err));
        }
      });

      server.on('error', err => reject(new Error(`Cannot start callback server on port 9999: ${err.message}`)));
      server.listen(9999, async () => {
        // Override redirectUri for CLI flow
        const params = new URLSearchParams({
          client_id: '46899977096215655',
          redirect_uri: 'http://localhost:9999/callback',
          response_type: 'code',
          layout: 'client2',
        });
        const authUrl = `https://auth.gog.com/auth?${params}`;
        console.log('Opening GOG login in your browser…');
        console.log('If it does not open automatically, visit:\n' + authUrl);
        await open(authUrl);
      });
    });
  });

// ── auth logout ────────────────────────────────────────────────────────────
program
  .command('logout')
  .description('Remove stored credentials')
  .action(() => {
    clearTokens();
    console.log('Logged out.');
  });

// ── list ───────────────────────────────────────────────────────────────────
program
  .command('list')
  .description('List your GOG library')
  .option('-s, --search <query>', 'Filter by title')
  .action(async ({ search }) => {
    requireAuth();
    console.log('Fetching library…');
    const games = await getLibrary();
    const filtered = search
      ? games.filter(g => g.title.toLowerCase().includes(search.toLowerCase()))
      : games;

    for (const g of filtered) {
      console.log(`  ${g.id.toString().padStart(10)}  ${g.title}`);
    }
    console.log(`\n${filtered.length} game(s)`);
  });

// ── info ───────────────────────────────────────────────────────────────────
program
  .command('info <game-id>')
  .description('Show available downloads for a game')
  .action(async (gameId) => {
    requireAuth();
    const details = await getGameDetails(gameId);
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
      for (const dlc of details.dlcs) {
        console.log(`  ${dlc.title}`);
      }
    }

    if (details.extras?.length) {
      console.log('\nExtras:');
      for (const e of details.extras) {
        console.log(`  ${e.name}  (${e.size || '?'})`);
      }
    }
  });

// ── download ───────────────────────────────────────────────────────────────
program
  .command('download <game-id>')
  .description('Queue downloads for a game')
  .option('-p, --platform <platform>', 'Platform: windows|linux|mac', 'windows')
  .option('--dlc',    'Include DLC installers')
  .option('--extras', 'Include extras (soundtracks, artbooks, etc.)')
  .action(async (gameId, { platform, dlc, extras }) => {
    requireAuth();
    console.log(`Fetching details for game ${gameId}…`);
    const details = await getGameDetails(gameId);

    const queued = [];

    function enqueue(files, type) {
      for (const f of files) {
        const fn = f.manualUrl.split('/').pop();
        addToQueue({
          gameId,
          gameTitle: details.title,
          filename: fn,
          manualUrl: f.manualUrl,
          platform,
          type,
        });
        queued.push(fn);
      }
    }

    // Main installers
    for (const [, langs] of (details.downloads || [])) {
      enqueue(langs[platform] || [], 'installer');
    }

    // DLC
    if (dlc) {
      for (const d of (details.dlcs || [])) {
        for (const [, langs] of (d.downloads || [])) {
          enqueue(langs[platform] || [], 'dlc');
        }
      }
    }

    // Extras
    if (extras) {
      enqueue(details.extras || [], 'extra');
    }

    if (queued.length === 0) {
      console.log(`No ${platform} files found.`);
    } else {
      console.log(`Queued ${queued.length} file(s):`);
      for (const f of queued) console.log(`  ${f}`);
      console.log('\nStart the server (npm start) to process the queue.');
    }
  });

// ── queue ──────────────────────────────────────────────────────────────────
program
  .command('queue')
  .description('Show the download queue')
  .action(() => {
    const items = getQueue();
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

// ── helpers ────────────────────────────────────────────────────────────────
function requireAuth() {
  if (!isAuthenticated()) {
    console.error('Not authenticated. Run: go-shelf login');
    process.exit(1);
  }
}

program.parseAsync();
