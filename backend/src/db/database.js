const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_DIR = process.env.DB_DIR || path.join(__dirname, '../../data');
const DB_PATH = process.env.DB_PATH || path.join(DB_DIR, 'networth.db');

/**
 * DB_SCHEMA_VERSION – increment this integer every time the SQLite schema
 * changes (new table, new column, new index, etc.).
 * The value is stored in SQLite's built-in PRAGMA user_version so it can be
 * read at runtime without querying application tables.
 *
 * History:
 *   1 – initial schema (accounts, holdings, assets, liabilities, snapshots,
 *       insurance_plans, settings, value_history, sip_installments)
 *   2 – insurance_plans: added terms, covered_conditions
 *   3 – insurance_plans: added insured_name
 *   4 – insurance_plans: added linked_asset_id
 *   5 – precious_metals table (gold/silver/platinum/palladium holdings with
 *       live spot price refresh and purity-aware value calculation)
 *   6 – removed sip_installments table (SIP tracking removed; mutual funds
 *       tracked via brokerage accounts and holdings instead)
 *   7 – insurance_plans: added fund_value (investment component of market-linked
 *       policies such as ULIPs) and linked_account_id (FK to accounts for the
 *       auto-created brokerage account that tracks the fund value in net worth)
 *   8 – accounts/assets/liabilities: added family_member for family net worth
 */
const DB_SCHEMA_VERSION = 8;

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
      family_member TEXT   NOT NULL DEFAULT 'Self',
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
      family_member    TEXT    NOT NULL DEFAULT 'Self',
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
      family_member      TEXT    NOT NULL DEFAULT 'Self',
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

    CREATE TABLE IF NOT EXISTS precious_metals (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      name               TEXT    NOT NULL,
      metal_type         TEXT    NOT NULL DEFAULT 'gold',
      metal_form         TEXT    NOT NULL DEFAULT 'physical',
      purity             TEXT,
      quantity_grams     REAL    NOT NULL DEFAULT 0,
      acquisition_date   TEXT,
      acquisition_cost   REAL,
      current_price_gram REAL,
      current_value      REAL    NOT NULL DEFAULT 0,
      last_price_update  TEXT,
      notes              TEXT,
      created_at         TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at         TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_precious_metals_type
      ON precious_metals(metal_type);
  `);

  // ── Incremental migrations ──────────────────────────────────────────────────
  // SQLite does not support IF NOT EXISTS on ALTER TABLE, so we use a try/catch
  // to add columns that may already exist (idempotent on repeated startups).
  const addColumnIfMissing = (table, column, type) => {
    try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`); } catch (_) {}
  };
  addColumnIfMissing('insurance_plans', 'terms', 'TEXT');
  addColumnIfMissing('insurance_plans', 'covered_conditions', 'TEXT');
  addColumnIfMissing('insurance_plans', 'insured_name', 'TEXT');
  addColumnIfMissing('insurance_plans', 'linked_asset_id', 'INTEGER REFERENCES assets(id) ON DELETE SET NULL');
  // Schema v7: market-linked insurance (ULIP) fund value and linked brokerage account.
  addColumnIfMissing('insurance_plans', 'fund_value', 'REAL');
  addColumnIfMissing('insurance_plans', 'linked_account_id', 'INTEGER REFERENCES accounts(id) ON DELETE SET NULL');
  addColumnIfMissing('accounts', 'family_member', "TEXT NOT NULL DEFAULT 'Self'");
  addColumnIfMissing('assets', 'family_member', "TEXT NOT NULL DEFAULT 'Self'");
  addColumnIfMissing('liabilities', 'family_member', "TEXT NOT NULL DEFAULT 'Self'");

  // Schema v6: remove sip_installments table (SIP tracking removed).
  // DROP IF EXISTS is safe to run on every startup.
  db.exec('DROP INDEX IF EXISTS idx_sip_installments_date');
  db.exec('DROP TABLE IF EXISTS sip_installments');

  // Stamp the schema version so tooling can inspect it without querying tables.
  db.pragma(`user_version = ${DB_SCHEMA_VERSION}`);
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

module.exports = { createDatabase, getDb, resetDb, DB_SCHEMA_VERSION };
