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

// ─── Pattern parser ──────────────────────────────────────────────────────────

const fx = require('./helpers/expenseFixtures');

describe('transactionParser – pattern parsing', () => {
  const tp = require('../src/utils/transactionParser');

  test('parseTxnDate reads numeric dates day-first and rejects impossible dates', () => {
    expect(tp.parseTxnDate('05/08/2026')).toBe('2026-08-05');
    expect(tp.parseTxnDate('05/08/26')).toBe('2026-08-05');
    expect(tp.parseTxnDate('5-Aug-26')).toBe('2026-08-05');
    expect(tp.parseTxnDate('05 Aug 2026')).toBe('2026-08-05');
    expect(tp.parseTxnDate('2026-08-05')).toBe('2026-08-05');
    expect(tp.parseTxnDate('29/02/2028')).toBe('2028-02-29');
    expect(tp.parseTxnDate('31/02/2026')).toBeNull();
    expect(tp.parseTxnDate('13/13/2026')).toBeNull();
    expect(tp.parseTxnDate('')).toBeNull();
  });

  test('parseAmount', () => {
    expect(tp.parseAmount('₹1,00,000.50')).toBe(100000.5);
    expect(tp.parseAmount('450.00 Cr')).toBe(450);
    expect(tp.parseAmount('-450.00')).toBe(450);
    expect(tp.parseAmount(12)).toBe(12);
    expect(tp.parseAmount('')).toBeNull();
    expect(tp.parseAmount('abc')).toBeNull();
  });

  test('detectStatementHeader – bank and card', () => {
    expect(tp.detectStatementHeader(fx.BANK_TEXT)).toEqual({
      last4: '4821', period_start: '2026-08-01', period_end: '2026-08-31', opening_balance: 50000, closing_balance: 124550,
    });
    expect(tp.detectStatementHeader(fx.CARD_TEXT)).toEqual({
      last4: '1234', period_start: '2026-08-01', period_end: '2026-08-31', opening_balance: 20000, closing_balance: 12300,
    });
  });

  test('bank page: value dates stay in the row and direction comes from the running balance', () => {
    const txns = tp.parsePageWithPattern(fx.BANK_TEXT, 'bank', { prevBalance: 50000 });
    expect(txns.map((t) => [t.date, t.direction, t.amount, t.kind])).toEqual([
      ['2026-08-01', 'credit', 100000, 'income'],
      ['2026-08-03', 'debit', 450, 'expense'],
      ['2026-08-05', 'debit', 20000, 'expense'],
      ['2026-08-10', 'debit', 5000, 'investment'],
    ]);
    expect(txns[0].description).toBe('SALARY AUG ACME CORP');
  });

  test('card page: a Cr marker means credit', () => {
    const txns = tp.parsePageWithPattern(fx.CARD_TEXT, 'credit_card', { prevBalance: 20000 });
    expect(txns.map((t) => [t.date, t.direction, t.amount])).toEqual([
      ['2026-08-02', 'debit', 800],
      ['2026-08-04', 'debit', 3500],
      ['2026-08-06', 'credit', 20000],
      ['2026-08-12', 'credit', 1000],
      ['2026-08-20', 'debit', 9000],
    ]);
  });

  test('works on text without line breaks', () => {
    expect(tp.parsePageWithPattern(fx.BANK_TEXT.replace(/\n/g, ' '), 'bank', { prevBalance: 50000 })).toHaveLength(4);
  });

  test('the running balance carries across pages', () => {
    const state = { prevBalance: 50000 };
    const page1 = tp.parsePageWithPattern(fx.BANK_LINES.slice(0, 7).join('\n'), 'bank', state);
    const page2 = tp.parsePageWithPattern(fx.BANK_LINES.slice(7).join('\n'), 'bank', state);
    expect(page1).toHaveLength(2);
    expect(page2.map((t) => t.direction)).toEqual(['debit', 'debit']);
    expect(page2.every((t) => t.confidence > 0.4)).toBe(true);
  });
});

// ─── PDF pages + AI passes ───────────────────────────────────────────────────

describe('pdfExtractor – pages', () => {
  const { extractPdfPages, extractPdfText } = require('../src/utils/pdfExtractor');

  test('extractPdfPages keeps line breaks when asked; extractPdfText is unchanged', async () => {
    const pdf = fx.makePdf(['LINE ONE 1.00', 'LINE TWO 2.00']);
    const pages = await extractPdfPages(pdf, '', { preserveLines: true });
    expect(pages).toHaveLength(1);
    expect(pages[0]).toMatch(/LINE ONE 1\.00\nLINE TWO 2\.00/);
    expect(await extractPdfText(pdf, '')).toMatch(/LINE ONE 1\.00 LINE TWO 2\.00/);
  });
});

