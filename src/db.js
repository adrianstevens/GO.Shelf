import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import { dirname } from 'path';
import config from '../config.js';

let db;

export function getDb() {
  if (!db) {
    mkdirSync(dirname(config.dbPath), { recursive: true });
    db = new Database(config.dbPath);
    db.pragma('journal_mode = WAL');
    db.exec(`
      CREATE TABLE IF NOT EXISTS tokens (
        id    INTEGER PRIMARY KEY CHECK (id = 1),
        access_token  TEXT NOT NULL,
        refresh_token TEXT NOT NULL,
        expires_at    INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS game_details (
        game_id    TEXT PRIMARY KEY,
        title      TEXT,
        data       TEXT NOT NULL,
        fetched_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
      );

      CREATE TABLE IF NOT EXISTS queue (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        game_id          TEXT    NOT NULL,
        game_title       TEXT    NOT NULL,
        filename         TEXT    NOT NULL,
        manual_url       TEXT    NOT NULL UNIQUE,
        platform         TEXT,
        type             TEXT    NOT NULL DEFAULT 'installer',
        status           TEXT    NOT NULL DEFAULT 'queued',
        bytes_downloaded INTEGER NOT NULL DEFAULT 0,
        bytes_total      INTEGER NOT NULL DEFAULT 0,
        error            TEXT,
        created_at       INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
        updated_at       INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
      );
    `);

    // Migrations — only swallow "duplicate column" errors; re-throw anything else
    function migrate(sql) {
      try { db.exec(sql); } catch (err) {
        if (!err.message.includes('duplicate column')) throw err;
      }
    }
    migrate(`ALTER TABLE game_details ADD COLUMN has_update INTEGER NOT NULL DEFAULT 0`);
    migrate(`ALTER TABLE queue ADD COLUMN md5_expected TEXT`);
    migrate(`ALTER TABLE queue ADD COLUMN verified TEXT`);
  }
  return db;
}
