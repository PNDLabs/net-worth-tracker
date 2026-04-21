const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_DIR = process.env.DB_DIR || path.join(__dirname, '../../data');
const DB_PATH = process.env.DB_PATH || path.join(DB_DIR, 'networth.db');

function createDatabase(dbPath) {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

function runMigrations(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      name         TEXT    NOT NULL,
      institution  TEXT,
      type         TEXT    NOT NULL DEFAULT 'checking',
      currency     TEXT    NOT NULL DEFAULT 'USD',
      balance      REAL    NOT NULL DEFAULT 0,
      notes        TEXT,
      created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at   TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS holdings (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id    INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      symbol        TEXT    NOT NULL,
      name          TEXT,
      shares        REAL    NOT NULL DEFAULT 0,
      cost_basis    REAL,
      current_price REAL,
      current_value REAL,
      as_of_date    TEXT,
      created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at    TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS assets (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      name             TEXT    NOT NULL,
      category         TEXT    NOT NULL DEFAULT 'other',
      acquisition_date TEXT,
      acquisition_cost REAL,
      current_value    REAL    NOT NULL DEFAULT 0,
      notes            TEXT,
      created_at       TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at       TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS liabilities (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      name               TEXT    NOT NULL,
      lender             TEXT,
      type               TEXT    NOT NULL DEFAULT 'other',
      original_principal REAL,
      current_balance    REAL    NOT NULL DEFAULT 0,
      interest_rate      REAL,
      minimum_payment    REAL,
      notes              TEXT,
      created_at         TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at         TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS snapshots (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      snapshot_date     TEXT    NOT NULL DEFAULT (date('now')),
      total_assets      REAL    NOT NULL DEFAULT 0,
      total_liabilities REAL    NOT NULL DEFAULT 0,
      net_worth         REAL    NOT NULL DEFAULT 0,
      notes             TEXT,
      created_at        TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS insurance_plans (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      name               TEXT    NOT NULL,
      provider           TEXT,
      type               TEXT    NOT NULL DEFAULT 'other',
      policy_number      TEXT,
      premium_amount     REAL,
      premium_frequency  TEXT    NOT NULL DEFAULT 'monthly',
      coverage_amount    REAL,
      start_date         TEXT,
      end_date           TEXT,
      renewal_date       TEXT,
      notes              TEXT,
      created_at         TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at         TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS settings (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS value_history (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_type TEXT    NOT NULL,
      entity_id   INTEGER NOT NULL,
      value       REAL    NOT NULL,
      recorded_at TEXT    NOT NULL DEFAULT (date('now')),
      notes       TEXT,
      created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_value_history_entity
      ON value_history(entity_type, entity_id, recorded_at);

    CREATE TABLE IF NOT EXISTS sip_installments (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      name             TEXT    NOT NULL,
      symbol           TEXT,
      account_id       INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
      amount           REAL    NOT NULL,
      units            REAL,
      nav              REAL,
      installment_date TEXT    NOT NULL DEFAULT (date('now')),
      notes            TEXT,
      created_at       TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_sip_installments_date
      ON sip_installments(installment_date);
  `);
}

let _db;

function getDb() {
  if (!_db) {
    _db = createDatabase(DB_PATH);
  }
  return _db;
}

function resetDb() {
  _db = null;
}

module.exports = { createDatabase, getDb, resetDb };