describe('transactionParser – AI passes', () => {
  const tp = require('../src/utils/transactionParser');
  const opts = { statementType: 'bank', apiKey: 'test-key' };
  const aiTxn = (o = {}) => ({
    date: '2026-08-03', description: 'UPI/SWIGGY', merchant: 'Swiggy', amount: 450, direction: 'debit',
    kind: 'expense', category: 'Food & Dining', confidence: 0.9, ...o,
  });
  const ccRow = aiTxn({ date: '2026-08-05', description: 'CC PAYMENT XX1234', amount: 20000, kind: 'cc_payment', category: null });

  test('runs extract → validate → review in order and returns the reviewed rows', async () => {
    const calls = fx.mockAi((sys) => {
      if (sys === tp.PROMPTS.extract('bank')) {
        return { statement: { last4: '4821', period_start: '2026-08-01', period_end: '2026-08-31', opening_balance: 50000, closing_balance: 124550 }, transactions: [aiTxn()] };
      }
      if (sys === tp.PROMPTS.validate) return { transactions: [aiTxn(), ccRow], validation_notes: ['Added missed CC payment'] };
      if (sys === tp.PROMPTS.review) return { transactions: [aiTxn({ amount: 4500 }), ccRow], accuracy_notes: ['Fixed amount magnitude'] };
      return new Error('unexpected prompt');
    });
    const r = await tp.parseTransactionsFromPages(['PAGE ONE TEXT'], opts);
    expect(calls.map((c) => c.sys)).toEqual([tp.PROMPTS.extract('bank'), tp.PROMPTS.validate, tp.PROMPTS.review]);
    expect(calls[0].body).toMatchObject({ model: 'gpt-4o-mini', temperature: 0 });
    expect(r.method).toBe('ai');
    expect(r.transactions.map((t) => t.amount)).toEqual([4500, 20000]);
    expect(r.validation_notes).toEqual(['Page 1: Added missed CC payment', 'Page 1: Fixed amount magnitude']);
    expect(r.statement).toMatchObject({ last4: '4821', closing_balance: 124550, period_end: '2026-08-31' });
  });

  test('rejects a validation pass that drops rows and skips review when there are no corrections', async () => {
    const calls = fx.mockAi((sys) => (sys === tp.PROMPTS.extract('bank')
      ? { statement: {}, transactions: [aiTxn(), aiTxn({ date: '2026-08-04' })] }
      : { transactions: [aiTxn()], validation_notes: ['dropped one'] }));
    const r = await tp.parseTransactionsFromPages(['TEXT'], opts);
    expect(r.transactions).toHaveLength(2);
    expect(calls).toHaveLength(2);
  });

  test('sends each page separately', async () => {
    const calls = fx.mockAi((sys, user) => (sys === tp.PROMPTS.extract('bank')
      ? { statement: {}, transactions: [aiTxn({ description: user })] }
      : { transactions: [aiTxn({ description: 'x' })], validation_notes: [] }));
    const r = await tp.parseTransactionsFromPages(['PAGE A', 'PAGE B'], opts);
    expect(calls.filter((c) => c.sys === tp.PROMPTS.extract('bank')).map((c) => c.user)).toEqual(['PAGE A', 'PAGE B']);
    expect(r.transactions).toHaveLength(2);
  });

  test('falls back to the pattern parser for a page when AI fails', async () => {
    fx.mockAi(() => new Error('boom'));
    const r = await tp.parseTransactionsFromPages([fx.BANK_TEXT], opts);
    expect(r.method).toBe('pattern');
    expect(r.transactions).toHaveLength(4);
    expect(r.validation_notes[0]).toMatch(/^Page 1: AI parsing failed/);
  });

  test('drops AI rows without a usable date, amount or direction', async () => {
    fx.mockAi((sys) => (sys === tp.PROMPTS.extract('bank')
      ? { statement: {}, transactions: [aiTxn({ date: 'garbage' }), aiTxn({ amount: 0 }), aiTxn({ direction: 'sideways' }), aiTxn()] }
      : { transactions: [aiTxn({ date: 'garbage' }), aiTxn({ amount: 0 }), aiTxn({ direction: 'sideways' }), aiTxn()], validation_notes: [] }));
    const r = await tp.parseTransactionsFromPages(['TEXT'], opts);
    expect(r.transactions).toHaveLength(1);
  });

  test('without an AI key the pattern parser is used and fetch is never called', async () => {
    global.fetch = jest.fn();
    const r = await tp.parseTransactionsFromPages([fx.BANK_TEXT], { statementType: 'bank' });
    expect(global.fetch).not.toHaveBeenCalled();
    expect(r.method).toBe('pattern');
    expect(r.statement).toMatchObject({ last4: '4821', opening_balance: 50000, closing_balance: 124550 });
  });
});

// ─── CSV parsing ─────────────────────────────────────────────────────────────

describe('transactionParser – CSV', () => {
  const tp = require('../src/utils/transactionParser');
  const rowsOf = (r) => r.transactions.map((t) => [t.date, t.direction, t.amount]);

  test('maps bank CSV columns by alias and skips preamble rows', async () => {
    const r = await tp.parseTransactionsFromCsv(Buffer.from(fx.BANK_CSV), { statementType: 'bank' });
    expect(r.method).toBe('pattern');
    expect(rowsOf(r)).toEqual([
      ['2026-08-01', 'credit', 100000], ['2026-08-03', 'debit', 450],
      ['2026-08-05', 'debit', 20000], ['2026-08-10', 'debit', 5000],
    ]);
    expect(r.statement).toMatchObject({ period_start: '2026-08-01', period_end: '2026-08-10', opening_balance: 50000, closing_balance: 124550 });
  });

  test('newest-first CSV still gets the right opening and closing balance', async () => {
    const csv = [...fx.BANK_CSV_HEADER, ...[...fx.BANK_CSV_ROWS].reverse()].join('\n');
    const r = await tp.parseTransactionsFromCsv(Buffer.from(csv), { statementType: 'bank' });
    expect(r.statement).toMatchObject({ opening_balance: 50000, closing_balance: 124550 });
  });

  test('single amount column with a Debit/Credit column', async () => {
    const r = await tp.parseTransactionsFromCsv(Buffer.from(fx.CARD_CSV), { statementType: 'credit_card' });
    expect(rowsOf(r)).toEqual([['2026-08-02', 'debit', 800], ['2026-08-06', 'credit', 20000]]);
    expect(r.statement.closing_balance).toBeNull();
  });

  test('rows with no direction marker become low-confidence debits', async () => {
    const r = await tp.parseTransactionsFromCsv(Buffer.from('Date,Description,Amount\n01/08/2026,SOMETHING,100.00'), { statementType: 'bank' });
    expect(r.transactions[0]).toMatchObject({ direction: 'debit', amount: 100 });
    expect(r.transactions[0].confidence).toBeLessThanOrEqual(0.4);
  });

  test('rejects a CSV with no recognisable header', async () => {
    await expect(tp.parseTransactionsFromCsv(Buffer.from('a,b\n1,2'), { statementType: 'bank' }))
      .rejects.toMatchObject({ status: 422 });
  });

  test('uses AI column mapping and classification when a key is set', async () => {
    const calls = fx.mockAi((sys, user) => {
      if (sys === tp.PROMPTS.csvMap) {
        return { column_mapping: { Date: 'date', Narration: 'description', 'Withdrawal Amt.': 'debit', 'Deposit Amt.': 'credit', 'Closing Balance': 'balance', 'Value Dt': null, 'Chq./Ref.No.': null } };
      }
      if (sys === tp.PROMPTS.classify('bank')) {
        return { results: JSON.parse(user).map((t) => ({ i: t.i, merchant: 'M', kind: t.direction === 'credit' ? 'income' : 'expense', category: t.direction === 'credit' ? null : 'Shopping', confidence: 0.9 })) };
      }
      return new Error('unexpected prompt');
    });
    const r = await tp.parseTransactionsFromCsv(Buffer.from(fx.BANK_CSV), { statementType: 'bank', apiKey: 'k' });
    expect(calls.map((c) => c.sys)).toEqual([tp.PROMPTS.csvMap, tp.PROMPTS.classify('bank')]);
    expect(r.method).toBe('ai');
    expect(r.transactions[1]).toMatchObject({ merchant: 'M', kind: 'expense', category: 'Shopping' });
  });

  test('falls back to aliases and keywords when AI fails', async () => {
    fx.mockAi((sys) => (sys === tp.PROMPTS.csvMap ? { column_mapping: {} } : new Error('boom')));
    const r = await tp.parseTransactionsFromCsv(Buffer.from(fx.BANK_CSV), { statementType: 'bank', apiKey: 'k' });
    expect(r.method).toBe('pattern');
    expect(r.transactions).toHaveLength(4);
    expect(r.validation_notes).toEqual([
      expect.stringMatching(/^AI column mapping failed/),
      expect.stringMatching(/^AI classification failed/),
    ]);
  });
});

