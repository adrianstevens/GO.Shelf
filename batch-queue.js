#!/usr/bin/env node
// Batch-queue English Windows installers under a given total size limit.
// Sums all parts of multi-part installers; skips patches.
// Usage: node batch-queue.js [--max-gb 1] [--dry-run]

const BASE = process.env.GO_SHELF_URL || 'http://localhost:3001';
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const maxIdx = args.indexOf('--max-gb');
const maxGB = maxIdx !== -1 ? parseFloat(args[maxIdx + 1]) : 1;

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

function isPatch(name) {
  return /\bpatch\b/i.test(name || '');
}

function isInstaller(name) {
  // Matches standalone installers or "Part X of Y" multi-part files
  return !isPatch(name);
}

async function main() {
  console.log(`Fetching library from ${BASE} …`);
  console.log(`Max total installer size: ${maxGB} GB${dryRun ? ' (DRY RUN)' : ''}\n`);

  const libRes = await fetch(`${BASE}/api/library`);
  const games = await libRes.json();
  console.log(`${games.length} games in library\n`);

  let queuedGames = 0;
  let queuedFiles = 0;
  let skipped = 0;
  let errors = 0;

  for (const game of games) {
    let details;
    try {
      const res = await fetch(`${BASE}/api/games/${game.id}`);
      details = await res.json();
    } catch (err) {
      console.log(`  ✗ ${game.title} — failed to fetch details: ${err.message}`);
      errors++;
      continue;
    }

    if (!details.downloads?.length) continue;

    for (const [lang, platforms] of details.downloads) {
      if (lang !== 'English') continue;
      const files = (platforms.windows || []).filter(f => isInstaller(f.name));
      if (!files.length) continue;

      // Sum total size across all parts
      const totalGB = files.reduce((sum, f) => sum + parseSize(f.size), 0);

      if (totalGB > maxGB) {
        console.log(`  skip  ${game.title} — ${totalGB.toFixed(1)} GB total (>${maxGB} GB)`);
        skipped++;
        continue;
      }

      // Queue all parts
      console.log(`  ${dryRun ? '[dry]' : '  ✓  '} ${game.title} — ${files.length} file(s), ${totalGB < 1 ? (totalGB * 1024).toFixed(0) + ' MB' : totalGB.toFixed(1) + ' GB'} total`);

      if (!dryRun) {
        for (const f of files) {
          try {
            await fetch(`${BASE}/api/queue`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                gameId: game.id,
                gameTitle: details.title,
                filename: f.manualUrl.split('/').pop(),
                manualUrl: f.manualUrl,
                platform: 'windows',
                type: 'installer',
              }),
            });
          } catch (err) {
            console.log(`    ✗ failed to queue ${f.name}: ${err.message}`);
            errors++;
          }
        }
      }

      queuedGames++;
      queuedFiles += files.length;
    }
  }

  console.log(`\nDone. Games: ${queuedGames}, Files: ${queuedFiles}, Skipped (too large): ${skipped}, Errors: ${errors}`);
}

main().catch(err => { console.error(err); process.exit(1); });
