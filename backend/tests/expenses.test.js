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

// ─── Classifier ──────────────────────────────────────────────────────────────

describe('transactionClassifier', () => {
  const clf = require('../src/utils/transactionClassifier');
  const base = { date: '2026-08-05', amount: 100, merchant: null, confidence: 0.95 };
  const one = (txn, ctx) => clf.applyPostProcessing([{ ...base, ...txn }], ctx)[0];

  test('merchantKey strips UPI references, VPA handles and digits', () => {
    expect(clf.merchantKey('UPI/412345678901/SWIGGY/swiggy@icici/Payment')).toBe('SWIGGY SWIGGY PAYMENT');
    expect(clf.merchantKey('UPI/998877665544/SWIGGY/swiggy@icici/Payment'))
      .toBe(clf.merchantKey('UPI/412345678901/SWIGGY/swiggy@icici/Payment'));
  });

  test('mentionsLast4 needs a masked account/card prefix', () => {
    expect(clf.mentionsLast4('CC PAYMENT XX1234 BILLDESK', '1234')).toBe(true);
    expect(clf.mentionsLast4('IMPS TO A/C 1234', '1234')).toBe(true);
    expect(clf.mentionsLast4('REF 99912345', '1234')).toBe(false);
    expect(clf.mentionsLast4('CC PAYMENT XX1234', null)).toBe(false);
  });

  test('keywordClassify', () => {
    expect(clf.keywordClassify('SALARY AUG ACME', 'credit', 'bank')).toMatchObject({ kind: 'income' });
    expect(clf.keywordClassify('NACH/ZERODHA BROKING SIP', 'debit', 'bank')).toMatchObject({ kind: 'investment' });
    expect(clf.keywordClassify('SWIGGY BANGALORE', 'debit', 'credit_card')).toMatchObject({ kind: 'expense', category: 'Food & Dining' });
    expect(clf.keywordClassify('AMAZON REFUND', 'credit', 'credit_card')).toMatchObject({ kind: 'refund', category: 'Shopping' });
    expect(clf.keywordClassify('SOMETHING ODD', 'debit', 'bank')).toEqual({ kind: 'expense', category: 'Other', confidence: 0.5 });
    expect(clf.keywordClassify('NEFT FROM A FRIEND', 'credit', 'bank')).toEqual({ kind: 'income', category: null, confidence: 0.5 });
  });

  test('a bank card-payment debit is excluded even when the AI called it shopping', () => {
    expect(one({ description: 'CC PAYMENT XX1234 BILLDESK', direction: 'debit', kind: 'expense', category: 'Shopping' }, { statementType: 'bank' }))
      .toMatchObject({ kind: 'cc_payment', category: null, needs_review: false });
  });

  test('a bank debit naming a known card last4 is a card payment', () => {
    expect(one({ description: 'NETBANKING TRF CARD NO XXXXXXXX9876', direction: 'debit', kind: 'expense', category: 'Other' },
      { statementType: 'bank', knownCardLast4: ['9876'] })).toMatchObject({ kind: 'cc_payment' });
  });

  test('hard exclusion rules beat learned merchant rules', () => {
    const rules = new Map([[clf.merchantKey('CC PAYMENT XX1234 BILLDESK'), { kind: 'expense', category: 'Shopping' }]]);
    expect(one({ description: 'CC PAYMENT XX1234 BILLDESK', direction: 'debit', kind: 'expense' }, { statementType: 'bank', rules }))
      .toMatchObject({ kind: 'cc_payment' });
  });

  test('a learned merchant rule overrides the parser and clears needs_review', () => {
    const desc = 'UPI/111/RAMESH KUMAR/ramesh@okaxis/aug';
    const rules = new Map([[clf.merchantKey(desc), { kind: 'expense', category: 'Rent' }]]);
    expect(one({ description: desc, direction: 'debit', kind: 'expense', category: 'Other', confidence: 0.4 }, { statementType: 'bank', rules }))
      .toMatchObject({ kind: 'expense', category: 'Rent', needs_review: false });
  });

  test('card statement: bill payment credit is excluded, other credits are refunds', () => {
    expect(one({ description: 'PAYMENT RECEIVED - THANK YOU', direction: 'credit', kind: 'income' }, { statementType: 'credit_card' }))
      .toMatchObject({ kind: 'cc_payment', category: null });
    expect(one({ description: 'AMAZON REVERSAL', direction: 'credit', kind: 'income', category: 'Shopping' }, { statementType: 'credit_card' }))
      .toMatchObject({ kind: 'refund', category: 'Shopping' });
  });

  test('a narration naming another own bank account is a transfer', () => {
    expect(one({ description: 'IMPS TO A/C XX7777', direction: 'debit', kind: 'expense', category: 'Other' },
      { statementType: 'bank', otherBankLast4: ['7777'] })).toMatchObject({ kind: 'transfer', category: null });
  });

  test('flags low confidence, "Other" and personal UPI payments for review', () => {
    const ctx = { statementType: 'bank' };
    expect(one({ description: 'AMAZON PAY', direction: 'debit', kind: 'expense', category: 'Shopping', confidence: 0.5 }, ctx).needs_review).toBe(true);
    expect(one({ description: 'NEFT ACME', direction: 'debit', kind: 'expense', category: 'Other' }, ctx).needs_review).toBe(true);
    expect(one({ description: 'UPI/555/SURESH/suresh@ybl/dinner', direction: 'debit', kind: 'expense', category: 'Food & Dining' }, ctx).needs_review).toBe(true);
    expect(one({ description: 'SWIGGY', direction: 'debit', kind: 'expense', category: 'Food & Dining' }, ctx).needs_review).toBe(false);
  });

  test('an unknown parser kind falls back to keyword rules', () => {
    expect(one({ description: 'ZOMATO ORDER', direction: 'debit', kind: 'shopping', category: null, confidence: null }, { statementType: 'bank' }))
      .toMatchObject({ kind: 'expense', category: 'Food & Dining' });
  });

  test('computeDedupeKeys is stable and keeps identical rows apart', () => {
    const t = { date: '2026-08-01', description: 'COFFEE DAY', amount: 100, direction: 'debit' };
    const twice = clf.computeDedupeKeys([t, t], 'account', 1);
    expect(twice[0].dedupe_key).not.toBe(twice[1].dedupe_key);
    expect(clf.computeDedupeKeys([t], 'account', 1)[0].dedupe_key).toBe(twice[0].dedupe_key);
    expect(clf.computeDedupeKeys([t], 'account', 2)[0].dedupe_key).not.toBe(twice[0].dedupe_key);
  });

  test('reconciliationNote', () => {
    const txns = [{ direction: 'credit', amount: 100000 }, { direction: 'debit', amount: 25450 }];
    expect(clf.reconciliationNote({ opening_balance: 50000, closing_balance: 124550 }, txns, 'bank')).toBeNull();
    expect(clf.reconciliationNote({ opening_balance: 50000, closing_balance: 120000 }, txns, 'bank')).toMatch(/do not reconcile/);
    expect(clf.reconciliationNote({ opening_balance: 20000, closing_balance: 12300 },
      [{ direction: 'debit', amount: 13300 }, { direction: 'credit', amount: 21000 }], 'credit_card')).toBeNull();
    expect(clf.reconciliationNote({ opening_balance: null, closing_balance: 1 }, txns, 'bank')).toBeNull();
  });
});