// ─── Matcher ─────────────────────────────────────────────────────────────────

describe('transactionMatcher', () => {
  const { runMatcher } = require('../src/utils/transactionMatcher');
  const W = { from: '2026-07-01', to: '2026-09-30' };
  const get = (id) => testDb.prepare('SELECT * FROM transactions WHERE id = ?').get(id);
  let bank;
  let card;

  beforeEach(() => {
    bank = insertStatement(testDb, { source_type: 'account', source_id: 1, statement_type: 'bank', last4: '4821' });
    card = insertStatement(testDb, { source_type: 'liability', source_id: 1, statement_type: 'credit_card', last4: '1234' });
  });

  const cardPayment = (date, amount = 20000, stmt = card) =>
    insertTxn(testDb, stmt, { date, description: 'PAYMENT RECEIVED', amount, direction: 'credit', kind: 'cc_payment' });
  const bankPayment = (date, amount = 20000) =>
    insertTxn(testDb, bank, { date, description: 'CC PAYMENT XX1234', amount, direction: 'debit', kind: 'cc_payment' });

  test('pairs a bank card-payment debit with the card payment credit', () => {
    const d = bankPayment('2026-08-05');
    const c = cardPayment('2026-08-06');
    expect(runMatcher(testDb, W)).toEqual({ card_payments: 1, promoted: 0, transfers: 0 });
    expect(get(d).matched_txn_id).toBe(c);
    expect(get(c).matched_txn_id).toBe(d);
  });

  test('pairs on a later run, whichever statement arrived first', () => {
    const c = cardPayment('2026-08-06');
    expect(runMatcher(testDb, W).card_payments).toBe(0);
    const d = bankPayment('2026-08-05');
    expect(runMatcher(testDb, W).card_payments).toBe(1);
    expect(get(c).matched_txn_id).toBe(d);
  });

  test('matches within 5 days but not 6', () => {
    const near = bankPayment('2026-08-01', 500);
    cardPayment('2026-08-06', 500);
    const far = bankPayment('2026-08-10', 700);
    cardPayment('2026-08-16', 700);
    runMatcher(testDb, W);
    expect(get(near).matched_txn_id).not.toBeNull();
    expect(get(far).matched_txn_id).toBeNull();
  });

  test('allows ₹1 of rounding but not more', () => {
    const ok = bankPayment('2026-08-05', 20000);
    cardPayment('2026-08-05', 20000.5);
    const off = bankPayment('2026-08-20', 3000);
    cardPayment('2026-08-20', 3002);
    runMatcher(testDb, W);
    expect(get(ok).matched_txn_id).not.toBeNull();
    expect(get(off).matched_txn_id).toBeNull();
  });

  test('prefers the card whose last4 the narration mentions over a closer date', () => {
    const otherCard = insertStatement(testDb, { source_type: 'liability', source_id: 2, statement_type: 'credit_card', last4: '9999' });
    const d = bankPayment('2026-08-05');
    const wrong = cardPayment('2026-08-05', 20000, otherCard);
    const right = cardPayment('2026-08-08');
    runMatcher(testDb, W);
    expect(get(d).matched_txn_id).toBe(right);
    expect(get(wrong).matched_txn_id).toBeNull();
  });

  test('promotes an unrecognised bank debit that matches a card payment and flags it', () => {
    const d = insertTxn(testDb, bank, { date: '2026-08-12', description: 'NEFT ODD NAME', amount: 7000, direction: 'debit', kind: 'expense', category: 'Other' });
    cardPayment('2026-08-14', 7000);
    expect(runMatcher(testDb, W).promoted).toBe(1);
    expect(get(d)).toMatchObject({ kind: 'cc_payment', category: null, needs_review: 1 });
  });

  test('never changes a kind the user locked', () => {
    const d = insertTxn(testDb, bank, { date: '2026-08-12', description: 'NEFT ODD NAME', amount: 7000, direction: 'debit', kind: 'expense', category: 'Rent', kind_locked: 1 });
    cardPayment('2026-08-14', 7000);
    runMatcher(testDb, W);
    expect(get(d)).toMatchObject({ kind: 'expense', category: 'Rent', matched_txn_id: null });
  });

  test('pairs a transfer between two own bank accounts', () => {
    const bank2 = insertStatement(testDb, { source_type: 'account', source_id: 2, statement_type: 'bank', last4: '7777' });
    const d = insertTxn(testDb, bank, { date: '2026-08-15', description: 'IMPS TO A/C XX7777', amount: 3000, direction: 'debit', kind: 'expense', category: 'Other' });
    const c = insertTxn(testDb, bank2, { date: '2026-08-16', description: 'IMPS FROM', amount: 3000, direction: 'credit', kind: 'income' });
    expect(runMatcher(testDb, W).transfers).toBe(1);
    expect(get(d)).toMatchObject({ kind: 'transfer', matched_txn_id: c });
    expect(get(c)).toMatchObject({ kind: 'transfer', matched_txn_id: d });
  });

  test('does not treat a debit and credit in the same account as a transfer', () => {
    insertTxn(testDb, bank, { date: '2026-08-15', description: 'TRANSFER', amount: 3000, direction: 'debit', kind: 'transfer' });
    insertTxn(testDb, bank, { date: '2026-08-15', description: 'TRANSFER', amount: 3000, direction: 'credit', kind: 'transfer' });
    expect(runMatcher(testDb, W).transfers).toBe(0);
  });

  test('an unmatched card payment stays excluded', () => {
    const d = bankPayment('2026-08-05');
    runMatcher(testDb, W);
    expect(get(d)).toMatchObject({ kind: 'cc_payment', matched_txn_id: null });
  });
});

// ─── API: preview & commit ───────────────────────────────────────────────────

