const request = require('supertest');
const { createApp } = require('../src/app');
const dbModule = require('../src/db/database');

let testDb;
let app;
const realFetch = global.fetch;

beforeEach(() => {
  testDb = dbModule.createDatabase(':memory:');
  jest.spyOn(dbModule, 'getDb').mockReturnValue(testDb);
  app = createApp();
  delete process.env.AI_API_KEY;
  delete process.env.OPENAI_API_KEY;
});

afterEach(() => {
  testDb.close();
  jest.restoreAllMocks();
  global.fetch = realFetch;
});

// ─── DB helpers ──────────────────────────────────────────────────────────────

let keySeq = 0;

function insertStatement(db, {
  source_type = 'account', source_id = 1, statement_type = 'bank',
  last4 = null, period_start = null, period_end = null,
} = {}) {
  return Number(db.prepare(
    `INSERT INTO expense_statements (source_type, source_id, statement_type, last4, period_start, period_end)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(source_type, source_id, statement_type, last4, period_start, period_end).lastInsertRowid);
}

function insertTxn(db, statementId, {
  date, description = 'TEST', amount, direction, kind, category = null,
  matched_txn_id = null, kind_locked = 0, needs_review = 0,
}) {
  const s = db.prepare('SELECT source_type, source_id FROM expense_statements WHERE id = ?').get(statementId);
  return Number(db.prepare(
    `INSERT INTO transactions
       (statement_id, source_type, source_id, txn_date, description, amount, direction, kind, category,
        matched_txn_id, kind_locked, needs_review, dedupe_key)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(statementId, s.source_type, s.source_id, date, description, amount, direction, kind, category,
    matched_txn_id, kind_locked, needs_review, `test-${++keySeq}`).lastInsertRowid);
}

// ─── Schema ──────────────────────────────────────────────────────────────────

describe('Expense schema (v9)', () => {
  test('creates the expense tables and stamps schema version 9', () => {
    expect(testDb.pragma('user_version', { simple: true })).toBe(9);
    const tables = testDb.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name);
    expect(tables).toEqual(expect.arrayContaining(['expense_statements', 'transactions', 'merchant_rules']));
  });

  test('dedupe_key is unique', () => {
    const s = insertStatement(testDb);
    const insert = () => testDb.prepare(
      `INSERT INTO transactions (statement_id, source_type, source_id, txn_date, description, amount, direction, kind, dedupe_key)
       VALUES (?, 'account', 1, '2026-08-01', 'X', 10, 'debit', 'expense', 'same-key')`
    ).run(s);
    insert();
    expect(insert).toThrow(/UNIQUE/);
  });

  test('deleting a statement deletes its transactions and unpairs partners', () => {
    const bank = insertStatement(testDb, { statement_type: 'bank' });
    const card = insertStatement(testDb, { source_type: 'liability', statement_type: 'credit_card' });
    const debit = insertTxn(testDb, bank, { date: '2026-08-05', amount: 100, direction: 'debit', kind: 'cc_payment' });
    const credit = insertTxn(testDb, card, { date: '2026-08-06', amount: 100, direction: 'credit', kind: 'cc_payment', matched_txn_id: debit });
    testDb.prepare('UPDATE transactions SET matched_txn_id = ? WHERE id = ?').run(credit, debit);

    testDb.prepare('DELETE FROM expense_statements WHERE id = ?').run(card);

    expect(testDb.prepare('SELECT COUNT(*) AS n FROM transactions WHERE statement_id = ?').get(card).n).toBe(0);
    expect(testDb.prepare('SELECT matched_txn_id FROM transactions WHERE id = ?').get(debit).matched_txn_id).toBeNull();
  });
});

// ─── Family member helper ────────────────────────────────────────────────────

describe('normalizeFamilyMember', () => {
  const { normalizeFamilyMember, DEFAULT_FAMILY_MEMBER } = require('../src/utils/familyMember');

  test('matches the existing normalisation used by accounts and net worth', () => {
    expect(DEFAULT_FAMILY_MEMBER).toBe('Self');
    expect(normalizeFamilyMember(undefined)).toBe('Self');
    expect(normalizeFamilyMember('   ')).toBe('Self');
    expect(normalizeFamilyMember('you')).toBe('Self');
    expect(normalizeFamilyMember('  jane   DOE ')).toBe('Jane Doe');
  });
});
