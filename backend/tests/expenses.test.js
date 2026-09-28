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
