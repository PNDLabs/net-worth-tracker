/**
 * dbService.js
 *
 * Initialises the on-device SQLite database via @capacitor-community/sqlite.
 * Returns a singleton Promise<SQLiteDBConnection> so every service module
 * simply does `const db = await getDb()`.
 *
 * Only called on Android (Capacitor native).  On web the REST API is used
 * instead, so this module is never invoked in a browser context.
 */

import { CapacitorSQLite, SQLiteConnection } from '@capacitor-community/sqlite';

const sqlite = new SQLiteConnection(CapacitorSQLite);
let _dbPromise = null;

const SCHEMA = `
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
`;

async function _init() {
  const db = await sqlite.createConnection('networth', false, 'no-encryption', 1, false);
  await db.open();
  await db.execute(SCHEMA, false);
  return db;
}

export function getDb() {
  if (!_dbPromise) {
    _dbPromise = _init();
  }
  return _dbPromise;
}

/** Helper: run a SELECT and return the rows array. */
export async function query(sql, values = []) {
  const db = await getDb();
  const result = await db.query(sql, values);
  return result.values ?? [];
}

/** Helper: run INSERT / UPDATE / DELETE; returns { lastId, changes }. */
export async function run(sql, values = []) {
  const db = await getDb();
  const result = await db.run(sql, values, true);
  return result.changes ?? {};
}

/** Helper: run multiple statements in a single transaction. */
export async function executeSet(statements) {
  const db = await getDb();
  await db.executeSet(statements);
}