describe('Expenses API – preview & commit', () => {
  const pdfExtractor = require('../src/utils/pdfExtractor');
  let accountId;
  let cardId;

  beforeEach(async () => {
    accountId = (await request(app).post('/api/accounts').send({ name: 'HDFC Savings', type: 'savings', balance: 0 })).body.id;
    cardId = (await request(app).post('/api/liabilities').send({ name: 'HDFC Regalia', type: 'credit_card', current_balance: 0 })).body.id;
  });

  const preview = (file, name, fields) => {
    let req = request(app).post('/api/expenses/preview');
    for (const [k, v] of Object.entries(fields)) req = req.field(k, String(v));
    return req.attach('file', file, name);
  };
  const commitFrom = (p, sourceType, sourceId, extra = {}) => request(app).post('/api/expenses/commit').send({
    source_type: sourceType, source_id: sourceId,
    statement: { ...p.statement, parse_method: p.method },
    transactions: p.transactions.filter((t) => !t.duplicate),
    ...extra,
  });
  const count = (table) => testDb.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
  const bankCsv = (extraRows = []) => Buffer.from([fx.BANK_CSV, ...extraRows].join('\n'));

  test('previews a PDF bank statement without saving anything', async () => {
    const res = await preview(fx.makePdf(fx.BANK_LINES), 'aug.pdf', { source_type: 'account', source_id: accountId });
    expect(res.status).toBe(200);
    expect(res.body.method).toBe('pattern');
    expect(res.body.statement).toMatchObject({ statement_type: 'bank', last4: '4821', closing_balance: 124550, file_name: 'aug.pdf' });
    expect(res.body.transactions.map((t) => t.kind)).toEqual(['income', 'expense', 'cc_payment', 'investment']);
    expect(res.body.transactions.every((t) => t.dedupe_key && t.duplicate === false)).toBe(true);
    expect(res.body.balance_update).toMatchObject({ eligible: true, default_checked: true, entity_type: 'account', proposed: 124550 });
    expect(res.body.validation_notes).toEqual([]);
    expect(count('transactions')).toBe(0);
  });

  test('validates the source and the file type', async () => {
    expect((await preview(bankCsv(), 'a.csv', { source_type: 'account', source_id: 999 })).status).toBe(404);
    expect((await preview(bankCsv(), 'a.csv', { source_type: 'bogus', source_id: accountId })).status).toBe(400);
    const loanId = (await request(app).post('/api/liabilities').send({ name: 'Car Loan', type: 'auto', current_balance: 1 })).body.id;
    expect((await preview(bankCsv(), 'a.csv', { source_type: 'liability', source_id: loanId })).status).toBe(400);
    expect((await preview(Buffer.from([1, 2, 3]), 'a.png', { source_type: 'account', source_id: accountId })).status).toBe(422);
    expect((await request(app).post('/api/expenses/preview').field('source_type', 'account').field('source_id', String(accountId))).status).toBe(400);
  });

  test('reports password-protected and image-only PDFs', async () => {
    jest.spyOn(pdfExtractor, 'extractPdfPages').mockRejectedValueOnce(
      Object.assign(new Error('This PDF is password-protected. Please provide the correct password.'), { code: 'PASSWORD_REQUIRED' }));
    const locked = await preview(Buffer.from('%PDF-1.4'), 'a.pdf', { source_type: 'account', source_id: accountId });
    expect(locked.status).toBe(422);
    expect(locked.body.code).toBe('PASSWORD_REQUIRED');

    jest.spyOn(pdfExtractor, 'extractPdfPages').mockResolvedValueOnce(['  ', '']);
    const scanned = await preview(Buffer.from('%PDF-1.4'), 'a.pdf', { source_type: 'account', source_id: accountId });
    expect(scanned.status).toBe(422);
    expect(scanned.body.error).toMatch(/scanned/);
  });

  test('commit saves transactions, and a re-upload is all duplicates', async () => {
    const p = (await preview(bankCsv(), 'aug.csv', { source_type: 'account', source_id: accountId })).body;
    const first = await commitFrom(p, 'account', accountId);
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ inserted: 4, duplicates: 0, balance_updated: false });
    expect(first.body.statement_id).toEqual(expect.any(Number));

    const again = (await preview(bankCsv(), 'aug.csv', { source_type: 'account', source_id: accountId })).body;
    expect(again.transactions.every((t) => t.duplicate)).toBe(true);
    const second = await request(app).post('/api/expenses/commit').send({
      source_type: 'account', source_id: accountId, statement: again.statement, transactions: again.transactions,
    });
    expect(second.body).toMatchObject({ inserted: 0, duplicates: 4, statement_id: null });
    expect(count('transactions')).toBe(4);
    expect(count('expense_statements')).toBe(1);
  });

  test('overlapping statements only add the new rows', async () => {
    await commitFrom((await preview(bankCsv(), 'aug.csv', { source_type: 'account', source_id: accountId })).body, 'account', accountId);
    const overlap = [
      ...fx.BANK_CSV_HEADER, ...fx.BANK_CSV_ROWS.slice(2),
      '15/08/26,AMAZON PAY,0005,15/08/26,"1,000.00",,"1,23,550.00"',
    ].join('\n');
    const p = (await preview(Buffer.from(overlap), 'mid.csv', { source_type: 'account', source_id: accountId })).body;
    expect(p.transactions.map((t) => t.duplicate)).toEqual([true, true, false]);
    const res = await request(app).post('/api/expenses/commit').send({
      source_type: 'account', source_id: accountId, statement: p.statement, transactions: p.transactions,
    });
    expect(res.body).toMatchObject({ inserted: 1, duplicates: 2 });
    expect(count('transactions')).toBe(5);
  });

  test('edited rows teach merchant rules that apply to the next statement', async () => {
    const p = (await preview(bankCsv(), 'aug.csv', { source_type: 'account', source_id: accountId })).body;
    const edited = p.transactions.map((t) => (t.description.includes('SWIGGY') ? { ...t, category: 'Groceries', edited: true } : t));
    const res = await commitFrom({ ...p, transactions: edited }, 'account', accountId);
    expect(res.body.rules_learned).toBe(1);
    expect(testDb.prepare('SELECT kind_locked FROM transactions WHERE description LIKE ?').get('%SWIGGY%').kind_locked).toBe(1);

    const next = (await preview(bankCsv(['20/08/26,UPI/999999999999/SWIGGY/swiggy@icici/Payment,0006,20/08/26,300.00,,"1,24,250.00"']),
      'aug2.csv', { source_type: 'account', source_id: accountId })).body;
    const swiggy = next.transactions.find((t) => t.date === '2026-08-20');
    expect(swiggy).toMatchObject({ category: 'Groceries', needs_review: false, duplicate: false });
  });

  test('card statement then bank statement: the card payment is paired, not double counted', async () => {
    const card = (await preview(fx.makePdf(fx.CARD_LINES), 'card.pdf', { source_type: 'liability', source_id: cardId })).body;
    expect(card.statement).toMatchObject({ statement_type: 'credit_card', last4: '1234', closing_balance: 12300 });
    expect(card.transactions.map((t) => t.kind)).toEqual(['expense', 'expense', 'cc_payment', 'refund', 'expense']);
    expect((await commitFrom(card, 'liability', cardId)).status).toBe(201);

    const bank = (await preview(bankCsv(), 'aug.csv', { source_type: 'account', source_id: accountId })).body;
    const res = await commitFrom(bank, 'account', accountId);
    expect(res.body.matches).toEqual({ card_payments: 1, promoted: 0, transfers: 0 });
    const payments = testDb.prepare("SELECT matched_txn_id FROM transactions WHERE kind = 'cc_payment'").all();
    expect(payments).toHaveLength(2);
    expect(payments.every((r) => r.matched_txn_id)).toBe(true);
  });

  test('balance update writes the closing balance and value history', async () => {
    const p = (await preview(bankCsv(), 'aug.csv', { source_type: 'account', source_id: accountId })).body;
    const res = await commitFrom(p, 'account', accountId, { update_balance: true });
    expect(res.body.balance_updated).toBe(true);
    expect(testDb.prepare('SELECT balance FROM accounts WHERE id = ?').get(accountId).balance).toBe(124550);
    expect(testDb.prepare(
      "SELECT value, recorded_at FROM value_history WHERE entity_type = 'account' AND entity_id = ? AND notes = 'expense statement import'"
    ).get(accountId)).toEqual({ value: 124550, recorded_at: '2026-08-10' });
  });

  test('refuses to overwrite a newer balance unless forced', async () => {
    testDb.prepare('UPDATE accounts SET balance = 99999 WHERE id = ?').run(accountId);
    testDb.prepare("INSERT INTO value_history (entity_type, entity_id, value, recorded_at) VALUES ('account', ?, 99999, '2026-09-01')").run(accountId);
    const p = (await preview(bankCsv(), 'aug.csv', { source_type: 'account', source_id: accountId })).body;
    expect(p.balance_update.default_checked).toBe(false);

    const refused = await commitFrom(p, 'account', accountId, { update_balance: true });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('STALE_BALANCE');
    expect(count('transactions')).toBe(0);

    const forced = await commitFrom(p, 'account', accountId, { update_balance: true, force_balance: true });
    expect(forced.status).toBe(201);
    expect(testDb.prepare('SELECT balance FROM accounts WHERE id = ?').get(accountId).balance).toBe(124550);
  });

  test('rejects invalid commits', async () => {
    const send = (body) => request(app).post('/api/expenses/commit').send({ source_type: 'account', source_id: accountId, statement: {}, ...body });
    expect((await send({ transactions: [] })).status).toBe(400);
    expect((await send({ transactions: [{ date: 'bad', description: 'X', amount: 1, direction: 'debit', kind: 'expense' }] })).status).toBe(400);
    expect((await send({ transactions: [{ date: '2026-08-01', description: 'X', amount: -5, direction: 'debit', kind: 'expense' }] })).status).toBe(400);
    expect((await send({ transactions: [{ date: '2026-08-01', description: 'X', amount: 5, direction: 'debit', kind: 'shopping' }] })).status).toBe(400);
    expect((await send({ update_balance: true, transactions: [{ date: '2026-08-01', description: 'X', amount: 5, direction: 'debit', kind: 'expense' }] })).status).toBe(400);
  });

  test('accepts a commit larger than the global 100 KB JSON limit', async () => {
    const transactions = Array.from({ length: 600 }, (_, i) => ({
      date: '2026-08-01', description: `UPI/${i}/SHOP ${'X'.repeat(150)}/shop@ybl/payment`,
      amount: 10 + i, direction: 'debit', kind: 'expense', category: 'Other',
    }));
    expect(JSON.stringify(transactions).length).toBeGreaterThan(100 * 1024);
    const res = await request(app).post('/api/expenses/commit').send({ source_type: 'account', source_id: accountId, statement: {}, transactions });
    expect(res.status).toBe(201);
    expect(res.body.inserted).toBe(600);
  });
});

// ─── API: summary, trend, transactions, statements, rules ────────────────────

describe('Expenses API – reporting and editing', () => {
  let mine;
  let s1;
  let reviewId;

  beforeEach(() => {
    mine = Number(testDb.prepare("INSERT INTO accounts (name, type, balance) VALUES ('Mine', 'savings', 0)").run().lastInsertRowid);
    const hers = Number(testDb.prepare("INSERT INTO accounts (name, type, balance, family_member) VALUES ('Hers', 'savings', 0, 'spouse')").run().lastInsertRowid);
    s1 = insertStatement(testDb, { source_type: 'account', source_id: mine, statement_type: 'bank' });
    const s2 = insertStatement(testDb, { source_type: 'account', source_id: hers, statement_type: 'bank' });
    insertTxn(testDb, s1, { date: '2026-08-01', amount: 100000, direction: 'credit', kind: 'income' });
    insertTxn(testDb, s1, { date: '2026-08-03', amount: 20000, direction: 'debit', kind: 'expense', category: 'Rent' });
    reviewId = insertTxn(testDb, s1, { date: '2026-08-04', description: 'CORNER CAFE', amount: 5000, direction: 'debit', kind: 'expense', category: 'Food & Dining', needs_review: 1 });
    insertTxn(testDb, s1, { date: '2026-08-06', amount: 1000, direction: 'credit', kind: 'refund', category: 'Food & Dining' });
    insertTxn(testDb, s1, { date: '2026-08-10', amount: 10000, direction: 'debit', kind: 'investment' });
    insertTxn(testDb, s1, { date: '2026-08-12', amount: 30000, direction: 'debit', kind: 'cc_payment' });
    insertTxn(testDb, s2, { date: '2026-08-15', amount: 4000, direction: 'debit', kind: 'expense', category: 'Shopping' });
    insertTxn(testDb, s1, { date: '2026-07-20', amount: 50000, direction: 'credit', kind: 'income' });
    insertTxn(testDb, s1, { date: '2026-07-21', amount: 10000, direction: 'debit', kind: 'expense', category: 'Rent' });
  });

  test('summary: spending is net of refunds; card payments are excluded', async () => {
    const res = await request(app).get('/api/expenses/summary?month=2026-08');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      month: '2026-08', member: null,
      income: 100000, spending: 28000, refunds: 1000, invested: 10000,
      savings_rate: 0.72, investment_rate: 0.1, needs_review_count: 1,
      excluded: { total: 30000, matched_count: 0, unmatched_count: 1 },
      net_worth_change: null,
    });
    expect(res.body.by_category).toEqual([
      { category: 'Rent', amount: 20000 },
      { category: 'Food & Dining', amount: 5000 },
      { category: 'Shopping', amount: 4000 },
    ]);
  });

  test('member filter uses the linked account family member', async () => {
    const res = await request(app).get('/api/expenses/summary?month=2026-08&member=SPOUSE');
    expect(res.body).toMatchObject({ member: 'Spouse', income: 0, spending: 4000, savings_rate: null });
  });

  test('net worth change comes from snapshots inside the month, only for all members', async () => {
    const snap = (date, nw) => testDb.prepare('INSERT INTO snapshots (snapshot_date, net_worth) VALUES (?, ?)').run(date, nw);
    snap('2026-06-30', 900000);
    snap('2026-07-31', 1000000);
    snap('2026-08-31', 1072000);
    expect((await request(app).get('/api/expenses/summary?month=2026-08')).body.net_worth_change).toBe(72000);
    expect((await request(app).get('/api/expenses/summary?month=2026-08&member=Self')).body.net_worth_change).toBeNull();
    // September has no snapshot inside it: null, not 0.
    expect((await request(app).get('/api/expenses/summary?month=2026-09')).body.net_worth_change).toBeNull();
  });

  test('rejects a malformed month', async () => {
    expect((await request(app).get('/api/expenses/summary?month=2026-8')).status).toBe(400);
    expect((await request(app).get('/api/expenses/trend?end=202608')).status).toBe(400);
  });

  test('trend returns one entry per month, oldest first', async () => {
    const res = await request(app).get('/api/expenses/trend?months=3&end=2026-08');
    expect(res.body.months.map((m) => m.month)).toEqual(['2026-06', '2026-07', '2026-08']);
    expect(res.body.months[0]).toEqual({ month: '2026-06', income: 0, spending: 0, invested: 0, savings_rate: null });
    expect(res.body.months[1]).toEqual({ month: '2026-07', income: 50000, spending: 10000, invested: 0, savings_rate: 0.8 });
    expect(res.body.months[2]).toMatchObject({ spending: 28000, savings_rate: 0.72 });
  });

  test('lists transactions with filters, source name and family member', async () => {
    const review = (await request(app).get('/api/expenses/transactions?month=2026-08&needs_review=1')).body;
    expect(review).toHaveLength(1);
    expect(review[0]).toMatchObject({ id: reviewId, source_name: 'Mine', family_member: 'Self', statement_type: 'bank' });
    expect((await request(app).get('/api/expenses/transactions?kind=cc_payment')).body).toHaveLength(1);
    expect((await request(app).get('/api/expenses/transactions?member=spouse')).body).toHaveLength(1);
    expect((await request(app).get('/api/expenses/transactions?month=2026-07')).body).toHaveLength(2);
  });

  test('editing a transaction clears review, locks the kind and learns a rule', async () => {
    testDb.prepare('UPDATE transactions SET merchant_key = ? WHERE id = ?').run('CORNER CAFE', reviewId);
    const res = await request(app).put(`/api/expenses/transactions/${reviewId}`).send({ kind: 'expense', category: 'Groceries' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: reviewId, category: 'Groceries', needs_review: 0, kind_locked: 1, source_name: 'Mine' });
    expect(testDb.prepare('SELECT kind, category FROM merchant_rules WHERE merchant_key = ?').get('CORNER CAFE'))
      .toEqual({ kind: 'expense', category: 'Groceries' });
    expect((await request(app).put(`/api/expenses/transactions/${reviewId}`).send({ kind: 'nope' })).status).toBe(400);
    expect((await request(app).put('/api/expenses/transactions/99999').send({ kind: 'expense' })).status).toBe(404);
  });

  test('changing a paired card payment to an expense unpairs both and flags the partner', async () => {
    const card = insertStatement(testDb, { source_type: 'liability', source_id: 1, statement_type: 'credit_card' });
    const debit = insertTxn(testDb, s1, { date: '2026-08-20', amount: 700, direction: 'debit', kind: 'cc_payment' });
    const credit = insertTxn(testDb, card, { date: '2026-08-21', amount: 700, direction: 'credit', kind: 'cc_payment', matched_txn_id: debit });
    testDb.prepare('UPDATE transactions SET matched_txn_id = ? WHERE id = ?').run(credit, debit);

    await request(app).put(`/api/expenses/transactions/${debit}`).send({ kind: 'expense', category: 'Other', remember: false });

    const get = (id) => testDb.prepare('SELECT * FROM transactions WHERE id = ?').get(id);
    expect(get(debit)).toMatchObject({ kind: 'expense', matched_txn_id: null });
    expect(get(credit)).toMatchObject({ matched_txn_id: null, needs_review: 1 });
    expect(testDb.prepare('SELECT COUNT(*) AS n FROM merchant_rules').get().n).toBe(0);
  });

  test('deleting a statement removes its rows and flags partners in other statements', async () => {
    const card = insertStatement(testDb, { source_type: 'liability', source_id: 1, statement_type: 'credit_card' });
    const debit = insertTxn(testDb, s1, { date: '2026-08-20', amount: 700, direction: 'debit', kind: 'cc_payment' });
    const credit = insertTxn(testDb, card, { date: '2026-08-21', amount: 700, direction: 'credit', kind: 'cc_payment', matched_txn_id: debit });
    testDb.prepare('UPDATE transactions SET matched_txn_id = ? WHERE id = ?').run(credit, debit);

    expect((await request(app).delete(`/api/expenses/statements/${card}`)).status).toBe(200);
    expect(testDb.prepare('SELECT matched_txn_id, needs_review, kind FROM transactions WHERE id = ?').get(debit))
      .toEqual({ matched_txn_id: null, needs_review: 1, kind: 'cc_payment' });
    expect((await request(app).delete(`/api/expenses/statements/${card}`)).status).toBe(404);
  });

  test('lists statements with source name and transaction count', async () => {
    testDb.prepare('DELETE FROM accounts WHERE name = ?').run('Hers');
    const list = (await request(app).get('/api/expenses/statements')).body;
    expect(list).toHaveLength(2);
    expect(list.find((s) => s.id === s1)).toMatchObject({ source_name: 'Mine', transaction_count: 8 });
    expect(list.find((s) => s.id !== s1)).toMatchObject({ source_name: null, transaction_count: 1 });
  });

  test('lists and deletes learned rules', async () => {
    const id = Number(testDb.prepare("INSERT INTO merchant_rules (merchant_key, kind, category) VALUES ('SWIGGY', 'expense', 'Food & Dining')").run().lastInsertRowid);
    expect((await request(app).get('/api/expenses/rules')).body).toEqual([expect.objectContaining({ id, merchant_key: 'SWIGGY' })]);
    expect((await request(app).delete(`/api/expenses/rules/${id}`)).status).toBe(200);
    expect((await request(app).get('/api/expenses/rules')).body).toEqual([]);
  });

  test('categories include the defaults plus custom ones in use', async () => {
    insertTxn(testDb, s1, { date: '2026-08-22', amount: 50, direction: 'debit', kind: 'expense', category: 'Pets' });
    const cats = (await request(app).get('/api/expenses/categories')).body;
    expect(cats).toEqual(expect.arrayContaining(['Groceries', 'Other', 'Pets']));
    expect(cats.filter((c) => c === 'Rent')).toHaveLength(1);
  });
});

// ─── Export / import ─────────────────────────────────────────────────────────

describe('Export / import of expense data', () => {
  function seed(db) {
    const acct = Number(db.prepare("INSERT INTO accounts (name, institution, type, balance, created_at, updated_at) VALUES ('HDFC Savings', 'HDFC', 'savings', 0, datetime('now'), datetime('now'))").run().lastInsertRowid);
    const card = Number(db.prepare("INSERT INTO liabilities (name, lender, type, current_balance, created_at, updated_at) VALUES ('Regalia', 'HDFC', 'credit_card', 0, datetime('now'), datetime('now'))").run().lastInsertRowid);
    const bankStmt = insertStatement(db, { source_type: 'account', source_id: acct, statement_type: 'bank', period_start: '2026-08-01', period_end: '2026-08-31' });
    const cardStmt = insertStatement(db, { source_type: 'liability', source_id: card, statement_type: 'credit_card', period_start: '2026-08-01', period_end: '2026-08-31' });
    const d = insertTxn(db, bankStmt, { date: '2026-08-05', description: 'CC PAYMENT XX1234', amount: 20000, direction: 'debit', kind: 'cc_payment' });
    const c = insertTxn(db, cardStmt, { date: '2026-08-06', description: 'PAYMENT RECEIVED', amount: 20000, direction: 'credit', kind: 'cc_payment', matched_txn_id: d });
    db.prepare('UPDATE transactions SET matched_txn_id = ? WHERE id = ?').run(c, d);
    insertTxn(db, bankStmt, { date: '2026-08-07', description: 'SWIGGY', amount: 450, direction: 'debit', kind: 'expense', category: 'Food & Dining' });
    db.prepare("INSERT INTO merchant_rules (merchant_key, kind, category) VALUES ('SWIGGY', 'expense', 'Food & Dining')").run();
  }

  test('exports the expense tables', async () => {
    seed(testDb);
    const res = await request(app).get('/api/export');
    expect(res.body.schema_version).toBe(3);
    expect(res.body.data.expense_statements).toHaveLength(2);
    expect(res.body.data.transactions).toHaveLength(3);
    expect(res.body.data.merchant_rules).toHaveLength(1);
  });

  test('round-trips into an empty database with IDs remapped and pairs kept', async () => {
    seed(testDb);
    // Shift IDs in the target DB so a missing remap would be caught.
    const target = dbModule.createDatabase(':memory:');
    target.prepare("INSERT INTO accounts (name, type, balance) VALUES ('Other', 'savings', 0)").run();
    target.prepare("INSERT INTO liabilities (name, type, current_balance) VALUES ('Other Loan', 'auto', 0)").run();
    const payload = (await request(app).get('/api/export')).body;

    dbModule.getDb.mockReturnValue(target);
    const res = await request(app).post('/api/export/import').send(payload);
    expect(res.status).toBe(200);
    expect(res.body.stats).toMatchObject({
      expense_statements: { imported: 2, skipped: 0 },
      transactions: { imported: 3, skipped: 0 },
      merchant_rules: { imported: 1, skipped: 0 },
    });
    const rows = target.prepare(
      `SELECT t.kind, t.matched_txn_id, t.source_id, COALESCE(a.name, l.name) AS source
         FROM transactions t
         LEFT JOIN accounts a ON t.source_type = 'account' AND a.id = t.source_id
         LEFT JOIN liabilities l ON t.source_type = 'liability' AND l.id = t.source_id`
    ).all();
    expect(rows.map((r) => r.source).sort()).toEqual(['HDFC Savings', 'HDFC Savings', 'Regalia']);
    const pays = rows.filter((r) => r.kind === 'cc_payment');
    expect(pays.every((r) => r.matched_txn_id)).toBe(true);
    target.close();
  });

  test('importing the same export twice does not duplicate anything', async () => {
    seed(testDb);
    const payload = (await request(app).get('/api/export')).body;
    const res = await request(app).post('/api/export/import').send(payload);
    expect(res.body.stats).toMatchObject({
      expense_statements: { imported: 0, skipped: 2 },
      transactions: { imported: 0, skipped: 3 },
      merchant_rules: { imported: 0, skipped: 1 },
    });
    expect(testDb.prepare('SELECT COUNT(*) AS n FROM transactions').get().n).toBe(3);
  });
});

// ─── Final review fixes ──────────────────────────────────────────────────────

describe('Final review fixes', () => {
  const clf = require('../src/utils/transactionClassifier');
  const tp = require('../src/utils/transactionParser');
  const { runMatcher } = require('../src/utils/transactionMatcher');
  const count = (table) => testDb.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;

  // #1 Merchant rules and totals must respect direction.
  test('a learned expense rule does not turn a refund from the same merchant into spending', () => {
    const desc = 'AMAZON PAY INDIA PVT LTD BANGALORE';
    const rules = new Map([[clf.merchantKey(desc), { kind: 'expense', category: 'Groceries' }]]);
    const [buy, back] = clf.applyPostProcessing([
      { date: '2026-08-05', description: desc, amount: 3000, direction: 'debit', kind: 'expense', category: 'Shopping', confidence: 0.9 },
      { date: '2026-08-09', description: desc, amount: 3000, direction: 'credit', kind: 'refund', category: 'Shopping', confidence: 0.9 },
    ], { statementType: 'credit_card', rules });
    expect(buy).toMatchObject({ kind: 'expense', category: 'Groceries', needs_review: false });
    expect(back.kind).toBe('refund');
  });

  test('an income rule learned from a credit does not turn a payment out into income', () => {
    const desc = 'UPI/123/RAMESH KUMAR/ramesh@okaxis/aug';
    const rules = new Map([[clf.merchantKey(desc), { kind: 'income', category: null }]]);
    const [t] = clf.applyPostProcessing([
      { date: '2026-08-05', description: desc, amount: 4000, direction: 'debit', kind: 'expense', category: 'Other', confidence: 0.4 },
    ], { statementType: 'bank', rules });
    expect(t).toMatchObject({ kind: 'expense', needs_review: true });
  });

  test('summary nets rows whose direction runs against their kind', async () => {
    const acct = Number(testDb.prepare("INSERT INTO accounts (name, type, balance) VALUES ('A', 'savings', 0)").run().lastInsertRowid);
    const s = insertStatement(testDb, { source_type: 'account', source_id: acct });
    insertTxn(testDb, s, { date: '2026-08-02', amount: 3000, direction: 'debit', kind: 'expense', category: 'Groceries' });
    insertTxn(testDb, s, { date: '2026-08-03', amount: 3000, direction: 'credit', kind: 'expense', category: 'Groceries' });
    insertTxn(testDb, s, { date: '2026-08-04', amount: 10000, direction: 'credit', kind: 'income' });
    insertTxn(testDb, s, { date: '2026-08-05', amount: 4000, direction: 'debit', kind: 'income' });
    const res = await request(app).get('/api/expenses/summary?month=2026-08');
    expect(res.body).toMatchObject({ income: 6000, spending: 0 });
    expect(res.body.by_category).toEqual([]);
  });

  // #2 Negative balances keep their sign.
  test('overdrawn running balances keep their sign when inferring direction', () => {
    const text = [
      'Opening Balance : 1,000.00',
      '01/08/2026 SALARY ACME 500.00 1,500.00',
      '03/08/2026 RENT PAYMENT 2,000.00 500.00 Dr',
      '05/08/2026 UPI/ZOMATO 300.00 800.00 Dr',
    ].join('\n');
    const h = tp.detectStatementHeader(text, 'bank');
    expect(tp.parsePageWithPattern(text, 'bank', { prevBalance: h.opening_balance }).map((t) => t.direction))
      .toEqual(['credit', 'debit', 'debit']);
  });

  test('header balances keep Dr/Cr signs', () => {
    expect(tp.detectStatementHeader('Opening Balance : 1,000.00\nClosing Balance : 800.00 Dr', 'bank'))
      .toMatchObject({ opening_balance: 1000, closing_balance: -800 });
    expect(tp.detectStatementHeader('Previous Balance 200.00\nTotal Amount Due 1,500.00 Cr', 'credit_card'))
      .toMatchObject({ opening_balance: 200, closing_balance: -1500 });
  });

  test('negative CSV balances keep their sign', async () => {
    const csv = 'Date,Narration,Withdrawal Amt.,Deposit Amt.,Closing Balance\n01/08/2026,RENT,1500.00,,-500.00\n03/08/2026,ZOMATO,300.00,,-800.00';
    const r = await tp.parseTransactionsFromCsv(Buffer.from(csv), { statementType: 'bank' });
    expect(r.statement).toMatchObject({ opening_balance: 1000, closing_balance: -800 });
  });

  test('a card in credit is written as nothing owed, not as a debt', async () => {
    const card = (await request(app).post('/api/liabilities').send({ name: 'Card', type: 'credit_card', current_balance: 0 })).body.id;
    const res = await request(app).post('/api/expenses/commit').send({
      source_type: 'liability', source_id: card, update_balance: true,
      statement: { closing_balance: -1500, period_end: '2026-08-31' },
      transactions: [{ date: '2026-08-06', description: 'PAYMENT RECEIVED', amount: 5000, direction: 'credit', kind: 'cc_payment' }],
    });
    expect(res.status).toBe(201);
    expect(testDb.prepare('SELECT current_balance FROM liabilities WHERE id = ?').get(card).current_balance).toBe(0);
  });

  // #3 Committing only the new rows of a preview must not shift dedupe keys.
  test('committing only the new rows of a preview keeps a second identical transaction', async () => {
    const acct = (await request(app).post('/api/accounts').send({ name: 'S', type: 'savings', balance: 0 })).body.id;
    const one = 'Date,Narration,Withdrawal Amt.,Deposit Amt.\n05/08/2026,STARBUCKS,300.00,';
    const preview = async (csv) => (await request(app).post('/api/expenses/preview')
      .field('source_type', 'account').field('source_id', String(acct)).attach('file', Buffer.from(csv), 's.csv')).body;
    const commit = (p) => request(app).post('/api/expenses/commit').send({
      source_type: 'account', source_id: acct, statement: p.statement, transactions: p.transactions.filter((t) => !t.duplicate),
    });
    await commit(await preview(one));
    const p2 = await preview(`${one}\n05/08/2026,STARBUCKS,300.00,`);
    expect(p2.transactions.map((t) => t.duplicate)).toEqual([true, false]);
    expect((await commit(p2)).body.inserted).toBe(1);
    expect(count('transactions')).toBe(2);
  });

  // #4 Rows the transfer matcher re-kinds are flagged; closest date wins.
  test('a row the transfer matcher re-kinds is flagged for review', () => {
    const a = insertStatement(testDb, { source_type: 'account', source_id: 1, statement_type: 'bank' });
    const b = insertStatement(testDb, { source_type: 'account', source_id: 2, statement_type: 'bank' });
    insertTxn(testDb, a, { date: '2026-08-01', description: 'IMPS TO PRIYA SHARMA', amount: 50000, direction: 'debit', kind: 'transfer' });
    const salary = insertTxn(testDb, b, { date: '2026-08-02', description: 'NEFT ACME CORP SALARY', amount: 50000, direction: 'credit', kind: 'income' });
    runMatcher(testDb, { from: '2026-07-01', to: '2026-09-30' });
    expect(testDb.prepare('SELECT kind, needs_review FROM transactions WHERE id = ?').get(salary)).toEqual({ kind: 'transfer', needs_review: 1 });
  });

  test('transfer pairing prefers the closest date', () => {
    const a = insertStatement(testDb, { source_type: 'account', source_id: 1, statement_type: 'bank' });
    const b = insertStatement(testDb, { source_type: 'account', source_id: 2, statement_type: 'bank' });
    const d = insertTxn(testDb, a, { date: '2026-08-10', description: 'TRANSFER', amount: 3000, direction: 'debit', kind: 'transfer' });
    insertTxn(testDb, b, { date: '2026-08-07', description: 'IMPS FROM', amount: 3000, direction: 'credit', kind: 'income' });
    const near = insertTxn(testDb, b, { date: '2026-08-10', description: 'IMPS FROM', amount: 3000, direction: 'credit', kind: 'income' });
    runMatcher(testDb, { from: '2026-07-01', to: '2026-09-30' });
    expect(testDb.prepare('SELECT matched_txn_id FROM transactions WHERE id = ?').get(d).matched_txn_id).toBe(near);
  });

  // #5 Card rows: the last amount is the billed amount; no bank-style balance inference.
  test('card rows with two amounts use the last as the billed amount and are flagged', () => {
    const text = 'Previous Balance 500.00\n05/08/2026 AWS SERVICES USD 12.99 1,100.50\n06/08/2026 SWIGGY 200.00';
    const txns = tp.parsePageWithPattern(text, 'credit_card', { prevBalance: 500 });
    expect(txns[0]).toMatchObject({ amount: 1100.5, direction: 'debit' });
    expect(txns[0].confidence).toBeLessThan(0.7);
    expect(txns[1]).toMatchObject({ amount: 200, direction: 'debit' });
  });

  // #6 CSV shapes.
  test('signed single-amount bank CSVs: positive rows are credits when the column has negatives', async () => {
    const csv = 'Date,Description,Amount\n01/08/2026,NEFT ACME CORP SALARY,50000.00\n03/08/2026,SWIGGY,-450.00';
    const r = await tp.parseTransactionsFromCsv(Buffer.from(csv), { statementType: 'bank' });
    expect(r.transactions.map((t) => t.direction)).toEqual(['credit', 'debit']);
    expect(r.transactions[0].confidence).toBeGreaterThan(0.4);
  });

  test('dates with a time part are accepted', () => {
    expect(tp.parseTxnDate('05/08/2026 10:22:11')).toBe('2026-08-05');
    expect(tp.parseTxnDate('05-Aug-2026 10:22')).toBe('2026-08-05');
  });

  test('CSV rows that cannot be read are reported, not silently dropped', async () => {
    const csv = 'Date,Description,Amount\n01/08/2026,A,10.00\n,B,20.00\nbad,C,30.00';
    const r = await tp.parseTransactionsFromCsv(Buffer.from(csv), { statementType: 'bank' });
    expect(r.transactions).toHaveLength(1);
    expect(r.validation_notes).toEqual([expect.stringMatching(/^2 rows could not be read/)]);
  });
});
