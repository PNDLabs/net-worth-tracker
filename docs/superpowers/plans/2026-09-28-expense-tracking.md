# Expense Tracking Module Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a web-only Expenses module that imports bank and credit card statements (PDF/CSV), classifies every transaction, never double-counts credit card bill payments or own-account transfers, and shows monthly income, spending, investments and savings rate.

**Architecture:** A new backend pipeline — `transactionParser.js` (AI 3-pass per PDF page with pattern fallback, mirroring `statementParser.js`; CSV via AI column mapping with alias fallback) → `transactionClassifier.js` (pure post-processing: merchant rules, hard exclusion rules, dedupe keys) → `routes/expenses.js` (preview → commit, with `transactionMatcher.js` pairing card payments and transfers on every commit). Four new SQLite tables (schema v9). A new React page with Overview / Transactions / Upload tabs, talking to the REST API only.

**Tech Stack:** Node 18+ / Express 4 / better-sqlite3 / multer / csv-parse / pdfjs-dist (backend, all already installed); React 19 + Vite + Recharts (frontend); Jest + Supertest (tests). **No new dependencies.**

**Spec:** `docs/superpowers/specs/2026-09-28-expense-tracking-design.md`

## Global Constraints

- No new npm dependencies in either package.
- AI configuration exactly as `statementParser.js`: key from `options.apiKey || AI_API_KEY || OPENAI_API_KEY`; `AI_API_URL` default `https://api.openai.com/v1`; `AI_MODEL` default `gpt-4o-mini`; `temperature: 0`.
- Numeric statement dates are **day-first** (`05/08/2026` = 5 Aug 2026). Never use `normalizeDate` from `statementParser.js` for transactions (it is month-first).
- Amounts are stored positive; `direction` is `'debit' | 'credit'`.
- `kind` ∈ `expense, refund, income, investment, cc_payment, transfer`. `cc_payment` and `transfer` are **never** counted in income, spending or invested totals.
- Matching tolerances: amount ±₹1; card payment ≤ 5 days; own transfer ≤ 3 days.
- `DB_SCHEMA_VERSION` = 9. App version = `1.10.0` (frontend `version.js`, both `package.json`, `backend/src/routes/exportRoutes.js`). `EXPORT_SCHEMA_VERSION` stays `3`.
- Web only: `frontend/src/hooks/localApi.js` expense methods reject with `Expenses is available in the web version`; the nav item is hidden when `Capacitor.isNativePlatform()`.
- Chart colors (validated with the dataviz validator): income `#2a78d6`, spending `#eb6834`, invested `#1baf7a`, savings rate `#4a3aa7`. Never a dual y-axis. A "Show as table" view is mandatory (invested color is < 3:1 contrast).
- Frontend lint baseline already has 35 errors in existing files: lint **only new/changed files**; they must be clean.
- Every commit message ends with a blank line and `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Work on branch `feature/expense-tracking`. Never stage `docker-compose.yml` (the user's uncommitted local change).
- Backend tests: `cd backend && npm test` (baseline 115 passing). Run a single file with `cd backend && npx jest tests/expenses.test.js` (use `NODE_OPTIONS=--experimental-vm-modules` as in `npm test`, required for pdfjs).

## Review Focus

1. **Commit bodies over 100 KB** (a busy month is 300+ rows) must be accepted, not rejected by the global `express.json()` limit — pinned in Task 8 (`accepts a commit larger than the global 100 KB JSON limit`).
2. **CSV exports sorted newest-first** must still yield the right opening/closing balance — pinned in Task 6 (`newest-first CSV still gets the right opening and closing balance`).
3. **Impossible dates** such as `31/02/2026` must be rejected rather than stored as `2026-02-31` — pinned in Task 4 (`parseTxnDate reads numeric dates day-first and rejects impossible dates`).
4. **Re-uploading a statement whose rows are all saved** must not leave an empty statement behind — pinned in Task 8 (`commit saves transactions, and a re-upload is all duplicates`).
5. **Net worth change with no snapshot inside the month** must be `null`, not a misleading 0 — pinned in Task 9 (`net worth change comes from snapshots inside the month, only for all members`).

---

## File Structure

| File | Responsibility |
|------|----------------|
| `backend/src/db/database.js` (modify) | Schema v9: `expense_statements`, `transactions`, `merchant_rules` |
| `backend/src/utils/familyMember.js` (create) | Shared `normalizeFamilyMember` |
| `backend/src/routes/networth.js` (modify) | Use the shared helper |
| `backend/src/utils/transactionClassifier.js` (create) | Pure: kinds, categories, keyword rules, merchant key, post-processing, dedupe keys, reconciliation |
| `backend/src/utils/transactionParser.js` (create) | Pattern parser, AI 3-pass per page, CSV parsing |
| `backend/src/utils/pdfExtractor.js` (modify) | Add `extractPdfPages` with `preserveLines` |
| `backend/src/utils/transactionMatcher.js` (create) | Pair card payments / transfers in the DB |
| `backend/src/routes/expenses.js` (create) | All `/api/expenses` endpoints |
| `backend/src/app.js` (modify) | Body parser order, limiters, router mount |
| `backend/src/routes/exportRoutes.js` (modify) | Export/import the new tables |
| `backend/tests/expenses.test.js` (create) | All module tests |
| `backend/tests/helpers/expenseFixtures.js` (create) | Statement fixtures, `makePdf`, `mockAi` |
| `frontend/src/hooks/api.js`, `localApi.js` (modify) | API client + Android stubs |
| `frontend/src/App.jsx` (modify) | Nav item + page |
| `frontend/src/pages/ExpensesPage.jsx` (create) | Tab shell |
| `frontend/src/components/expenses/constants.js` (create) | Kinds, colors, month helpers |
| `frontend/src/components/expenses/ExpenseUpload.jsx` (create) | Upload + review screen |
| `frontend/src/components/expenses/ExpenseOverview.jsx` (create) | KPIs + charts + table view |
| `frontend/src/components/expenses/ExpenseTransactions.jsx` (create) | Filterable list, inline edit, statements, rules |
| `frontend/src/index.css` (modify) | Tab, badge and row styles |
| `CHANGELOG.md`, `README.md`, `frontend/src/version.js`, both `package.json` (modify) | Release housekeeping |

---
### Task 1: Schema v9 and the expenses test harness

**Files:**
- Modify: `backend/src/db/database.js` (schema history comment, `DB_SCHEMA_VERSION`, `runMigrations` exec block)
- Create: `backend/tests/expenses.test.js`

**Interfaces:**
- Consumes: `createDatabase`, `getDb` from `backend/src/db/database.js`
- Produces: tables `expense_statements`, `transactions`, `merchant_rules` (columns exactly as below); test helpers in `backend/tests/expenses.test.js`:
  - `insertStatement(db, { source_type='account', source_id=1, statement_type='bank', last4=null, period_start=null, period_end=null }) → number` (statement id)
  - `insertTxn(db, statementId, { date, description='TEST', amount, direction, kind, category=null, matched_txn_id=null, kind_locked=0, needs_review=0 }) → number` (transaction id; unique `dedupe_key` auto-generated)

- [ ] **Step 0: Install dependencies (once per checkout)**

Run: `cd backend && npm install && cd ../frontend && npm install`
Expected: both complete; `cd backend && npm test` → `Tests: 115 passed`.

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/expenses.test.js`:

```js
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && NODE_OPTIONS=--experimental-vm-modules npx jest tests/expenses.test.js`
Expected: FAIL — `user_version` is 8 and `no such table: expense_statements`.

- [ ] **Step 3: Add the tables**

In `backend/src/db/database.js`, add to the history comment after the `8 –` line:

```js
 *   9 – expense module: expense_statements, transactions (with dedupe_key,
 *       kind, matched_txn_id pairing, kind_locked) and merchant_rules
```

Change `const DB_SCHEMA_VERSION = 8;` to `const DB_SCHEMA_VERSION = 9;`.

Inside the `db.exec(\`...\`)` template in `runMigrations`, immediately after the `idx_precious_metals_type` index statement, add:

```sql
    CREATE TABLE IF NOT EXISTS expense_statements (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      source_type     TEXT    NOT NULL,
      source_id       INTEGER NOT NULL,
      statement_type  TEXT    NOT NULL,
      file_name       TEXT,
      last4           TEXT,
      period_start    TEXT,
      period_end      TEXT,
      opening_balance REAL,
      closing_balance REAL,
      parse_method    TEXT,
      created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS transactions (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      statement_id   INTEGER NOT NULL REFERENCES expense_statements(id) ON DELETE CASCADE,
      source_type    TEXT    NOT NULL,
      source_id      INTEGER NOT NULL,
      txn_date       TEXT    NOT NULL,
      description    TEXT    NOT NULL,
      merchant       TEXT,
      merchant_key   TEXT,
      amount         REAL    NOT NULL,
      direction      TEXT    NOT NULL,
      kind           TEXT    NOT NULL,
      category       TEXT,
      matched_txn_id INTEGER REFERENCES transactions(id) ON DELETE SET NULL,
      needs_review   INTEGER NOT NULL DEFAULT 0,
      kind_locked    INTEGER NOT NULL DEFAULT 0,
      dedupe_key     TEXT    NOT NULL UNIQUE,
      created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at     TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_transactions_date     ON transactions(txn_date);
    CREATE INDEX IF NOT EXISTS idx_transactions_source   ON transactions(source_type, source_id, txn_date);
    CREATE INDEX IF NOT EXISTS idx_transactions_merchant ON transactions(merchant_key);

    CREATE TABLE IF NOT EXISTS merchant_rules (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      merchant_key TEXT    NOT NULL UNIQUE,
      kind         TEXT    NOT NULL,
      category     TEXT,
      created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at   TEXT    NOT NULL DEFAULT (datetime('now'))
    );
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend && NODE_OPTIONS=--experimental-vm-modules npx jest tests/expenses.test.js`
Expected: PASS (3 tests). Then `cd backend && npm test` → all suites pass.

- [ ] **Step 5: Commit**

```bash
git add backend/src/db/database.js backend/tests/expenses.test.js
git commit -m "Add expense tables (DB schema v9)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Shared family-member normaliser

**Files:**
- Create: `backend/src/utils/familyMember.js`
- Modify: `backend/src/routes/networth.js:6-21` (remove local `DEFAULT_FAMILY_MEMBER` and `normalizedMemberName`)
- Test: `backend/tests/expenses.test.js`

**Interfaces:**
- Produces: `normalizeFamilyMember(value: any) → string` and `DEFAULT_FAMILY_MEMBER = 'Self'` from `backend/src/utils/familyMember.js`. Semantics identical to the existing copies: non-string/blank/"self"/"you" → `'Self'`; otherwise collapse whitespace and Title Case each word.

- [ ] **Step 1: Write the failing test**

Append to `backend/tests/expenses.test.js`:

```js
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
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd backend && NODE_OPTIONS=--experimental-vm-modules npx jest tests/expenses.test.js -t normalizeFamilyMember`
Expected: FAIL — `Cannot find module '../src/utils/familyMember'`.

- [ ] **Step 3: Implement**

Create `backend/src/utils/familyMember.js`:

```js
/**
 * familyMember.js – shared family-member name normalisation.
 * "  jane   DOE " → "Jane Doe"; blank, "self" or "you" → "Self".
 */
const DEFAULT_FAMILY_MEMBER = 'Self';

function normalizeFamilyMember(value) {
  if (typeof value !== 'string') return DEFAULT_FAMILY_MEMBER;
  const normalized = value.trim().replace(/\s+/g, ' ');
  if (!normalized) return DEFAULT_FAMILY_MEMBER;
  const lower = normalized.toLowerCase();
  if (lower === 'self' || lower === 'you') return DEFAULT_FAMILY_MEMBER;
  return normalized
    .split(' ')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}

module.exports = { DEFAULT_FAMILY_MEMBER, normalizeFamilyMember };
```

In `backend/src/routes/networth.js`, delete the lines `const DEFAULT_FAMILY_MEMBER = 'Self';` and the whole `function normalizedMemberName(name) { ... }`, and add after `const db = require('../db/database');`:

```js
const { DEFAULT_FAMILY_MEMBER, normalizeFamilyMember: normalizedMemberName } = require('../utils/familyMember');
```

- [ ] **Step 4: Run tests**

Run: `cd backend && npm test`
Expected: all pass, including the existing `Net Worth API` family tests.

- [ ] **Step 5: Commit**

```bash
git add backend/src/utils/familyMember.js backend/src/routes/networth.js backend/tests/expenses.test.js
git commit -m "Extract shared family member normaliser

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Transaction classifier (pure post-processing)

**Files:**
- Create: `backend/src/utils/transactionClassifier.js`
- Test: `backend/tests/expenses.test.js`

**Interfaces:**
- Produces (all exported from `backend/src/utils/transactionClassifier.js`):
  - `KINDS: string[]`, `EXCLUDED_KINDS: ['cc_payment','transfer']`, `DEFAULT_CATEGORIES: string[]`
  - `merchantKey(description: string) → string`
  - `mentionsLast4(description: string, last4: string) → boolean`
  - `keywordClassify(description, direction: 'debit'|'credit', statementType: 'bank'|'credit_card') → { kind, category, confidence }`
  - `applyPostProcessing(txns, { statementType, rules?: Map<merchant_key,{kind,category}>, knownCardLast4?: string[], otherBankLast4?: string[] }) → txns` each gaining `merchant_key`, final `kind`, `category`, `confidence`, `needs_review: boolean`. Input txn shape: `{ date, description, merchant, amount, direction, kind, category, confidence }`.
  - `computeDedupeKeys(txns, sourceType, sourceId) → txns` each gaining `dedupe_key` (uses `t.date`, `t.amount`, `t.direction`, `t.merchant_key` or `merchantKey(t.description)`)
  - `reconciliationNote(statement, txns, statementType) → string | null`

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/expenses.test.js`:

```js
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
```

- [ ] **Step 2: Run to verify failure**

Run: `cd backend && NODE_OPTIONS=--experimental-vm-modules npx jest tests/expenses.test.js -t transactionClassifier`
Expected: FAIL — `Cannot find module '../src/utils/transactionClassifier'`.

- [ ] **Step 3: Implement**

Create `backend/src/utils/transactionClassifier.js`:

```js
/**
 * transactionClassifier.js – pure classification helpers for the expense module.
 *
 * No DB access: callers pass learned merchant rules and known last-4 digits in.
 * The same post-processing runs on AI and pattern-parser output so that
 * double-count protection never depends on the AI getting it right.
 */
const crypto = require('crypto');

const KINDS = ['expense', 'refund', 'income', 'investment', 'cc_payment', 'transfer'];
// Kinds that never count toward income, spending or investment totals.
const EXCLUDED_KINDS = ['cc_payment', 'transfer'];
const DEFAULT_CATEGORIES = [
  'Food & Dining', 'Groceries', 'Shopping', 'Transport', 'Fuel', 'Utilities & Bills', 'Rent',
  'EMI & Loans', 'Health', 'Travel', 'Entertainment', 'Education', 'Personal Care',
  'Fees & Charges', 'Other',
];

// Bank-statement debit that pays a credit card bill.
const CC_PAYMENT_BANK_RE = /CC\s*PAYMENT|CREDIT\s*CARD|CARD\s*PAYMENT|AUTOPAY.*\bCC\b|BILLDESK.*\bCC\b|CRED\s*CLUB|CREDCLUB/i;
// Card-statement credit that is the bill payment arriving.
const CC_PAYMENT_CARD_RE = /PAYMENT\s*RECEIVED|THANK\s*YOU|\bBBPS\b|PAYMENT\s*-\s/i;

// Ordered keyword table – first match wins: [regex, kind, category, direction or null for either].
const KEYWORD_RULES = [
  [/\bSALARY\b|\bSAL\b.*\bCR|PAYROLL/i, 'income', null, 'credit'],
  [/INTEREST\s*(CREDIT|PAID|CR)|\bINT\.?\s*PD\b|\bINT\s*CR\b/i, 'income', null, 'credit'],
  [/\bDIVIDEND\b/i, 'income', null, 'credit'],
  [/\bSIP\b|MUTUAL\s*FUND|\bMF\b|ZERODHA|GROWW|KUVERA|UPSTOX|ANGEL\s*ONE|\bNPS\b|\bPPF\b|INDIAN\s*CLEARING|\bICCL\b|NSE\s*CLEARING|\bCAMS\b|KFIN/i, 'investment', null, 'debit'],
  [/\bEMI\b|LOAN\s*(REPAY|EMI|INST)/i, 'expense', 'EMI & Loans', 'debit'],
  [/SWIGGY|ZOMATO|DOMINOS|MCDONALD|STARBUCKS|RESTAURANT|\bCAFE\b|\bKFC\b/i, 'expense', 'Food & Dining', null],
  [/BIGBASKET|BLINKIT|ZEPTO|DMART|D-MART|INSTAMART|RELIANCE\s*FRESH|SUPERMARKET/i, 'expense', 'Groceries', null],
  [/AMAZON|FLIPKART|MYNTRA|AJIO|NYKAA|MEESHO|TATA\s*CLIQ/i, 'expense', 'Shopping', null],
  [/\bUBER\b|\bOLA\b|RAPIDO|IRCTC|\bMETRO\b|FASTAG|REDBUS/i, 'expense', 'Transport', null],
  [/PETROL|\bFUEL\b|\bHPCL\b|\bBPCL\b|INDIAN\s*OIL|\bIOCL\b/i, 'expense', 'Fuel', null],
  [/ELECTRICITY|BESCOM|MSEDCL|TATA\s*POWER|ADANI\s*ELEC|\bAIRTEL\b|\bJIO\b|VODAFONE|\bBSNL\b|BROADBAND|WATER\s*BILL|\bDTH\b|TATA\s*PLAY/i, 'expense', 'Utilities & Bills', null],
  [/\bRENT\b|NOBROKER/i, 'expense', 'Rent', null],
  [/HOSPITAL|PHARM|APOLLO|MEDPLUS|\b1MG\b|PRACTO|CLINIC|DIAGNOSTIC|NETMEDS/i, 'expense', 'Health', null],
  [/MAKEMYTRIP|GOIBIBO|CLEARTRIP|INDIGO|AIR\s*INDIA|AKASA|SPICEJET|\bOYO\b|AIRBNB|HOTEL|YATRA/i, 'expense', 'Travel', null],
  [/NETFLIX|HOTSTAR|SPOTIFY|PRIME\s*VIDEO|BOOKMYSHOW|\bPVR\b|\bINOX\b|YOUTUBE/i, 'expense', 'Entertainment', null],
  [/\bSCHOOL\b|COLLEGE|UNIVERSITY|TUITION|COURSERA|UDEMY/i, 'expense', 'Education', null],
  [/SALON|\bSPA\b|URBAN\s*COMPANY|\bGYM\b|CULT\.?FIT/i, 'expense', 'Personal Care', null],
  [/\bCHARGES?\b|\bFEE\b|\bGST\b|ANNUAL\s*FEE|LATE\s*PAYMENT|FINANCE\s*CHARGE/i, 'expense', 'Fees & Charges', 'debit'],
];

/**
 * Normalise a narration to a stable merchant key: reference numbers, UPI/NEFT/POS
 * prefixes, VPA handles and digits removed.
 */
function merchantKey(description) {
  return String(description || '')
    .toUpperCase()
    .replace(/@[A-Z0-9.-]+/g, ' ')
    .replace(/\b(UPI|POS|NEFT|IMPS|RTGS|ACH|NACH|ECS|MB|IB|TPT|INF|INFT|BIL|ONL)\b/g, ' ')
    .replace(/[0-9]+/g, ' ')
    .replace(/[^A-Z&]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** True when the narration references a masked account/card ending in `last4`. */
function mentionsLast4(description, last4) {
  if (!last4 || !/^\d{4}$/.test(String(last4))) return false;
  const re = new RegExp(`(?:[X*]{2,}[\\s-]?|(?:A\\/?C|ACCT?|CARD)\\D{0,12})${last4}(?!\\d)`, 'i');
  return re.test(String(description || ''));
}

/** Keyword fallback used when AI is unavailable or returned no usable kind. */
function keywordClassify(description, direction, statementType) {
  const desc = String(description || '');
  for (const [re, kind, category, dir] of KEYWORD_RULES) {
    if (dir && dir !== direction) continue;
    if (!re.test(desc)) continue;
    // A credit from a shop is money coming back from that merchant.
    if (kind === 'expense' && direction === 'credit') return { kind: 'refund', category, confidence: 0.8 };
    return { kind, category, confidence: 0.8 };
  }
  if (direction === 'credit') {
    return statementType === 'credit_card'
      ? { kind: 'refund', category: null, confidence: 0.6 }
      : { kind: 'income', category: null, confidence: 0.5 };
  }
  return { kind: 'expense', category: 'Other', confidence: 0.5 };
}

/**
 * Resolve final kind/category/needs_review for parsed transactions.
 * Order: parser (or keyword fallback) → learned merchant rule → hard exclusion rules.
 *
 * @param {Array<{date,description,merchant,amount,direction,kind,category,confidence}>} txns
 * @param {{statementType: 'bank'|'credit_card', rules?: Map<string,{kind,category}>,
 *          knownCardLast4?: string[], otherBankLast4?: string[]}} ctx
 */
function applyPostProcessing(txns, ctx) {
  const { statementType, rules = new Map(), knownCardLast4 = [], otherBankLast4 = [] } = ctx;
  return txns.map((t) => {
    const key = merchantKey(t.description);
    let kind = KINDS.includes(t.kind) ? t.kind : null;
    let category = t.category || null;
    let confidence = typeof t.confidence === 'number' ? t.confidence : null;
    if (!kind) {
      ({ kind, category, confidence } = keywordClassify(t.description, t.direction, statementType));
    }

    const rule = key ? rules.get(key) : null;
    if (rule) ({ kind, category } = rule);

    // Hard exclusion rules: double counting must never depend on the AI or on a learned rule.
    let hard = null;
    if (statementType === 'bank' && t.direction === 'debit' &&
        (CC_PAYMENT_BANK_RE.test(t.description) || knownCardLast4.some((l4) => mentionsLast4(t.description, l4)))) {
      hard = 'cc_payment';
    } else if (statementType === 'credit_card' && t.direction === 'credit') {
      if (CC_PAYMENT_CARD_RE.test(t.description)) hard = 'cc_payment';
      else if (!rule) hard = 'refund';
    } else if (otherBankLast4.some((l4) => mentionsLast4(t.description, l4))) {
      hard = 'transfer';
    }
    if (hard) {
      kind = hard;
      if (hard !== 'refund') category = null;
    }
    if (EXCLUDED_KINDS.includes(kind)) category = null;

    const personalUpi = kind === 'expense' && /\bUPI\b/i.test(t.description) &&
      !KEYWORD_RULES.some(([re]) => re.test(t.description));
    const needs_review = !rule && !hard && (
      (confidence != null && confidence < 0.7) ||
      (kind === 'expense' && (!category || category === 'Other')) ||
      personalUpi
    );
    return { ...t, merchant: t.merchant || null, merchant_key: key, kind, category, confidence, needs_review };
  });
}

/**
 * Attach a dedupe_key to each transaction. Identical rows within one statement get an
 * occurrence index so two genuine ₹100 coffees on the same day both survive.
 */
function computeDedupeKeys(txns, sourceType, sourceId) {
  const seen = new Map();
  return txns.map((t) => {
    const base = [sourceType, sourceId, t.date, Number(t.amount).toFixed(2), t.direction,
      t.merchant_key != null ? t.merchant_key : merchantKey(t.description)].join('|');
    const n = seen.get(base) || 0;
    seen.set(base, n + 1);
    return { ...t, dedupe_key: crypto.createHash('sha1').update(`${base}|${n}`).digest('hex') };
  });
}

/** Returns a warning string when opening ± transactions ≠ closing (±1), else null. */
function reconciliationNote(statement, txns, statementType) {
  const open = statement ? statement.opening_balance : null;
  const close = statement ? statement.closing_balance : null;
  if (open == null || close == null) return null;
  const total = (dir) => txns.filter((t) => t.direction === dir).reduce((s, t) => s + Number(t.amount), 0);
  const credits = total('credit');
  const debits = total('debit');
  const expected = statementType === 'credit_card' ? open + debits - credits : open + credits - debits;
  if (Math.abs(expected - close) <= 1) return null;
  const formula = statementType === 'credit_card' ? 'previous balance + purchases − payments/refunds' : 'opening balance + credits − debits';
  return `Totals do not reconcile: ${formula} = ${expected.toFixed(2)}, but the statement shows ${close.toFixed(2)}. ` +
    'An amount may have been misread or a transaction missed — compare with the statement before saving.';
}

module.exports = {
  KINDS, EXCLUDED_KINDS, DEFAULT_CATEGORIES,
  merchantKey, mentionsLast4, keywordClassify, applyPostProcessing, computeDedupeKeys, reconciliationNote,
};
```

- [ ] **Step 4: Run to verify pass**

Run: `cd backend && NODE_OPTIONS=--experimental-vm-modules npx jest tests/expenses.test.js -t transactionClassifier`
Expected: PASS (13 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/src/utils/transactionClassifier.js backend/tests/expenses.test.js
git commit -m "Add transaction classifier with double-count exclusion rules

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 4: Pattern parser (dates, amounts, header, PDF page rows)

**Files:**
- Create: `backend/src/utils/transactionParser.js`
- Create: `backend/tests/helpers/expenseFixtures.js`
- Test: `backend/tests/expenses.test.js`

**Interfaces:**
- Consumes: `keywordClassify` from `transactionClassifier.js` (Task 3)
- Produces (from `backend/src/utils/transactionParser.js`):
  - `parseTxnDate(value) → 'YYYY-MM-DD' | null` (day-first; impossible dates → null)
  - `parseAmount(value) → positive number | null`
  - `detectStatementHeader(text) → { last4, period_start, period_end, opening_balance, closing_balance }` (each may be null)
  - `parsePageWithPattern(pageText, statementType, state = {}) → Array<{ date, description, merchant: null, amount, direction, kind, category, confidence }>`; `state.prevBalance` carries the running balance across pages
- Produces (from `backend/tests/helpers/expenseFixtures.js`): `BANK_LINES`, `CARD_LINES`, `BANK_TEXT`, `CARD_TEXT`, `BANK_CSV`, `CARD_CSV`, `makePdf(lines) → Buffer`

- [ ] **Step 1: Create the fixtures**

Create `backend/tests/helpers/expenseFixtures.js` (not a `.test.js` file, so Jest does not run it):

```js
/**
 * Shared fixtures for expense module tests: a bank and a credit card statement that
 * reconcile, CSV exports of them, and a tiny PDF builder.
 */

const BANK_LINES = [
  'HDFC BANK Statement of account',
  'Account No : XXXXXXXX4821',
  'Statement From : 01/08/2026 To : 31/08/2026',
  'Opening Balance : 50,000.00',
  'Date Narration Chq/Ref No Value Dt Withdrawal Amt Deposit Amt Closing Balance',
  '01/08/26 SALARY AUG ACME CORP 01/08/26 1,00,000.00 1,50,000.00',
  '03/08/26 UPI/412345678901/SWIGGY/swiggy@icici/Payment 03/08/26 450.00 1,49,550.00',
  '05/08/26 CC PAYMENT XX1234 BILLDESK 05/08/26 20,000.00 1,29,550.00',
  '10/08/26 NACH/ZERODHA BROKING SIP 10/08/26 5,000.00 1,24,550.00',
  'Closing Balance : 1,24,550.00',
];

// Previous 20,000 + purchases 13,300 − payment 20,000 − refund 1,000 = due 12,300.
const CARD_LINES = [
  'HDFC Bank Credit Card Statement',
  'Card No: 4893 XXXX XXXX 1234',
  'Statement Period: 01/08/2026 to 31/08/2026',
  'Previous Balance 20,000.00',
  'Total Amount Due 12,300.00',
  'Date Transaction Description Amount',
  '02/08/2026 SWIGGY BANGALORE 800.00',
  '04/08/2026 AMAZON PAY INDIA 3,500.00',
  '06/08/2026 PAYMENT RECEIVED - THANK YOU 20,000.00 Cr',
  '12/08/2026 AMAZON REFUND 1,000.00 Cr',
  '20/08/2026 UBER INDIA 9,000.00',
];

const BANK_CSV_ROWS = [
  '01/08/26,SALARY AUG ACME CORP,0001,01/08/26,,"1,00,000.00","1,50,000.00"',
  '03/08/26,UPI/412345678901/SWIGGY/swiggy@icici/Payment,0002,03/08/26,450.00,,"1,49,550.00"',
  '05/08/26,CC PAYMENT XX1234 BILLDESK,0003,05/08/26,"20,000.00",,"1,29,550.00"',
  '10/08/26,NACH/ZERODHA BROKING SIP,0004,10/08/26,"5,000.00",,"1,24,550.00"',
];
const BANK_CSV_HEADER = [
  'HDFC BANK LTD',
  'Account Number: XXXXXXXX4821',
  '',
  'Date,Narration,Chq./Ref.No.,Value Dt,Withdrawal Amt.,Deposit Amt.,Closing Balance',
];
const BANK_CSV = [...BANK_CSV_HEADER, ...BANK_CSV_ROWS].join('\n');

const CARD_CSV = [
  'Transaction Date,Details,Amount,Debit/Credit',
  '02/08/2026,SWIGGY BANGALORE,800.00,Debit',
  '06/08/2026,PAYMENT RECEIVED - THANK YOU,"20,000.00",Credit',
].join('\n');

/** Build a one-page PDF with one text line per entry (Helvetica, no parentheses in lines). */
function makePdf(lines) {
  const content = ['BT', '/F1 10 Tf', '40 760 Td',
    ...lines.flatMap((l, i) => [...(i ? ['0 -14 Td'] : []), `(${l}) Tj`]), 'ET'].join('\n');
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((o, i) => { offsets.push(pdf.length); pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` +
    offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

module.exports = {
  BANK_LINES, CARD_LINES,
  BANK_TEXT: BANK_LINES.join('\n'),
  CARD_TEXT: CARD_LINES.join('\n'),
  BANK_CSV, BANK_CSV_HEADER, BANK_CSV_ROWS, CARD_CSV,
  makePdf,
};
```

- [ ] **Step 2: Write the failing tests**

Append to `backend/tests/expenses.test.js`:

```js
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
```

- [ ] **Step 3: Run to verify failure**

Run: `cd backend && NODE_OPTIONS=--experimental-vm-modules npx jest tests/expenses.test.js -t "pattern parsing"`
Expected: FAIL — `Cannot find module '../src/utils/transactionParser'`.

- [ ] **Step 4: Implement**

Create `backend/src/utils/transactionParser.js`:

```js
/**
 * transactionParser.js – turns bank / credit card statements into transactions.
 *
 * Mirrors statementParser.js:
 *   PDF: per page, AI Pass 1 (extract + classify) → Pass 2 (validate against the page
 *        text) → Pass 3 (accuracy review, only when Pass 2 made corrections); a page
 *        falls back to the pattern parser when AI is unavailable or fails.
 *   CSV: AI column mapper → header-alias fallback; descriptions classified by one AI
 *        call per 100 rows → keyword fallback.
 *
 * Pages are processed separately because a month of transactions does not fit in a
 * single AI response.
 *
 * AI configuration (same as statementParser.js):
 *   AI_API_KEY (or OPENAI_API_KEY), AI_API_URL (default https://api.openai.com/v1),
 *   AI_MODEL (default gpt-4o-mini)
 */
const { keywordClassify } = require('./transactionClassifier');

// ─── Pattern parsing ──────────────────────────────────────────────────────────

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
// Date shapes found on Indian statements: 05/08/2026, 05-08-26, 05.08.2026, 05-Aug-2026, 05 Aug 26, 2026-08-05.
const DATE_TOKEN = String.raw`\d{4}-\d{2}-\d{2}|\d{1,2}[-/.](?:\d{1,2}|[A-Za-z]{3})[-/.]\d{2,4}|\d{1,2}\s[A-Za-z]{3}\s\d{2,4}`;
// Money always carries two decimals on statements; optional Dr/Cr marker follows.
const AMOUNT_RE = /(?<![\d,.])(?:₹|Rs\.?|INR)?\s?(\d{1,3}(?:,\d{2,3})+\.\d{2}|\d+\.\d{2})(?![\d])(?:\s?(Cr|Dr|CR|DR)\b)?/g;
const SKIP_ROW_RE = /opening balance|closing balance|previous balance|brought forward|carried forward|total amount due|minimum amount due|statement period|total dues/i;
const ROW_END_RE = /closing balance\s*[:-]|statement summary|\bpage\s+\d+\s+of\b/i;

const toYear = (y) => (y.length === 2 ? 2000 + Number(y) : Number(y));
function isoDate(y, mo, d) {
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return dt.toISOString().slice(0, 10);
}

/** Parse a statement date. Numeric dates are day-first (Indian convention): 05/08/2026 = 5 Aug. */
function parseTxnDate(value) {
  if (value == null) return null;
  const s = String(value).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return isoDate(Number(m[1]), Number(m[2]), Number(m[3]));
  m = s.match(/^(\d{1,2})[-\s/.]([A-Za-z]{3})[A-Za-z]*[-\s/.,]+(\d{2,4})$/);
  if (m) return MONTHS[m[2].toLowerCase()] ? isoDate(toYear(m[3]), MONTHS[m[2].toLowerCase()], Number(m[1])) : null;
  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/);
  if (m) return isoDate(toYear(m[3]), Number(m[2]), Number(m[1]));
  return null;
}

/** Parse a money string ("₹1,00,000.50 Cr", "-450.00", 450) to a positive number, or null. */
function parseAmount(value) {
  if (value == null) return null;
  if (typeof value === 'number') return Number.isFinite(value) && value !== 0 ? Math.abs(value) : null;
  const cleaned = String(value).replace(/₹|rs\.?|inr|\s|,/gi, '').replace(/(dr|cr)$/i, '');
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) && n !== 0 ? Math.abs(n) : null;
}

/** Regex detection of statement header fields (last4, period, opening/closing balance). */
function detectStatementHeader(text) {
  const t = String(text || '');
  const AMT = String.raw`(?:₹|Rs\.?|INR)?\s*([\d,]+\.\d{2})`;
  const amountAfter = (labels) => {
    const m = t.match(new RegExp(`(?:${labels})\\s*:?\\s*${AMT}`, 'i'));
    return m ? parseAmount(m[1]) : null;
  };
  const last4 = (t.match(/(?:X{2,}|x{2,}|\*{2,})[\s-]?(\d{4})(?!\d)/) || [])[1] || null;
  const period = t.match(new RegExp(`(?:statement\\s*period|period|from)\\s*:?\\s*(${DATE_TOKEN})\\s*(?:to|-|–)\\s*:?\\s*(${DATE_TOKEN})`, 'i'));
  return {
    last4,
    period_start: period ? parseTxnDate(period[1]) : null,
    period_end: period ? parseTxnDate(period[2]) : null,
    opening_balance: amountAfter('opening balance|previous balance|previous statement balance'),
    closing_balance: amountAfter('closing balance|total amount due|total dues'),
  };
}

/**
 * Pattern parser for one page of statement text. A row starts at a date; later dates
 * seen before the row's first amount (value-date columns) stay in the same row.
 * `state.prevBalance` carries the running balance across pages to infer direction.
 */
function parsePageWithPattern(pageText, statementType, state = {}) {
  const text = String(pageText || '');
  const dateRe = new RegExp(`(?<![\\d/.-])(${DATE_TOKEN})(?![\\d/.-])`, 'g');
  const hasAmount = (s) => new RegExp(AMOUNT_RE.source).test(s);
  const rows = [];
  let m;
  while ((m = dateRe.exec(text))) {
    const cur = rows[rows.length - 1];
    if (cur && !hasAmount(text.slice(cur.end, m.index))) continue; // value date inside current row
    if (cur) cur.stop = m.index;
    rows.push({ end: m.index + m[0].length, date: m[1], stop: text.length });
  }

  const txns = [];
  for (const row of rows) {
    let body = text.slice(row.end, row.stop);
    const cut = body.search(ROW_END_RE);
    if (cut > 0) body = body.slice(0, cut);
    const amounts = [...body.matchAll(AMOUNT_RE)];
    const date = parseTxnDate(row.date);
    if (!amounts.length || !date) continue;
    const first = amounts[0];
    const amount = parseAmount(first[1]);
    const balance = amounts.length >= 2 ? parseAmount(amounts[amounts.length - 1][1]) : null;
    const description = body.slice(0, first.index).replace(new RegExp(DATE_TOKEN, 'g'), ' ').replace(/\s+/g, ' ').trim();
    if (!amount || !description || description.length > 200 || SKIP_ROW_RE.test(description)) {
      if (balance != null) state.prevBalance = balance;
      continue;
    }
    let direction;
    let certain = true;
    if (first[2]) direction = /cr/i.test(first[2]) ? 'credit' : 'debit';
    else if (balance != null && state.prevBalance != null) direction = balance > state.prevBalance ? 'credit' : 'debit';
    else if (statementType === 'credit_card') direction = /PAYMENT|REFUND|REVERSAL|CASHBACK|THANK YOU/i.test(description) ? 'credit' : 'debit';
    else { direction = 'debit'; certain = false; }
    if (balance != null) state.prevBalance = balance;

    const k = keywordClassify(description, direction, statementType);
    txns.push({
      date, description, merchant: null, amount, direction,
      kind: k.kind, category: k.category, confidence: certain ? k.confidence : Math.min(k.confidence, 0.4),
    });
  }
  return txns;
}

module.exports = {
  parseTxnDate, parseAmount, detectStatementHeader, parsePageWithPattern,
};
```

- [ ] **Step 5: Run to verify pass**

Run: `cd backend && NODE_OPTIONS=--experimental-vm-modules npx jest tests/expenses.test.js -t "pattern parsing"`
Expected: PASS (7 tests).

- [ ] **Step 6: Commit**

```bash
git add backend/src/utils/transactionParser.js backend/tests/helpers/expenseFixtures.js backend/tests/expenses.test.js
git commit -m "Add day-first pattern parser for statement transactions

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: PDF pages and the AI three-pass parser

**Files:**
- Modify: `backend/src/utils/pdfExtractor.js` (whole file body below `getPdfjs`)
- Modify: `backend/src/utils/transactionParser.js` (require line, new AI section, exports)
- Modify: `backend/tests/helpers/expenseFixtures.js` (add `mockAi`)
- Test: `backend/tests/expenses.test.js`

**Interfaces:**
- Consumes: Task 4 parser functions; `DEFAULT_CATEGORIES` from Task 3
- Produces:
  - `extractPdfPages(buffer, password, { preserveLines = false } = {}) → Promise<string[]>` from `pdfExtractor.js`; `extractPdfText` unchanged in behaviour
  - `PROMPTS` = `{ extract(statementType) → string, validate: string, review: string, csvMap: string, classify(statementType) → string }` from `transactionParser.js`
  - `parseTransactionsFromPages(pages: string[], { statementType, apiKey?, apiUrl?, model?, forcePattern? }) → Promise<{ statement: {last4, period_start, period_end, opening_balance, closing_balance}, transactions, method: 'ai'|'pattern', validation_notes: string[] }>`
  - `mockAi(handler) → calls[]` test helper: `handler(systemPrompt, userMessage)` returns the JSON object the AI "replies" with, or an `Error` to simulate an HTTP 500

- [ ] **Step 1: Add the AI mock helper**

In `backend/tests/helpers/expenseFixtures.js`, add above `module.exports`:

```js
/**
 * Replace global.fetch with a fake OpenAI-compatible endpoint.
 * handler(systemPrompt, userMessage) returns the object the model "answers", or an Error for a 500.
 * Returns the array of recorded calls ({ sys, user, body }).
 */
function mockAi(handler) {
  const calls = [];
  global.fetch = jest.fn(async (url, init) => {
    const body = JSON.parse(init.body);
    const sys = body.messages[0].content;
    const user = body.messages[1].content;
    calls.push({ sys, user, body });
    const out = handler(sys, user);
    if (out instanceof Error) return { ok: false, status: 500, text: async () => out.message };
    return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(out) } }] }) };
  });
  return calls;
}
```

and add `mockAi,` to the `module.exports` object.

- [ ] **Step 2: Write the failing tests**

Append to `backend/tests/expenses.test.js`:

```js
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
```

- [ ] **Step 3: Run to verify failure**

Run: `cd backend && NODE_OPTIONS=--experimental-vm-modules npx jest tests/expenses.test.js -t "pages|AI passes"`
Expected: FAIL — `extractPdfPages is not a function` / `tp.PROMPTS` undefined.

- [ ] **Step 4: Implement `extractPdfPages`**

In `backend/src/utils/pdfExtractor.js`, replace everything from the `/**` doc comment above `async function extractPdfText` to the end of the file with:

```js
/**
 * @param {Buffer} buffer      – raw PDF bytes
 * @param {string} [password]  – optional owner/user password
 * @param {{preserveLines?: boolean}} [options]
 *        preserveLines – end each text line with "\n" (pdf.js hasEOL) instead of joining
 *        every text item with a space. Transaction parsing needs the line structure.
 * @returns {Promise<string[]>} – text of each page
 */
async function extractPdfPages(buffer, password, { preserveLines = false } = {}) {
  const pdfjsLib = await getPdfjs();

  const loadingTask = pdfjsLib.getDocument({
    data: new Uint8Array(buffer),
    password: password || '',
    // Suppress missing-font warnings in Node environment
    verbosity: 0,
  });

  let pdf;
  try {
    pdf = await loadingTask.promise;
  } catch (err) {
    if (err.name === 'PasswordException') {
      const msg =
        err.code === 1
          ? 'This PDF is password-protected. Please provide the correct password.'
          : 'Incorrect password for this PDF.';
      const error = new Error(msg);
      error.code = 'PASSWORD_REQUIRED';
      throw error;
    }
    throw err;
  }

  const pageTexts = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const pageText = preserveLines
      ? content.items.map((item) => item.str + (item.hasEOL ? '\n' : ' ')).join('')
      : content.items.map((item) => item.str).join(' ');
    pageTexts.push(pageText);
  }
  return pageTexts;
}

/**
 * @param {Buffer} buffer      – raw PDF bytes
 * @param {string} [password]  – optional owner/user password
 * @returns {Promise<string>}  – concatenated text from all pages
 */
async function extractPdfText(buffer, password) {
  return (await extractPdfPages(buffer, password)).join('\n');
}

module.exports = { extractPdfText, extractPdfPages };
```

- [ ] **Step 5: Implement the AI section of `transactionParser.js`**

In `backend/src/utils/transactionParser.js`:

1. Change the require line `const { keywordClassify } = require('./transactionClassifier');` to:

```js
const { DEFAULT_CATEGORIES, keywordClassify } = require('./transactionClassifier');
```

2. Insert this block immediately above `module.exports`:

```js
// ─── AI parsing ───────────────────────────────────────────────────────────────

const STATEMENT_FIELDS = ['last4', 'period_start', 'period_end', 'opening_balance', 'closing_balance'];
const AI_MAX_TOKENS = 8192;
const CSV_CLASSIFY_BATCH = 100;

const KIND_RULES = `- kind:
  - income: salary, interest, dividends, refunds of tax, reimbursements received.
  - investment: SIP, mutual fund, stock broker (Zerodha, Groww, Upstox, Kuvera, Angel One), NPS, PPF, clearing corporation (ICCL, NSE Clearing) debits.
  - cc_payment: paying a credit card bill (bank debit such as "CC PAYMENT", "CREDIT CARD", "AUTOPAY", "CRED") or, on a card statement, the bill payment received.
  - transfer: moving money between the account holder's own accounts.
  - refund: money returned by a merchant (refund, reversal, cashback).
  - expense: everything else that is spending.
- category (expense and refund only, else null): ${DEFAULT_CATEGORIES.join(', ')}.
- UPI narrations look like UPI/<ref>/<payee>/<vpa>/<note>; the payee is the merchant. A payment to a person's name (not a business) gets category "Other" and confidence below 0.7 unless the note makes the purpose clear.
- confidence: 0.0–1.0, how sure you are of kind and category.`;

const statementLabel = (statementType) => (statementType === 'credit_card' ? 'credit card' : 'bank account');
const statementRules = (statementType) => (statementType === 'credit_card'
  ? `- This is a CREDIT CARD statement: purchases, fees, interest and EMIs are debits; payments received, refunds, reversals and cashback are credits. "Previous Balance" is opening_balance and "Total Amount Due" is closing_balance.`
  : '- This is a BANK ACCOUNT statement: withdrawals are debits and deposits are credits.');

const PROMPTS = {
  extract: (statementType) => `You are a bank and credit card statement transaction extractor. The user sends the raw text of ONE PAGE of a ${statementLabel(statementType)} statement (from an Indian bank or card issuer unless the text says otherwise).

Return ONLY a JSON object in EXACTLY this format – no markdown fences, no prose:
{
  "statement": { "last4": "<last 4 digits of the account/card number, or null>", "period_start": "YYYY-MM-DD or null", "period_end": "YYYY-MM-DD or null", "opening_balance": <number or null>, "closing_balance": <number or null> },
  "transactions": [
    { "date": "YYYY-MM-DD", "description": "<narration exactly as printed>", "merchant": "<short clean merchant or payee name>", "amount": <positive number>, "direction": "debit|credit", "kind": "<kind>", "category": "<category or null>", "confidence": <number> }
  ]
}

Rules:
- One entry per transaction row. Skip headers, opening/closing balance lines, totals and reward summaries.
- Dates are day-first: 05/08/2026 is 5 August 2026.
- Amounts use the Indian format (1,00,000.00 = 100000). Remove currency symbols and commas. Amounts are always positive; "direction" carries the sign.
- Direction: "Dr"/withdrawal = debit, "Cr"/deposit = credit. When only a running balance is shown, a rising balance means credit.
${statementRules(statementType)}
${KIND_RULES}
- statement: fill from the page header when present, otherwise null.`,

  validate: `You are a transaction extraction validator. You receive the raw text of ONE statement page and an initial JSON extraction of its transactions.

Cross-check every transaction against the raw text and return the corrected result in EXACTLY this format – no markdown fences, no prose:
{ "statement": { <same fields as the input> }, "transactions": [ <same schema as the input> ], "validation_notes": [ "<one short string per change>" ] }

Rules:
- Add transaction rows present in the raw text but missing from the extraction.
- Remove rows that are not transactions (headers, balances, totals).
- Fix amounts that do not exactly match the text (Indian format 1,00,000.00 = 100000; watch for factor-of-10/100/1000 errors).
- Fix debit/credit that contradicts Dr/Cr markers, withdrawal/deposit columns or the running balance.
- Fix dates (day-first: 05/08/2026 = 5 August 2026).
- Keep kind and category unless clearly wrong.
- validation_notes is [] when nothing changed.`,

  review: `You are a specialist transaction accuracy reviewer. You receive the raw text of ONE statement page and a validated JSON extraction.

Your ONLY job is to catch and fix three kinds of error:
1. AMOUNT – every amount must equal the raw text exactly (Indian format; no magnitude errors).
2. DIRECTION – debit vs credit must match Dr/Cr markers, columns or the running balance.
3. KIND – credit card bill payments are "cc_payment"; salary is "income"; SIP / mutual fund / broker / NPS / PPF debits are "investment"; merchant refunds and reversals are "refund".

Return EXACTLY this JSON – no markdown fences, no prose:
{ "statement": { <same fields> }, "transactions": [ <same schema> ], "accuracy_notes": [ "<one short string per correction>" ] }
accuracy_notes is [] when nothing changed.`,

  csvMap: `You are a bank statement CSV column mapper. Map each CSV header to one target field:
- date: transaction date (prefer the transaction/posting date over the value date)
- description: narration / particulars / details / remarks
- debit: withdrawal / debit amount column
- credit: deposit / credit amount column
- amount: a single amount column (only when there are no separate debit and credit columns)
- dr_cr: a column that says Dr/Cr or Debit/Credit
- balance: running / closing balance
Map anything else (cheque or reference numbers, the value date when a transaction date exists) to null. Never map two headers to the same target.

Return ONLY JSON, no markdown fences: { "column_mapping": { "<csv header>": "<target or null>" } }`,

  classify: (statementType) => `You are a transaction classifier for a ${statementLabel(statementType)} statement (from an Indian bank or card issuer unless stated otherwise). The user sends a JSON array of transactions: { "i": <index>, "description", "amount", "direction" }.

Return ONLY JSON, no markdown fences:
{ "results": [ { "i": <same index>, "merchant": "<short clean name>", "kind": "<kind>", "category": "<category or null>", "confidence": <number> } ] }

${statementRules(statementType)}
${KIND_RULES}`,
};

function aiOptions(options = {}) {
  const apiKey = options.apiKey || process.env.AI_API_KEY || process.env.OPENAI_API_KEY;
  if (!apiKey) return null;
  return {
    apiKey,
    apiUrl: options.apiUrl || process.env.AI_API_URL || 'https://api.openai.com/v1',
    model: options.model || process.env.AI_MODEL || 'gpt-4o-mini',
  };
}

async function callAIJson(systemPrompt, userMessage, ai, maxTokens = AI_MAX_TOKENS) {
  const response = await fetch(`${ai.apiUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ai.apiKey}` },
    body: JSON.stringify({
      model: ai.model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
      temperature: 0,
      max_tokens: maxTokens,
    }),
  });
  if (!response.ok) {
    const err = await response.text().catch(() => '');
    throw new Error(`AI API error ${response.status}: ${err}`);
  }
  const data = await response.json();
  const content = data.choices?.[0]?.message?.content?.trim();
  if (!content) throw new Error('AI returned empty response');
  const cleaned = content.replace(/^`{3}(?:json)?\s*/i, '').replace(/`{3}\s*$/, '').trim();
  return JSON.parse(cleaned);
}

/** Normalise one AI transaction; returns null when date, amount, direction or description is unusable. */
function sanitizeAiTxn(t) {
  if (!t || typeof t !== 'object') return null;
  const date = parseTxnDate(t.date);
  const amount = parseAmount(t.amount);
  const direction = t.direction === 'debit' || t.direction === 'credit' ? t.direction : null;
  const description = String(t.description || '').replace(/\s+/g, ' ').trim();
  if (!date || !amount || !direction || !description) return null;
  return {
    date, description, amount, direction,
    merchant: t.merchant ? String(t.merchant) : null,
    kind: typeof t.kind === 'string' ? t.kind : null,
    category: t.category ? String(t.category) : null,
    confidence: typeof t.confidence === 'number' ? t.confidence : null,
  };
}

/** Copy AI header fields into `target`; the first page that supplies a field wins. */
function mergeAiStatement(target, aiStatement, filled) {
  if (!aiStatement || typeof aiStatement !== 'object') return;
  for (const field of STATEMENT_FIELDS) {
    if (filled.has(field)) continue;
    const raw = aiStatement[field];
    let value;
    if (field === 'last4') value = /^\d{4}$/.test(String(raw ?? '')) ? String(raw) : null;
    else if (field.startsWith('period')) value = parseTxnDate(raw);
    else value = typeof raw === 'number' ? raw : parseAmount(raw);
    if (value != null) {
      target[field] = value;
      filled.add(field);
    }
  }
}

/** Three AI passes over one page, with the same acceptance rules as parseStatement(). */
async function parsePageWithAI(pageText, statementType, ai) {
  const pass1 = await callAIJson(PROMPTS.extract(statementType), pageText, ai);
  const txns1 = Array.isArray(pass1.transactions) ? pass1.transactions : [];
  let result = { statement: pass1.statement || {}, transactions: txns1, notes: [] };
  if (txns1.length === 0) return result;

  // Pass 2: accepted only when it does not drop rows.
  let pass2 = null;
  try {
    const refined = await callAIJson(PROMPTS.validate,
      `RAW TEXT:\n${pageText}\n\nINITIAL EXTRACTION:\n${JSON.stringify(pass1, null, 2)}`, ai);
    if (Array.isArray(refined.transactions) && refined.transactions.length >= txns1.length) {
      pass2 = {
        statement: refined.statement || result.statement,
        transactions: refined.transactions,
        notes: Array.isArray(refined.validation_notes) ? refined.validation_notes : [],
      };
      result = pass2;
    }
  } catch (_validateErr) {
    // Validation failed — keep Pass 1.
  }

  // Pass 3: only when Pass 2 corrected something.
  if (pass2 && pass2.notes.length > 0) {
    try {
      const reviewed = await callAIJson(PROMPTS.review,
        `RAW TEXT:\n${pageText}\n\nVALIDATED EXTRACTION:\n${JSON.stringify({ statement: pass2.statement, transactions: pass2.transactions }, null, 2)}`, ai);
      if (Array.isArray(reviewed.transactions) && reviewed.transactions.length > 0) {
        result = {
          statement: reviewed.statement || pass2.statement,
          transactions: reviewed.transactions,
          notes: [...pass2.notes, ...(Array.isArray(reviewed.accuracy_notes) ? reviewed.accuracy_notes : [])],
        };
      }
    } catch (_reviewErr) {
      // Review failed — keep Pass 2.
    }
  }
  return result;
}

function fillPeriodFromTransactions(statement, transactions) {
  if (!transactions.length) return;
  const dates = transactions.map((t) => t.date).sort();
  if (!statement.period_start) statement.period_start = dates[0];
  if (!statement.period_end) statement.period_end = dates[dates.length - 1];
}

/**
 * Parse PDF statement pages.
 * @param {string[]} pages
 * @param {{statementType: 'bank'|'credit_card', apiKey?, apiUrl?, model?, forcePattern?}} options
 * @returns {Promise<{statement, transactions, method: 'ai'|'pattern', validation_notes: string[]}>}
 */
async function parseTransactionsFromPages(pages, options = {}) {
  const statementType = options.statementType === 'credit_card' ? 'credit_card' : 'bank';
  const ai = options.forcePattern ? null : aiOptions(options);
  const statement = detectStatementHeader(pages.join('\n'));
  const aiFilled = new Set();
  const state = { prevBalance: statement.opening_balance };
  const transactions = [];
  const validation_notes = [];
  let usedPattern = !ai;

  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];
    if (!page || !page.trim()) continue;
    let pageTxns = [];
    if (ai) {
      try {
        const r = await parsePageWithAI(page, statementType, ai);
        mergeAiStatement(statement, r.statement, aiFilled);
        pageTxns = r.transactions.map(sanitizeAiTxn).filter(Boolean);
        validation_notes.push(...r.notes.map((n) => `Page ${i + 1}: ${n}`));
      } catch (err) {
        validation_notes.push(`Page ${i + 1}: AI parsing failed (${err.message}); used the pattern parser.`);
      }
    }
    if (pageTxns.length === 0) {
      const fallback = parsePageWithPattern(page, statementType, state);
      if (fallback.length > 0) {
        pageTxns = fallback;
        usedPattern = true;
      }
    }
    transactions.push(...pageTxns);
  }

  fillPeriodFromTransactions(statement, transactions);
  return { statement, transactions, method: usedPattern ? 'pattern' : 'ai', validation_notes };
}
```

3. Replace `module.exports = { ... };` with:

```js
module.exports = {
  PROMPTS,
  parseTxnDate, parseAmount, detectStatementHeader, parsePageWithPattern,
  parseTransactionsFromPages,
};
```

- [ ] **Step 6: Run to verify pass**

Run: `cd backend && NODE_OPTIONS=--experimental-vm-modules npx jest tests/expenses.test.js`
Expected: PASS (all tests so far). Then `cd backend && npm test` → existing PDF import tests still pass (they use `extractPdfText`).

- [ ] **Step 7: Commit**

```bash
git add backend/src/utils/pdfExtractor.js backend/src/utils/transactionParser.js backend/tests/helpers/expenseFixtures.js backend/tests/expenses.test.js
git commit -m "Parse statement PDFs per page with the three-pass AI flow

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: CSV statements

**Files:**
- Modify: `backend/src/utils/transactionParser.js` (requires, CSV section, exports)
- Test: `backend/tests/expenses.test.js`

**Interfaces:**
- Consumes: Task 4/5 functions, `callAIJson`, `aiOptions`, `fillPeriodFromTransactions`, `PROMPTS.csvMap`, `PROMPTS.classify` (all in the same file); `KINDS`, `keywordClassify` from Task 3
- Produces: `parseTransactionsFromCsv(buffer, { statementType, apiKey?, apiUrl?, model?, forcePattern? }) → Promise<{ statement, transactions, method, validation_notes }>`; throws `Error` with `.status = 422` for unreadable CSVs

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/expenses.test.js`:

```js
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
```

- [ ] **Step 2: Run to verify failure**

Run: `cd backend && NODE_OPTIONS=--experimental-vm-modules npx jest tests/expenses.test.js -t CSV`
Expected: FAIL — `tp.parseTransactionsFromCsv is not a function`.

- [ ] **Step 3: Implement**

In `backend/src/utils/transactionParser.js`:

1. Replace the classifier require line with these two lines:

```js
const { parse } = require('csv-parse/sync');
const { KINDS, DEFAULT_CATEGORIES, keywordClassify } = require('./transactionClassifier');
```

2. Insert immediately above `module.exports`:

```js
// ─── CSV parsing ──────────────────────────────────────────────────────────────

const CSV_TARGETS = ['date', 'description', 'debit', 'credit', 'amount', 'dr_cr', 'balance'];
// Alias order matters: the first alias present in the headers wins for each target.
const CSV_ALIASES = {
  date: ['date', 'txn_date', 'transaction_date', 'tran_date', 'posting_date', 'value_date', 'value_dt'],
  description: ['description', 'narration', 'particulars', 'details', 'remarks', 'transaction_details', 'transaction_description', 'transaction_remarks'],
  debit: ['debit', 'withdrawal', 'withdrawal_amt', 'withdrawal_amount', 'debit_amount', 'dr', 'dr_amount'],
  credit: ['credit', 'deposit', 'deposit_amt', 'deposit_amount', 'credit_amount', 'cr', 'cr_amount'],
  amount: ['amount', 'transaction_amount', 'amt', 'amount_inr'],
  dr_cr: ['dr/cr', 'cr/dr', 'debit/credit', 'dr_cr', 'type', 'transaction_type'],
  balance: ['balance', 'closing_balance', 'running_balance', 'available_balance'],
};

function normalizeHeader(header) {
  return String(header || '').trim().toLowerCase()
    .replace(/\s*\/\s*/g, '/')
    .replace(/[().]/g, '')
    .replace(/\s+/g, '_');
}

/** @returns {Object<string,string>} target field → CSV header */
function mapByAliases(headers) {
  const normalized = headers.map(normalizeHeader);
  const fields = {};
  for (const [target, aliases] of Object.entries(CSV_ALIASES)) {
    for (const alias of aliases) {
      const idx = normalized.indexOf(alias);
      if (idx >= 0 && !Object.values(fields).includes(headers[idx])) {
        fields[target] = headers[idx];
        break;
      }
    }
  }
  return fields;
}

/** Bank CSVs often start with a preamble; the header row is the first with date + description columns. */
function findHeaderRow(rows) {
  return rows.findIndex((row) => {
    const cells = row.map(normalizeHeader);
    return CSV_ALIASES.date.some((a) => cells.includes(a)) && CSV_ALIASES.description.some((a) => cells.includes(a));
  });
}

async function mapTransactionCsvColumnsWithAI(headers, sampleRows, ai) {
  const r = await callAIJson(PROMPTS.csvMap,
    `CSV headers: ${JSON.stringify(headers)}\nSample rows:\n${JSON.stringify(sampleRows, null, 2)}`, ai, 1024);
  const fields = {};
  for (const [header, target] of Object.entries(r.column_mapping || {})) {
    if (headers.includes(header) && CSV_TARGETS.includes(target) && !fields[target]) fields[target] = header;
  }
  if (!fields.date || !fields.description || !(fields.debit || fields.credit || fields.amount)) {
    throw new Error('AI column mapping missed the date, description or amount columns');
  }
  return fields;
}

function csvRowToTxn(row, fields) {
  const get = (f) => (fields[f] != null ? row[fields[f]] : undefined);
  const date = parseTxnDate(get('date'));
  const description = String(get('description') ?? '').replace(/\s+/g, ' ').trim();
  if (!date || !description) return null;
  const debit = parseAmount(get('debit'));
  const credit = parseAmount(get('credit'));
  const balance = parseAmount(get('balance'));
  if (debit) return { date, description, amount: debit, direction: 'debit', balance };
  if (credit) return { date, description, amount: credit, direction: 'credit', balance };
  const raw = String(get('amount') ?? '').trim();
  const amount = parseAmount(raw);
  if (!amount) return null;
  const flag = String(get('dr_cr') ?? '').trim().toLowerCase();
  let direction = null;
  if (/^(cr|credit|c)$/.test(flag) || /cr$/i.test(raw)) direction = 'credit';
  else if (/^(dr|debit|d)$/.test(flag) || /dr$/i.test(raw) || raw.startsWith('-')) direction = 'debit';
  return { date, description, amount, direction, balance };
}

async function classifyDescriptionsWithAI(txns, statementType, ai) {
  const results = [];
  for (let start = 0; start < txns.length; start += CSV_CLASSIFY_BATCH) {
    const batch = txns.slice(start, start + CSV_CLASSIFY_BATCH).map((t, j) => ({
      i: start + j, description: t.description, amount: t.amount, direction: t.direction || 'unknown',
    }));
    const r = await callAIJson(PROMPTS.classify(statementType), JSON.stringify(batch), ai);
    for (const c of Array.isArray(r.results) ? r.results : []) {
      if (Number.isInteger(c.i) && c.i >= 0 && c.i < txns.length) results[c.i] = c;
    }
  }
  return results;
}

/**
 * Parse a CSV statement export.
 * @param {Buffer} buffer
 * @param {{statementType: 'bank'|'credit_card', apiKey?, apiUrl?, model?, forcePattern?}} options
 * @returns {Promise<{statement, transactions, method: 'ai'|'pattern', validation_notes: string[]}>}
 *          Throws an Error with status 422 when the CSV cannot be read.
 */
async function parseTransactionsFromCsv(buffer, options = {}) {
  const statementType = options.statementType === 'credit_card' ? 'credit_card' : 'bank';
  const ai = options.forcePattern ? null : aiOptions(options);
  const fail = (message) => Object.assign(new Error(message), { status: 422 });

  let rows;
  try {
    rows = parse(buffer, { bom: true, relax_column_count: true, skip_empty_lines: true, trim: true });
  } catch (err) {
    throw fail(`CSV parse error: ${err.message}`);
  }
  const headerIdx = findHeaderRow(rows);
  if (headerIdx < 0) throw fail('Could not find a header row with date and description/narration columns');
  const headers = rows[headerIdx];
  const records = rows.slice(headerIdx + 1).map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i]])));

  const validation_notes = [];
  let fields = null;
  if (ai) {
    try {
      fields = await mapTransactionCsvColumnsWithAI(headers, records.slice(0, 3), ai);
    } catch (err) {
      validation_notes.push(`AI column mapping failed (${err.message}); used header aliases.`);
    }
  }
  if (!fields) fields = mapByAliases(headers);
  const parsed = records.map((r) => csvRowToTxn(r, fields)).filter(Boolean);

  let classified = null;
  if (ai && parsed.length) {
    try {
      classified = await classifyDescriptionsWithAI(parsed, statementType, ai);
    } catch (err) {
      validation_notes.push(`AI classification failed (${err.message}); used keyword rules.`);
    }
  }

  const transactions = parsed.map((t, i) => {
    const direction = t.direction || 'debit';
    const c = classified && classified[i];
    const k = c && KINDS.includes(c.kind) ? c : keywordClassify(t.description, direction, statementType);
    let confidence = typeof k.confidence === 'number' ? k.confidence : 0.5;
    if (!t.direction) confidence = Math.min(confidence, 0.4);
    return {
      date: t.date, description: t.description, merchant: (c && c.merchant) || null,
      amount: t.amount, direction, kind: k.kind, category: k.category ?? null, confidence,
    };
  });

  // Balances: exports may be oldest-first or newest-first.
  const statement = { last4: null, period_start: null, period_end: null, opening_balance: null, closing_balance: null };
  const withBalance = parsed.filter((t) => t.balance != null && t.direction);
  if (statementType === 'bank' && withBalance.length) {
    const ascending = parsed[0].date <= parsed[parsed.length - 1].date;
    const ordered = ascending ? withBalance : [...withBalance].reverse();
    const first = ordered[0];
    statement.closing_balance = ordered[ordered.length - 1].balance;
    statement.opening_balance = Math.round((first.direction === 'credit' ? first.balance - first.amount : first.balance + first.amount) * 100) / 100;
  }
  fillPeriodFromTransactions(statement, transactions);
  return { statement, transactions, method: classified ? 'ai' : 'pattern', validation_notes };
}
```

3. Replace `module.exports = { ... };` with:

```js
module.exports = {
  PROMPTS,
  parseTxnDate, parseAmount, detectStatementHeader, parsePageWithPattern,
  parseTransactionsFromPages, parseTransactionsFromCsv,
};
```

- [ ] **Step 4: Run to verify pass**

Run: `cd backend && NODE_OPTIONS=--experimental-vm-modules npx jest tests/expenses.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/utils/transactionParser.js backend/tests/expenses.test.js
git commit -m "Parse CSV statements with AI column mapping and alias fallback

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Card-payment and transfer matcher

**Files:**
- Create: `backend/src/utils/transactionMatcher.js`
- Test: `backend/tests/expenses.test.js`

**Interfaces:**
- Consumes: `mentionsLast4` (Task 3); tables from Task 1; test helpers `insertStatement`, `insertTxn` (Task 1)
- Produces: `runMatcher(conn, { from: 'YYYY-MM-DD', to: 'YYYY-MM-DD' }) → { card_payments, promoted, transfers }`. Considers only rows with `matched_txn_id IS NULL` in the window; pairs set `matched_txn_id` on both rows; never changes a row with `kind_locked = 1` (except pairing a locked row that already has the right kind).

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/expenses.test.js`:

```js
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
```

- [ ] **Step 2: Run to verify failure**

Run: `cd backend && NODE_OPTIONS=--experimental-vm-modules npx jest tests/expenses.test.js -t transactionMatcher`
Expected: FAIL — `Cannot find module '../src/utils/transactionMatcher'`.

- [ ] **Step 3: Implement**

Create `backend/src/utils/transactionMatcher.js`:

```js
/**
 * transactionMatcher.js – pairs credit card bill payments and own-account transfers so
 * they are never counted as spending. Runs on every commit (inside the caller's DB
 * transaction), so the order in which bank and card statements are uploaded does not matter.
 */
const { mentionsLast4 } = require('./transactionClassifier');

const AMOUNT_TOLERANCE = 1;   // ₹1 rounding slack
const CARD_PAYMENT_DAYS = 5;  // bank debit → card credit posting lag
const TRANSFER_DAYS = 3;

const dayDiff = (a, b) => Math.abs(Date.parse(a) - Date.parse(b)) / 86400000;
const amountEq = (a, b) => Math.abs(a - b) <= AMOUNT_TOLERANCE;

/**
 * @param {import('better-sqlite3').Database} conn
 * @param {{from: string, to: string}} window  ISO dates bounding the rows to consider
 * @returns {{card_payments: number, promoted: number, transfers: number}}
 */
function runMatcher(conn, { from, to }) {
  const rows = conn.prepare(
    `SELECT t.*, s.statement_type, s.last4 AS statement_last4
       FROM transactions t
       JOIN expense_statements s ON s.id = t.statement_id
      WHERE t.txn_date BETWEEN ? AND ? AND t.matched_txn_id IS NULL
      ORDER BY t.txn_date, t.id`
  ).all(from, to);

  const setMatch = conn.prepare(`UPDATE transactions SET matched_txn_id = ?, updated_at = datetime('now') WHERE id = ?`);
  const setKind = conn.prepare(
    `UPDATE transactions SET kind = ?, category = NULL, needs_review = ?, updated_at = datetime('now') WHERE id = ?`
  );
  const used = new Set();
  const link = (a, b) => {
    setMatch.run(b.id, a.id);
    setMatch.run(a.id, b.id);
    used.add(a.id);
    used.add(b.id);
  };
  const result = { card_payments: 0, promoted: 0, transfers: 0 };

  const bankDebits = rows.filter((r) => r.statement_type === 'bank' && r.direction === 'debit');
  const bankCredits = rows.filter((r) => r.statement_type === 'bank' && r.direction === 'credit');
  const cardPayments = rows.filter((r) => r.statement_type === 'credit_card' && r.direction === 'credit' && r.kind === 'cc_payment');

  // Prefer the card whose last4 the bank narration mentions, then the closest date.
  const bestCardPayment = (debit) => {
    const candidates = cardPayments.filter((c) => !used.has(c.id) &&
      amountEq(c.amount, debit.amount) && dayDiff(c.txn_date, debit.txn_date) <= CARD_PAYMENT_DAYS);
    candidates.sort((a, b) =>
      (mentionsLast4(debit.description, a.statement_last4) ? 0 : 1) - (mentionsLast4(debit.description, b.statement_last4) ? 0 : 1) ||
      dayDiff(a.txn_date, debit.txn_date) - dayDiff(b.txn_date, debit.txn_date));
    return candidates[0] || null;
  };

  // 1. Pair bank card-payment debits with the card's "payment received" credit.
  for (const debit of bankDebits.filter((r) => r.kind === 'cc_payment')) {
    const credit = bestCardPayment(debit);
    if (credit) { link(debit, credit); result.card_payments++; }
  }

  // 2. A bank debit that was not recognised but exactly matches a card payment is one.
  for (const debit of bankDebits.filter((r) => !used.has(r.id) && r.kind !== 'cc_payment' && r.kind !== 'transfer' && !r.kind_locked)) {
    const credit = bestCardPayment(debit);
    if (credit) {
      setKind.run('cc_payment', 1, debit.id);
      link(debit, credit);
      result.promoted++;
    }
  }

  // 3. Pair transfers between two of the user's bank accounts.
  const canBeTransfer = (r) => r.kind === 'transfer' || !r.kind_locked;
  for (const debit of bankDebits) {
    if (used.has(debit.id) || debit.kind === 'cc_payment' || !canBeTransfer(debit)) continue;
    const credit = bankCredits.find((c) => !used.has(c.id) && canBeTransfer(c) &&
      !(c.source_type === debit.source_type && c.source_id === debit.source_id) &&
      amountEq(c.amount, debit.amount) && dayDiff(c.txn_date, debit.txn_date) <= TRANSFER_DAYS &&
      (debit.kind === 'transfer' || c.kind === 'transfer' ||
       mentionsLast4(debit.description, c.statement_last4) || mentionsLast4(c.description, debit.statement_last4)));
    if (!credit) continue;
    if (debit.kind !== 'transfer') setKind.run('transfer', 0, debit.id);
    if (credit.kind !== 'transfer') setKind.run('transfer', 0, credit.id);
    link(debit, credit);
    result.transfers++;
  }

  return result;
}

module.exports = { runMatcher, CARD_PAYMENT_DAYS, TRANSFER_DAYS };
```

- [ ] **Step 4: Run to verify pass**

Run: `cd backend && NODE_OPTIONS=--experimental-vm-modules npx jest tests/expenses.test.js -t transactionMatcher`
Expected: PASS (10 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/src/utils/transactionMatcher.js backend/tests/expenses.test.js
git commit -m "Pair card payments and own transfers across statements

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 8: Expenses API — preview and commit

**Files:**
- Create: `backend/src/routes/expenses.js`
- Modify: `backend/src/app.js` (require, body-parser order, limiter + router mounts)
- Test: `backend/tests/expenses.test.js`

**Interfaces:**
- Consumes: `pdfExtractor.extractPdfPages` (called through the module object so tests can spy on it), `parseTransactionsFromPages`, `parseTransactionsFromCsv`, `parseTxnDate` (Tasks 4–6); `KINDS`, `EXCLUDED_KINDS`, `merchantKey`, `applyPostProcessing`, `computeDedupeKeys`, `reconciliationNote` (Task 3); `runMatcher` (Task 7)
- Produces:
  - `POST /api/expenses/preview` (multipart: `file`, `source_type`, `source_id`, `password?`) → `200 { statement: { last4, period_start, period_end, opening_balance, closing_balance, statement_type, file_name }, transactions: [{ date, description, merchant, merchant_key, amount, direction, kind, category, confidence, needs_review, dedupe_key, duplicate }], method, validation_notes, balance_update: { eligible, default_checked, entity_type, current, proposed } }`; `422 { error, code: 'PASSWORD_REQUIRED' }` for locked PDFs
  - `POST /api/expenses/commit` (JSON `{ source_type, source_id, statement: { ...preview.statement, parse_method }, transactions: [{ date, description, merchant, amount, direction, kind, category, needs_review, edited?, remember? }], update_balance?, force_balance? }`) → `201 { statement_id: number|null, inserted, duplicates, rules_learned, matches: { card_payments, promoted, transfers }, balance_updated }`; `409 { error, code: 'STALE_BALANCE' }`
  - Route-module internals reused by Task 9 (same file): `router`, `UPSERT_RULE_SQL`, `today()`

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/expenses.test.js`:

```js
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
```

- [ ] **Step 2: Run to verify failure**

Run: `cd backend && NODE_OPTIONS=--experimental-vm-modules npx jest tests/expenses.test.js -t "preview & commit"`
Expected: FAIL — preview returns 404 `Not found`.

- [ ] **Step 3: Create the route (preview + commit)**

Create `backend/src/routes/expenses.js`:

```js
/**
 * expenses.js – monthly expense tracking from bank and credit card statements.
 *
 * Routes:
 *   POST   /api/expenses/preview           – parse an uploaded statement (nothing saved)
 *   POST   /api/expenses/commit            – save reviewed transactions, learn rules,
 *                                            pair card payments/transfers, update balance
 *   GET    /api/expenses/summary           – one month's totals
 *   GET    /api/expenses/trend             – monthly series
 *   GET    /api/expenses/transactions      – filtered list
 *   PUT    /api/expenses/transactions/:id  – change kind/category (optionally learn a rule)
 *   GET    /api/expenses/statements        – uploaded statements
 *   DELETE /api/expenses/statements/:id    – undo an upload
 *   GET    /api/expenses/rules             – learned merchant rules
 *   DELETE /api/expenses/rules/:id
 *   GET    /api/expenses/categories        – default + in-use categories
 */

const express = require('express');
const router = express.Router();
const multer = require('multer');
const db = require('../db/database');
const pdfExtractor = require('../utils/pdfExtractor');
const { parseTransactionsFromPages, parseTransactionsFromCsv, parseTxnDate } = require('../utils/transactionParser');
const {
  KINDS, EXCLUDED_KINDS, merchantKey, applyPostProcessing, computeDedupeKeys, reconciliationNote,
} = require('../utils/transactionClassifier');
const { runMatcher } = require('../utils/transactionMatcher');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

// The matcher looks this many days beyond the committed rows for partners.
const MATCH_WINDOW_DAYS = 10;

const UPSERT_RULE_SQL =
  `INSERT INTO merchant_rules (merchant_key, kind, category) VALUES (?, ?, ?)
   ON CONFLICT(merchant_key) DO UPDATE SET kind = excluded.kind, category = excluded.category, updated_at = datetime('now')`;

const today = () => new Date().toISOString().slice(0, 10);

function shiftDate(iso, days) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const isPdf = (file) => /pdf/i.test(file.mimetype || '') || /\.pdf$/i.test(file.originalname || '');
const isCsv = (file) => /csv|text\/plain|ms-excel/i.test(file.mimetype || '') || /\.csv$/i.test(file.originalname || '');

/**
 * Validate the statement's linked source. Bank statements link to an account and card
 * statements to a credit_card liability.
 * @returns {{source, statementType, entityType, balance}|{status, error}}
 */
function resolveSource(conn, sourceType, sourceId) {
  if (sourceType !== 'account' && sourceType !== 'liability') {
    return { status: 400, error: "source_type must be 'account' or 'liability'" };
  }
  const id = Number(sourceId);
  if (!Number.isInteger(id) || id <= 0) return { status: 400, error: 'source_id is required' };
  if (sourceType === 'account') {
    const source = conn.prepare('SELECT * FROM accounts WHERE id = ?').get(id);
    if (!source) return { status: 404, error: 'Account not found' };
    return { source, statementType: 'bank', entityType: 'account', balance: source.balance };
  }
  const source = conn.prepare('SELECT * FROM liabilities WHERE id = ?').get(id);
  if (!source) return { status: 404, error: 'Liability not found' };
  if (source.type !== 'credit_card') {
    return { status: 400, error: 'Only credit_card liabilities can be linked to a card statement' };
  }
  return { source, statementType: 'credit_card', entityType: 'liability', balance: source.current_balance };
}

function loadRules(conn) {
  return new Map(conn.prepare('SELECT merchant_key, kind, category FROM merchant_rules').all()
    .map((r) => [r.merchant_key, { kind: r.kind, category: r.category }]));
}

/** Last-4 digits already known from saved statements, for card-payment and transfer rules. */
function knownLast4(conn, sourceType, sourceId) {
  const rows = conn.prepare(
    'SELECT DISTINCT statement_type, source_type, source_id, last4 FROM expense_statements WHERE last4 IS NOT NULL'
  ).all();
  return {
    knownCardLast4: rows.filter((r) => r.statement_type === 'credit_card').map((r) => r.last4),
    otherBankLast4: rows
      .filter((r) => r.statement_type === 'bank' && !(r.source_type === sourceType && r.source_id === sourceId))
      .map((r) => r.last4),
  };
}

function existingDedupeKeys(conn, keys) {
  const found = new Set();
  for (let i = 0; i < keys.length; i += 500) {
    const chunk = keys.slice(i, i + 500);
    const rows = conn.prepare(
      `SELECT dedupe_key FROM transactions WHERE dedupe_key IN (${chunk.map(() => '?').join(',')})`
    ).all(...chunk);
    rows.forEach((r) => found.add(r.dedupe_key));
  }
  return found;
}

/**
 * Applying a statement's closing balance is safe by default only when it cannot
 * overwrite a newer balance: the source is fresh (balance 0), has no history, or the
 * statement ends after the latest recorded value.
 */
function balanceUpdateIsSafe(conn, resolved, periodEnd) {
  if (!resolved.balance) return true;
  const row = conn.prepare(
    'SELECT MAX(recorded_at) AS latest FROM value_history WHERE entity_type = ? AND entity_id = ?'
  ).get(resolved.entityType, resolved.source.id);
  if (!row || !row.latest) return true;
  return !!periodEnd && periodEnd > row.latest;
}

// ─── POST /api/expenses/preview ───────────────────────────────────────────────

router.post('/preview', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const conn = db.getDb();
  const resolved = resolveSource(conn, req.body.source_type, req.body.source_id);
  if (resolved.error) return res.status(resolved.status).json({ error: resolved.error });
  const { statementType } = resolved;
  const sourceType = req.body.source_type;
  const sourceId = resolved.source.id;

  try {
    let parsed;
    if (isPdf(req.file)) {
      const pages = await pdfExtractor.extractPdfPages(req.file.buffer, req.body.password || '', { preserveLines: true });
      if (!pages.some((p) => p.trim())) {
        return res.status(422).json({ error: 'Could not extract text from PDF. The file may be scanned/image-only.' });
      }
      parsed = await parseTransactionsFromPages(pages, { statementType });
    } else if (isCsv(req.file)) {
      parsed = await parseTransactionsFromCsv(req.file.buffer, { statementType });
    } else {
      return res.status(422).json({ error: 'File must be a PDF or CSV statement' });
    }

    if (parsed.transactions.length === 0) {
      return res.status(422).json({
        error: 'No transactions could be found in this statement.',
        validation_notes: parsed.validation_notes,
      });
    }

    let transactions = applyPostProcessing(parsed.transactions, {
      statementType,
      rules: loadRules(conn),
      ...knownLast4(conn, sourceType, sourceId),
    });
    transactions = computeDedupeKeys(transactions, sourceType, sourceId);
    const existing = existingDedupeKeys(conn, transactions.map((t) => t.dedupe_key));
    transactions = transactions.map((t) => ({ ...t, duplicate: existing.has(t.dedupe_key) }));

    const validation_notes = [...parsed.validation_notes];
    const note = reconciliationNote(parsed.statement, parsed.transactions, statementType);
    if (note) validation_notes.push(note);

    const s = parsed.statement;
    res.json({
      statement: { ...s, statement_type: statementType, file_name: req.file.originalname || null },
      transactions,
      method: parsed.method,
      validation_notes,
      balance_update: {
        eligible: s.closing_balance != null,
        default_checked: s.closing_balance != null && balanceUpdateIsSafe(conn, resolved, s.period_end),
        entity_type: resolved.entityType,
        current: resolved.balance,
        proposed: s.closing_balance ?? null,
      },
    });
  } catch (err) {
    if (err.code === 'PASSWORD_REQUIRED') return res.status(422).json({ error: err.message, code: 'PASSWORD_REQUIRED' });
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('Expense statement preview error:', err);
    res.status(500).json({ error: `Failed to parse statement: ${err.message}` });
  }
});

// ─── POST /api/expenses/commit ────────────────────────────────────────────────

router.post('/commit', (req, res) => {
  const conn = db.getDb();
  const {
    source_type: sourceType, source_id: rawSourceId, statement = {}, transactions,
    update_balance: updateBalance = false, force_balance: forceBalance = false,
  } = req.body || {};
  const resolved = resolveSource(conn, sourceType, rawSourceId);
  if (resolved.error) return res.status(resolved.status).json({ error: resolved.error });
  const sourceId = resolved.source.id;

  if (!Array.isArray(transactions) || transactions.length === 0) {
    return res.status(400).json({ error: 'transactions must be a non-empty array' });
  }
  const clean = [];
  for (const [i, t] of transactions.entries()) {
    const date = parseTxnDate(t && t.date);
    const amount = Number(t && t.amount);
    const description = String((t && t.description) || '').trim();
    if (!date || !(amount > 0) || !description || !['debit', 'credit'].includes(t.direction) || !KINDS.includes(t.kind)) {
      return res.status(400).json({
        error: `Transaction ${i + 1} is invalid: it needs a date, description, amount above 0, direction and a valid kind`,
      });
    }
    clean.push({
      date, description, amount, direction: t.direction, kind: t.kind,
      merchant: t.merchant || null,
      merchant_key: merchantKey(description),
      category: EXCLUDED_KINDS.includes(t.kind) ? null : (t.category || null),
      needs_review: t.needs_review ? 1 : 0,
      edited: !!t.edited,
      remember: t.remember !== false,
    });
  }
  const keyed = computeDedupeKeys(clean, sourceType, sourceId);
  const dates = keyed.map((t) => t.date).sort();
  const periodStart = parseTxnDate(statement.period_start) || dates[0];
  const periodEnd = parseTxnDate(statement.period_end) || dates[dates.length - 1];
  const closing = statement.closing_balance == null || statement.closing_balance === ''
    ? null : Number(statement.closing_balance);

  if (updateBalance) {
    if (closing == null || !Number.isFinite(closing)) {
      return res.status(400).json({ error: 'The statement has no closing balance to apply' });
    }
    if (!forceBalance && !balanceUpdateIsSafe(conn, resolved, periodEnd)) {
      return res.status(409).json({
        error: 'This statement ends before the balance was last updated, so its closing balance would overwrite a newer value.',
        code: 'STALE_BALANCE',
      });
    }
  }

  const result = conn.transaction(() => {
    let statementId = conn.prepare(
      `INSERT INTO expense_statements
         (source_type, source_id, statement_type, file_name, last4, period_start, period_end,
          opening_balance, closing_balance, parse_method)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      sourceType, sourceId, resolved.statementType,
      statement.file_name ? String(statement.file_name) : null,
      /^\d{4}$/.test(String(statement.last4 || '')) ? String(statement.last4) : null,
      periodStart, periodEnd,
      statement.opening_balance == null || statement.opening_balance === '' ? null : Number(statement.opening_balance),
      closing,
      ['ai', 'pattern'].includes(statement.parse_method) ? statement.parse_method : null,
    ).lastInsertRowid;

    const insert = conn.prepare(
      `INSERT OR IGNORE INTO transactions
         (statement_id, source_type, source_id, txn_date, description, merchant, merchant_key, amount,
          direction, kind, category, needs_review, kind_locked, dedupe_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const upsertRule = conn.prepare(UPSERT_RULE_SQL);
    let inserted = 0;
    let duplicates = 0;
    let rulesLearned = 0;
    for (const t of keyed) {
      const r = insert.run(
        statementId, sourceType, sourceId, t.date, t.description, t.merchant, t.merchant_key, t.amount,
        t.direction, t.kind, t.category, t.edited ? 0 : t.needs_review, t.edited ? 1 : 0, t.dedupe_key,
      );
      if (r.changes) inserted++;
      else duplicates++;
      if (t.edited && t.remember && t.merchant_key) {
        upsertRule.run(t.merchant_key, t.kind, t.category);
        rulesLearned++;
      }
    }
    // A re-upload where every row already exists leaves no empty statement behind.
    if (inserted === 0) {
      conn.prepare('DELETE FROM expense_statements WHERE id = ?').run(statementId);
      statementId = null;
    }

    const matches = runMatcher(conn, {
      from: shiftDate(dates[0], -MATCH_WINDOW_DAYS),
      to: shiftDate(dates[dates.length - 1], MATCH_WINDOW_DAYS),
    });

    let balanceUpdated = false;
    if (updateBalance) {
      if (resolved.entityType === 'account') {
        conn.prepare(`UPDATE accounts SET balance = ?, updated_at = datetime('now') WHERE id = ?`).run(closing, sourceId);
      } else {
        conn.prepare(`UPDATE liabilities SET current_balance = ?, updated_at = datetime('now') WHERE id = ?`).run(closing, sourceId);
      }
      conn.prepare(
        `INSERT INTO value_history (entity_type, entity_id, value, recorded_at, notes)
         VALUES (?, ?, ?, ?, 'expense statement import')`
      ).run(resolved.entityType, sourceId, closing, periodEnd || today());
      balanceUpdated = true;
    }

    return {
      statement_id: statementId == null ? null : Number(statementId),
      inserted, duplicates, rules_learned: rulesLearned, matches, balance_updated: balanceUpdated,
    };
  })();

  res.status(201).json(result);
});

module.exports = router;
```

- [ ] **Step 4: Mount it in `app.js`**

In `backend/src/app.js`:

1. After `const metalsRouter = require('./routes/metals');` add:

```js
const expensesRouter = require('./routes/expenses');
```

2. Replace the line `  app.use(express.json());` with:

```js
  // Expense commits carry a whole statement of transactions, which can exceed the
  // global 100 KB JSON limit. Their parser must run first: the global parser skips
  // bodies that have already been parsed.
  app.use('/api/expenses/commit', express.json({ limit: '5mb' }));
  app.use(express.json());
```

3. After `app.use('/api/export', apiLimiter, exportRouter);` add:

```js
  app.use('/api/expenses/preview', importLimiter);
  app.use('/api/expenses/commit', importLimiter);
  app.use('/api/expenses', apiLimiter, expensesRouter);
```

- [ ] **Step 5: Run to verify pass**

Run: `cd backend && NODE_OPTIONS=--experimental-vm-modules npx jest tests/expenses.test.js`
Expected: PASS. Then `cd backend && npm test` → all suites pass.

- [ ] **Step 6: Commit**

```bash
git add backend/src/routes/expenses.js backend/src/app.js backend/tests/expenses.test.js
git commit -m "Add expense statement preview and commit endpoints

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Expenses API — summary, trend, transactions, statements, rules

**Files:**
- Modify: `backend/src/routes/expenses.js` (add read/edit endpoints above `module.exports`)
- Test: `backend/tests/expenses.test.js`

**Interfaces:**
- Consumes: Task 8 route module (`router`, `UPSERT_RULE_SQL`, `today`), `normalizeFamilyMember` (Task 2), `KINDS`, `EXCLUDED_KINDS`, `DEFAULT_CATEGORIES` (Task 3)
- Produces:
  - `GET /api/expenses/summary?month=YYYY-MM&member=` → `{ month, member, income, spending, refunds, invested, savings_rate, investment_rate, by_category: [{category, amount}], excluded: { total, matched_count, unmatched_count }, needs_review_count, net_worth_change }` (rates are fractions, e.g. `0.72`; `null` when income is 0)
  - `GET /api/expenses/trend?months=12&member=&end=YYYY-MM` → `{ months: [{ month, income, spending, invested, savings_rate }] }` oldest first
  - `GET /api/expenses/transactions?month=&kind=&category=&member=&needs_review=1` → rows with `source_name`, `family_member`, `statement_type`
  - `PUT /api/expenses/transactions/:id` `{ kind?, category?, remember? }` → updated row (same shape as the list)
  - `GET /api/expenses/statements`, `DELETE /api/expenses/statements/:id`
  - `GET /api/expenses/rules`, `DELETE /api/expenses/rules/:id`
  - `GET /api/expenses/categories` → `string[]` (defaults ∪ categories in use)

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/expenses.test.js`:

```js
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
```

- [ ] **Step 2: Run to verify failure**

Run: `cd backend && NODE_OPTIONS=--experimental-vm-modules npx jest tests/expenses.test.js -t "reporting and editing"`
Expected: FAIL — `GET /api/expenses/summary` returns 404.

- [ ] **Step 3: Implement**

In `backend/src/routes/expenses.js`, add `const { normalizeFamilyMember } = require('../utils/familyMember');` to the requires, and change the classifier require to also import `DEFAULT_CATEGORIES`:

```js
const {
  KINDS, EXCLUDED_KINDS, DEFAULT_CATEGORIES, merchantKey, applyPostProcessing, computeDedupeKeys, reconciliationNote,
} = require('../utils/transactionClassifier');
```

Then insert immediately above `module.exports = router;`:

```js
// ─── Reporting helpers ────────────────────────────────────────────────────────

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const round2 = (v) => Math.round(v * 100) / 100;
const rate = (part, whole) => (whole > 0 ? Math.round((part / whole) * 10000) / 10000 : null);

const TXN_SELECT = `
  SELECT t.*, s.statement_type,
         COALESCE(a.name, l.name) AS source_name,
         COALESCE(a.family_member, l.family_member) AS family_member
    FROM transactions t
    JOIN expense_statements s ON s.id = t.statement_id
    LEFT JOIN accounts a    ON t.source_type = 'account'   AND a.id = t.source_id
    LEFT JOIN liabilities l ON t.source_type = 'liability' AND l.id = t.source_id`;

function withMember(row) {
  return row && { ...row, family_member: normalizeFamilyMember(row.family_member) };
}

function monthRange(month) {
  const [y, m] = month.split('-').map(Number);
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${String(lastDay).padStart(2, '0')}` };
}

function addMonths(month, delta) {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return d.toISOString().slice(0, 7);
}

/** Rows between two ISO dates, optionally for one family member. */
function loadTransactions(conn, { from, to }, member) {
  const rows = conn.prepare(`${TXN_SELECT} WHERE t.txn_date BETWEEN ? AND ? ORDER BY t.txn_date DESC, t.id DESC`)
    .all(from, to).map(withMember);
  if (!member) return rows;
  const wanted = normalizeFamilyMember(member);
  return rows.filter((r) => r.family_member === wanted);
}

function aggregate(rows) {
  const sum = (kind) => rows.filter((r) => r.kind === kind).reduce((s, r) => s + r.amount, 0);
  const income = sum('income');
  const refunds = sum('refund');
  const spending = sum('expense') - refunds;
  const invested = sum('investment');
  return {
    income: round2(income),
    spending: round2(spending),
    refunds: round2(refunds),
    invested: round2(invested),
    savings_rate: rate(income - spending, income),
    investment_rate: rate(invested, income),
  };
}

/** Change between the last snapshot before the month and the last snapshot inside it. */
function netWorthChange(conn, { from, to }) {
  const end = conn.prepare(
    'SELECT net_worth FROM snapshots WHERE snapshot_date BETWEEN ? AND ? ORDER BY snapshot_date DESC, id DESC LIMIT 1'
  ).get(from, to);
  const start = conn.prepare(
    'SELECT net_worth FROM snapshots WHERE snapshot_date < ? ORDER BY snapshot_date DESC, id DESC LIMIT 1'
  ).get(from);
  return end && start ? round2(end.net_worth - start.net_worth) : null;
}

// ─── GET /api/expenses/summary ────────────────────────────────────────────────

router.get('/summary', (req, res) => {
  const month = req.query.month || today().slice(0, 7);
  if (!MONTH_RE.test(month)) return res.status(400).json({ error: 'month must be YYYY-MM' });
  const member = req.query.member ? normalizeFamilyMember(req.query.member) : null;
  const conn = db.getDb();
  const range = monthRange(month);
  const rows = loadTransactions(conn, range, member);

  const byCategory = new Map();
  for (const r of rows) {
    if (r.kind !== 'expense') continue;
    const c = r.category || 'Other';
    byCategory.set(c, (byCategory.get(c) || 0) + r.amount);
  }
  // Money that left an account without counting as spending (the bank side of each pair).
  const excluded = rows.filter((r) => EXCLUDED_KINDS.includes(r.kind) && r.direction === 'debit');

  res.json({
    month,
    member,
    ...aggregate(rows),
    by_category: [...byCategory.entries()]
      .map(([category, amount]) => ({ category, amount: round2(amount) }))
      .sort((a, b) => b.amount - a.amount),
    excluded: {
      total: round2(excluded.reduce((s, r) => s + r.amount, 0)),
      matched_count: excluded.filter((r) => r.matched_txn_id).length,
      unmatched_count: excluded.filter((r) => !r.matched_txn_id).length,
    },
    needs_review_count: rows.filter((r) => r.needs_review).length,
    // Snapshots are household-wide, so a per-member change is not meaningful.
    net_worth_change: member ? null : netWorthChange(conn, range),
  });
});

// ─── GET /api/expenses/trend ──────────────────────────────────────────────────

router.get('/trend', (req, res) => {
  const end = req.query.end || today().slice(0, 7);
  if (!MONTH_RE.test(end)) return res.status(400).json({ error: 'end must be YYYY-MM' });
  const count = Math.min(Math.max(parseInt(req.query.months, 10) || 12, 1), 36);
  const months = Array.from({ length: count }, (_, i) => addMonths(end, i - count + 1));
  const rows = loadTransactions(db.getDb(), { from: `${months[0]}-01`, to: monthRange(end).to }, req.query.member);

  res.json({
    months: months.map((month) => {
      const a = aggregate(rows.filter((r) => r.txn_date.startsWith(month)));
      return { month, income: a.income, spending: a.spending, invested: a.invested, savings_rate: a.savings_rate };
    }),
  });
});

// ─── GET /api/expenses/transactions ───────────────────────────────────────────

router.get('/transactions', (req, res) => {
  const { month, kind, category, member, needs_review: needsReview } = req.query;
  if (month && !MONTH_RE.test(month)) return res.status(400).json({ error: 'month must be YYYY-MM' });
  const range = month ? monthRange(month) : { from: '0000-01-01', to: '9999-12-31' };
  let rows = loadTransactions(db.getDb(), range, member);
  if (kind) rows = rows.filter((r) => r.kind === kind);
  if (category) rows = rows.filter((r) => r.category === category);
  if (needsReview === '1' || needsReview === 'true') rows = rows.filter((r) => r.needs_review);
  res.json(rows);
});

// ─── PUT /api/expenses/transactions/:id ───────────────────────────────────────

router.put('/transactions/:id', (req, res) => {
  const conn = db.getDb();
  const existing = conn.prepare('SELECT * FROM transactions WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Transaction not found' });
  const { kind, category, remember = true } = req.body || {};
  if (kind !== undefined && !KINDS.includes(kind)) {
    return res.status(400).json({ error: `kind must be one of: ${KINDS.join(', ')}` });
  }

  const newKind = kind !== undefined ? kind : existing.kind;
  const newCategory = EXCLUDED_KINDS.includes(newKind)
    ? null
    : (category !== undefined ? (category || null) : existing.category);

  conn.transaction(() => {
    conn.prepare(
      `UPDATE transactions
          SET kind = ?, category = ?, needs_review = 0,
              kind_locked = CASE WHEN ? = 1 THEN 1 ELSE kind_locked END,
              updated_at = datetime('now')
        WHERE id = ?`
    ).run(newKind, newCategory, kind !== undefined ? 1 : 0, existing.id);

    // A row that is no longer a card payment/transfer releases its partner for review.
    if (existing.matched_txn_id && !EXCLUDED_KINDS.includes(newKind)) {
      conn.prepare(`UPDATE transactions SET matched_txn_id = NULL, needs_review = 1, updated_at = datetime('now') WHERE id = ?`)
        .run(existing.matched_txn_id);
      conn.prepare('UPDATE transactions SET matched_txn_id = NULL WHERE id = ?').run(existing.id);
    }
    if (remember && existing.merchant_key) {
      conn.prepare(UPSERT_RULE_SQL).run(existing.merchant_key, newKind, newCategory);
    }
  })();

  res.json(withMember(conn.prepare(`${TXN_SELECT} WHERE t.id = ?`).get(existing.id)));
});

// ─── Statements ───────────────────────────────────────────────────────────────

router.get('/statements', (req, res) => {
  res.json(db.getDb().prepare(
    `SELECT s.*, COALESCE(a.name, l.name) AS source_name,
            (SELECT COUNT(*) FROM transactions t WHERE t.statement_id = s.id) AS transaction_count
       FROM expense_statements s
       LEFT JOIN accounts a    ON s.source_type = 'account'   AND a.id = s.source_id
       LEFT JOIN liabilities l ON s.source_type = 'liability' AND l.id = s.source_id
      ORDER BY s.period_end DESC, s.id DESC`
  ).all());
});

router.delete('/statements/:id', (req, res) => {
  const conn = db.getDb();
  const id = Number(req.params.id);
  if (!conn.prepare('SELECT id FROM expense_statements WHERE id = ?').get(id)) {
    return res.status(404).json({ error: 'Statement not found' });
  }
  conn.transaction(() => {
    // Partners in other statements lose their pair (FK ON DELETE SET NULL); flag them for a look.
    conn.prepare(
      `UPDATE transactions SET needs_review = 1, updated_at = datetime('now')
        WHERE statement_id != ?
          AND id IN (SELECT matched_txn_id FROM transactions WHERE statement_id = ? AND matched_txn_id IS NOT NULL)`
    ).run(id, id);
    conn.prepare('DELETE FROM expense_statements WHERE id = ?').run(id);
  })();
  res.json({ message: 'Statement deleted' });
});

// ─── Rules and categories ─────────────────────────────────────────────────────

router.get('/rules', (req, res) => {
  res.json(db.getDb().prepare('SELECT * FROM merchant_rules ORDER BY merchant_key').all());
});

router.delete('/rules/:id', (req, res) => {
  const r = db.getDb().prepare('DELETE FROM merchant_rules WHERE id = ?').run(req.params.id);
  if (!r.changes) return res.status(404).json({ error: 'Rule not found' });
  res.json({ message: 'Rule deleted' });
});

router.get('/categories', (req, res) => {
  const used = db.getDb().prepare(
    'SELECT DISTINCT category FROM transactions WHERE category IS NOT NULL ORDER BY category'
  ).all().map((r) => r.category);
  res.json([...new Set([...DEFAULT_CATEGORIES, ...used])]);
});
```

- [ ] **Step 4: Run to verify pass**

Run: `cd backend && npm test`
Expected: all suites pass.

- [ ] **Step 5: Commit**

```bash
git add backend/src/routes/expenses.js backend/tests/expenses.test.js
git commit -m "Add expense summary, trend, transaction editing and statement endpoints

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Export / import the expense tables

**Files:**
- Modify: `backend/src/routes/exportRoutes.js` (requires, `GET /` payload, `POST /import` stats and a new section 9)
- Test: `backend/tests/expenses.test.js`

**Interfaces:**
- Consumes: `KINDS`, `merchantKey`, `computeDedupeKeys` (Task 3); existing `accountIdMap`, `liabilityIdMap` in the import handler
- Produces: export `data.expense_statements`, `data.transactions`, `data.merchant_rules`; import stats keys of the same names. `EXPORT_SCHEMA_VERSION` stays `3`.

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/expenses.test.js`:

```js
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
```

- [ ] **Step 2: Run to verify failure**

Run: `cd backend && NODE_OPTIONS=--experimental-vm-modules npx jest tests/expenses.test.js -t "Export / import"`
Expected: FAIL — `data.expense_statements` is undefined.

- [ ] **Step 3: Implement**

In `backend/src/routes/exportRoutes.js`:

1. After `const db = require('../db/database');` add:

```js
const { KINDS, merchantKey, computeDedupeKeys } = require('../utils/transactionClassifier');
```

2. In `GET /`, inside `data: { ... }` after the `value_history:` line add:

```js
        expense_statements: conn.prepare('SELECT * FROM expense_statements ORDER BY id').all(),
        transactions:     conn.prepare('SELECT * FROM transactions ORDER BY id').all(),
        merchant_rules:   conn.prepare('SELECT * FROM merchant_rules ORDER BY id').all(),
```

3. In `POST /import`, add to the `stats` object after `value_history`:

```js
    expense_statements: { imported: 0, skipped: 0 },
    transactions:       { imported: 0, skipped: 0 },
    merchant_rules:     { imported: 0, skipped: 0 },
```

4. Inside `conn.transaction(() => { ... })`, after the `// ── 8. Value history` loop, add:

```js
    // ── 9. Expense statements, transactions and merchant rules ──────────────
    const sourceIdMaps = { account: accountIdMap, liability: liabilityIdMap };
    const statementIdMap = {};
    const findStatement = conn.prepare(
      `SELECT id FROM expense_statements
        WHERE source_type = ? AND source_id = ?
          AND coalesce(period_start,'') = coalesce(?,'') AND coalesce(period_end,'') = coalesce(?,'')
          AND coalesce(file_name,'') = coalesce(?,'')`
    );
    const insertStatement = conn.prepare(
      `INSERT INTO expense_statements
         (source_type, source_id, statement_type, file_name, last4, period_start, period_end,
          opening_balance, closing_balance, parse_method, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')))`
    );
    for (const row of (data.expense_statements || [])) {
      const newSourceId = sourceIdMaps[row.source_type] && sourceIdMaps[row.source_type][row.source_id];
      if (!newSourceId) { stats.expense_statements.skipped++; continue; }
      const existing = findStatement.get(row.source_type, newSourceId,
        row.period_start || null, row.period_end || null, row.file_name || null);
      if (existing) {
        statementIdMap[row.id] = existing.id;
        stats.expense_statements.skipped++;
        continue;
      }
      const result = insertStatement.run(
        row.source_type, newSourceId, row.statement_type === 'credit_card' ? 'credit_card' : 'bank',
        row.file_name || null, row.last4 || null, row.period_start || null, row.period_end || null,
        row.opening_balance != null ? Number(row.opening_balance) : null,
        row.closing_balance != null ? Number(row.closing_balance) : null,
        row.parse_method || null, row.created_at || null
      );
      statementIdMap[row.id] = result.lastInsertRowid;
      stats.expense_statements.imported++;
    }

    const txnIdMap = {};
    const insertTxn = conn.prepare(
      `INSERT OR IGNORE INTO transactions
         (statement_id, source_type, source_id, txn_date, description, merchant, merchant_key, amount,
          direction, kind, category, needs_review, kind_locked, dedupe_key, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')), COALESCE(?, datetime('now')))`
    );
    const findTxnByKey = conn.prepare('SELECT id FROM transactions WHERE dedupe_key = ?');
    const getStatement = conn.prepare('SELECT source_type, source_id FROM expense_statements WHERE id = ?');
    const txnsByStatement = new Map();
    for (const row of (data.transactions || [])) {
      if (!txnsByStatement.has(row.statement_id)) txnsByStatement.set(row.statement_id, []);
      txnsByStatement.get(row.statement_id).push(row);
    }
    for (const [oldStatementId, rows] of txnsByStatement) {
      const newStatementId = statementIdMap[oldStatementId];
      if (!newStatementId) { stats.transactions.skipped += rows.length; continue; }
      const target = getStatement.get(newStatementId);
      rows.sort((a, b) => a.id - b.id);
      // Dedupe keys embed the source id: keep them when the source kept its id,
      // otherwise recompute them for the new id.
      const recomputed = computeDedupeKeys(
        rows.map((r) => ({ ...r, date: r.txn_date, merchant_key: r.merchant_key || merchantKey(r.description) })),
        target.source_type, target.source_id
      );
      recomputed.forEach((r, i) => {
        const original = rows[i];
        if (!KINDS.includes(original.kind) || !original.txn_date || !(Number(original.amount) > 0)) {
          stats.transactions.skipped++;
          return;
        }
        const sameSource = original.source_type === target.source_type && original.source_id === target.source_id;
        const dedupeKey = sameSource && original.dedupe_key ? original.dedupe_key : r.dedupe_key;
        const result = insertTxn.run(
          newStatementId, target.source_type, target.source_id, original.txn_date, String(original.description || ''),
          original.merchant || null, r.merchant_key, Number(original.amount), original.direction === 'credit' ? 'credit' : 'debit',
          original.kind, original.category || null, original.needs_review ? 1 : 0, original.kind_locked ? 1 : 0,
          dedupeKey, original.created_at || null, original.updated_at || null
        );
        if (result.changes) {
          txnIdMap[original.id] = result.lastInsertRowid;
          stats.transactions.imported++;
        } else {
          const existing = findTxnByKey.get(dedupeKey);
          if (existing) txnIdMap[original.id] = existing.id;
          stats.transactions.skipped++;
        }
      });
    }
    const setMatch = conn.prepare('UPDATE transactions SET matched_txn_id = ? WHERE id = ? AND matched_txn_id IS NULL');
    for (const row of (data.transactions || [])) {
      if (!row.matched_txn_id) continue;
      const self = txnIdMap[row.id];
      const partner = txnIdMap[row.matched_txn_id];
      if (self && partner) setMatch.run(partner, self);
    }

    const insertRule = conn.prepare(
      `INSERT OR IGNORE INTO merchant_rules (merchant_key, kind, category, created_at, updated_at)
       VALUES (?, ?, ?, COALESCE(?, datetime('now')), COALESCE(?, datetime('now')))`
    );
    for (const row of (data.merchant_rules || [])) {
      if (!row.merchant_key || !KINDS.includes(row.kind)) { stats.merchant_rules.skipped++; continue; }
      const result = insertRule.run(String(row.merchant_key), row.kind, row.category || null,
        row.created_at || null, row.updated_at || null);
      if (result.changes) stats.merchant_rules.imported++;
      else stats.merchant_rules.skipped++;
    }
```

- [ ] **Step 4: Run to verify pass**

Run: `cd backend && npm test`
Expected: all suites pass (the existing export tests are in `api.test.js` and must still pass).

- [ ] **Step 5: Commit**

```bash
git add backend/src/routes/exportRoutes.js backend/tests/expenses.test.js
git commit -m "Include expense data in full export and import

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 11: Frontend API client, Android stubs, shared constants, styles and the Upload tab

The frontend has no unit-test framework. For every frontend task the check is: **lint the new or changed files clean** (`src/hooks/localApi.js` already has one error before this work, `'importType' is defined but never used` in `parseText`; leave it alone) plus `npm run build`, and in Task 13 a manual browser check.

**Files:**
- Modify: `frontend/src/hooks/api.js` (helpers above `export const api`, methods at the end of the object)
- Modify: `frontend/src/hooks/localApi.js` (stub constant above `export const api`, stubs at the end of the object)
- Modify: `frontend/src/index.css` (append)
- Create: `frontend/src/components/expenses/constants.js`
- Create: `frontend/src/components/expenses/ExpenseUpload.jsx`

**Interfaces:**
- Consumes: Task 8/9 endpoints
- Produces:
  - `api.previewExpenseStatement(file, { sourceType, sourceId, password }) → Promise<previewBody>` (rejects with `err.code` preserved, e.g. `'PASSWORD_REQUIRED'`)
  - `api.commitExpenseStatement(payload) → Promise<commitBody>` (rejects with `err.code === 'STALE_BALANCE'` on 409)
  - `api.getExpenseSummary(month, member)`, `api.getExpenseTrend(months, member, end)`, `api.getExpenseTransactions(filters)`, `api.updateExpenseTransaction(id, data)`, `api.getExpenseStatements()`, `api.deleteExpenseStatement(id)`, `api.getExpenseCategories()`, `api.getMerchantRules()`, `api.deleteMerchantRule(id)`
  - `constants.js`: `KIND_OPTIONS`, `KIND_LABELS`, `EXCLUDED_KINDS`, `SERIES_COLORS`, `currentMonth()`, `formatMonth(month)`, `formatRate(rate)`
  - `<ExpenseUpload onViewTransactions={(month: 'YYYY-MM') => void} />`
  - CSS classes: `tab-bar`, `tab-btn`, `badge-review`, `badge-excluded`, `badge-duplicate`, `row-duplicate`, `row-review`, `muted-note`, `filter-row`, `stat-hint`, `cell-select`

- [ ] **Step 1: API client**

In `frontend/src/hooks/api.js`, insert immediately above `export const api = {`:

```js
/** Build a query string, dropping empty values. */
function qs(params = {}) {
  return new URLSearchParams(
    Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '')
  ).toString();
}

/** Like apiFetch, but keeps the server's error `code` (PASSWORD_REQUIRED, STALE_BALANCE). */
async function fetchWithCode(path, options) {
  const res = await fetch(`${API_BASE}${path}`, options);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const err = new Error(body.error || `Request failed: ${res.status}`);
    err.code = body.code;
    throw err;
  }
  return res.json();
}
```

and add these entries at the end of the `api` object, after the `importFullData` entry and before the closing `};`:

```js
  // Expenses
  previewExpenseStatement: (file, { sourceType, sourceId, password }) => {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('source_type', sourceType);
    formData.append('source_id', String(sourceId));
    if (password) formData.append('password', password);
    return fetchWithCode('/expenses/preview', { method: 'POST', body: formData });
  },
  commitExpenseStatement: (payload) => fetchWithCode('/expenses/commit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }),
  getExpenseSummary: (month, member) => apiFetch(`/expenses/summary?${qs({ month, member })}`),
  getExpenseTrend: (months, member, end) => apiFetch(`/expenses/trend?${qs({ months, member, end })}`),
  getExpenseTransactions: (filters) => apiFetch(`/expenses/transactions?${qs(filters)}`),
  updateExpenseTransaction: (id, data) => apiFetch(`/expenses/transactions/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  getExpenseStatements: () => apiFetch('/expenses/statements'),
  deleteExpenseStatement: (id) => apiFetch(`/expenses/statements/${id}`, { method: 'DELETE' }),
  getExpenseCategories: () => apiFetch('/expenses/categories'),
  getMerchantRules: () => apiFetch('/expenses/rules'),
  deleteMerchantRule: (id) => apiFetch(`/expenses/rules/${id}`, { method: 'DELETE' }),
```

- [ ] **Step 2: Android stubs**

In `frontend/src/hooks/localApi.js`, insert immediately above `export const api = {`:

```js
const expensesUnavailable = () => Promise.reject(new Error('Expenses is available in the web version'));
```

and add at the end of the `api` object, after the `importFullData` entry:

```js
  // ─── Expenses (web only: needs the REST backend's statement parser) ─────
  previewExpenseStatement: expensesUnavailable,
  commitExpenseStatement: expensesUnavailable,
  getExpenseSummary: expensesUnavailable,
  getExpenseTrend: expensesUnavailable,
  getExpenseTransactions: expensesUnavailable,
  updateExpenseTransaction: expensesUnavailable,
  getExpenseStatements: expensesUnavailable,
  deleteExpenseStatement: expensesUnavailable,
  getExpenseCategories: expensesUnavailable,
  getMerchantRules: expensesUnavailable,
  deleteMerchantRule: expensesUnavailable,
```

- [ ] **Step 3: Styles**

Append to `frontend/src/index.css`:

```css
/* ─── Expenses ───────────────────────────────────────────────────────────── */
.tab-bar { display: flex; gap: 4px; border-bottom: 1px solid var(--color-border); margin-bottom: 20px; overflow-x: auto; }
.tab-btn { background: transparent; color: var(--color-text-muted); border-radius: 0; padding: 8px 16px; border-bottom: 2px solid transparent; font-weight: 600; white-space: nowrap; }
.tab-btn:hover { color: var(--color-text); }
.tab-btn.active { color: var(--color-primary); border-bottom-color: var(--color-primary); }
.badge-review    { background: #fff4e5; color: #8a4b00; }
.badge-excluded  { background: #eceff1; color: #37474f; }
.badge-duplicate { background: #f3f4f6; color: #6a737d; }
.row-duplicate td { opacity: .5; }
.row-review td:first-child { box-shadow: inset 3px 0 0 var(--color-warning); }
.muted-note { font-size: 13px; color: var(--color-text-muted); }
.filter-row { display: flex; gap: 12px; flex-wrap: wrap; align-items: flex-end; margin-bottom: 16px; }
.filter-row .form-group { min-width: 150px; }
.stat-hint { font-size: 11px; color: var(--color-text-muted); margin-top: 4px; }
.cell-select { min-width: 130px; font-size: 12px; padding: 4px 6px; }
```

- [ ] **Step 4: Shared constants**

Create `frontend/src/components/expenses/constants.js`:

```js
/** Shared constants and helpers for the Expenses page. */

export const KIND_OPTIONS = [
  { value: 'expense', label: 'Expense' },
  { value: 'refund', label: 'Refund' },
  { value: 'income', label: 'Income' },
  { value: 'investment', label: 'Investment' },
  { value: 'cc_payment', label: 'Card payment (excluded)' },
  { value: 'transfer', label: 'Own transfer (excluded)' },
];

export const KIND_LABELS = Object.fromEntries(KIND_OPTIONS.map((k) => [k.value, k.label]));

// Never counted in income, spending or invested totals.
export const EXCLUDED_KINDS = ['cc_payment', 'transfer'];

// Categorical slots 1–3 and 7 of the dataviz reference palette (validator: all-pairs PASS on white).
export const SERIES_COLORS = {
  income: '#2a78d6',
  spending: '#eb6834',
  invested: '#1baf7a',
  savingsRate: '#4a3aa7',
};

export function currentMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export function formatMonth(month) {
  const [y, m] = month.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
}

export const formatRate = (rate) => (rate == null ? '—' : `${Math.round(rate * 100)}%`);
```

- [ ] **Step 5: Upload tab**

Create `frontend/src/components/expenses/ExpenseUpload.jsx`:

```jsx
import { useEffect, useState } from 'react';
import { api } from '../../hooks/apiAdapter';
import { formatCurrency, formatDate } from '../../hooks/format';
import { useCurrency } from '../../hooks/CurrencyContext';
import { KIND_OPTIONS, EXCLUDED_KINDS } from './constants';

const NEW_SOURCE = '__new_source__';
const NEW_CATEGORY = '__new_category__';
const EMPTY_SOURCE = { kind: 'account', name: '', institution: '', family_member: 'Self' };

// Rows that need a look come first, then by date.
function sortForReview(rows) {
  return [...rows].sort((a, b) => (Number(b.needs_review) - Number(a.needs_review)) || a.date.localeCompare(b.date));
}

export default function ExpenseUpload({ onViewTransactions }) {
  const [accounts, setAccounts] = useState([]);
  const [cards, setCards] = useState([]);
  const [categories, setCategories] = useState([]);
  const [reloadKey, setReloadKey] = useState(0);
  const [sourceKey, setSourceKey] = useState('');
  const [newSource, setNewSource] = useState(null);
  const [file, setFile] = useState(null);
  const [fileInputKey, setFileInputKey] = useState(0);
  const [password, setPassword] = useState('');
  const [preview, setPreview] = useState(null);
  const [rows, setRows] = useState([]);
  const [updateBalance, setUpdateBalance] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(null);
  const { currency } = useCurrency();
  const fmt = (v) => formatCurrency(v, currency);

  useEffect(() => {
    let cancelled = false;
    Promise.all([api.getAccounts(), api.getLiabilities(), api.getExpenseCategories()])
      .then(([accs, liabs, cats]) => {
        if (cancelled) return;
        setAccounts(accs);
        setCards(liabs.filter((l) => l.type === 'credit_card'));
        setCategories(cats);
      })
      .catch((e) => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, [reloadKey]);

  function sourceName(key) {
    const [type, id] = key.split(':');
    const list = type === 'account' ? accounts : cards;
    return list.find((s) => String(s.id) === id)?.name || '';
  }

  function chooseSource(value) {
    if (value === NEW_SOURCE) {
      setNewSource({ ...EMPTY_SOURCE });
      return;
    }
    setSourceKey(value);
  }

  async function createSource() {
    const name = newSource.name.trim();
    if (!name) { setError('Name is required'); return; }
    try {
      setError('');
      const created = newSource.kind === 'account'
        ? await api.createAccount({ name, institution: newSource.institution || null, type: 'savings', balance: 0, family_member: newSource.family_member })
        : await api.createLiability({ name, lender: newSource.institution || null, type: 'credit_card', current_balance: 0, family_member: newSource.family_member });
      setSourceKey(`${newSource.kind}:${created.id}`);
      setNewSource(null);
      setReloadKey((k) => k + 1);
    } catch (e) {
      setError(e.message);
    }
  }

  async function runPreview() {
    if (!file || !sourceKey) {
      setError('Choose a statement file and the account or card it belongs to.');
      return;
    }
    const [sourceType, sourceId] = sourceKey.split(':');
    setBusy(true);
    setError('');
    setSaved(null);
    setPreview(null);
    try {
      const p = await api.previewExpenseStatement(file, { sourceType, sourceId, password });
      setPreview({ ...p, sourceType, sourceId: Number(sourceId), sourceName: sourceName(sourceKey) });
      setRows(sortForReview(p.transactions).map((t) => ({ ...t, edited: false, remember: true })));
      setUpdateBalance(Boolean(p.balance_update?.default_checked));
    } catch (e) {
      setError(e.code === 'PASSWORD_REQUIRED' ? `🔒 ${e.message}` : e.message);
    } finally {
      setBusy(false);
    }
  }

  function updateRow(key, patch) {
    setRows((current) => current.map((r) => {
      if (r.dedupe_key !== key) return r;
      const next = { ...r, ...patch, edited: true, needs_review: false };
      if (EXCLUDED_KINDS.includes(next.kind)) next.category = null;
      else if (next.kind === 'expense' && !next.category) next.category = 'Other';
      return next;
    }));
  }

  function chooseCategory(key, value) {
    if (value !== NEW_CATEGORY) {
      updateRow(key, { category: value || null });
      return;
    }
    const name = (window.prompt('New category name') || '').trim();
    if (!name) return;
    setCategories((cs) => (cs.includes(name) ? cs : [...cs, name]));
    updateRow(key, { category: name });
  }

  function setRemember(key, remember) {
    setRows((current) => current.map((r) => (r.dedupe_key === key ? { ...r, remember } : r)));
  }

  async function save(force = false) {
    const toSave = rows.filter((r) => !r.duplicate);
    if (toSave.length === 0) {
      setError('Every transaction in this statement is already saved.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const result = await api.commitExpenseStatement({
        source_type: preview.sourceType,
        source_id: preview.sourceId,
        statement: { ...preview.statement, parse_method: preview.method },
        transactions: toSave.map(({ date, description, merchant, amount, direction, kind, category, needs_review, edited, remember }) =>
          ({ date, description, merchant, amount, direction, kind, category, needs_review, edited, remember })),
        update_balance: updateBalance,
        force_balance: force,
      });
      setSaved({ ...result, month: (preview.statement.period_end || toSave[0].date).slice(0, 7) });
      setPreview(null);
      setRows([]);
      setFile(null);
      setFileInputKey((k) => k + 1);
      setPassword('');
    } catch (e) {
      if (e.code === 'STALE_BALANCE' && !force && window.confirm(`${e.message}\n\nUpdate the balance anyway?`)) {
        await save(true);
        return;
      }
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  const saveable = rows.filter((r) => !r.duplicate);
  const sumKind = (kind) => saveable.filter((r) => r.kind === kind).reduce((s, r) => s + r.amount, 0);
  const spending = sumKind('expense') - sumKind('refund');
  const excludedCount = saveable.filter((r) => EXCLUDED_KINDS.includes(r.kind)).length;
  const reviewCount = saveable.filter((r) => r.needs_review).length;
  const duplicateCount = rows.length - saveable.length;
  const matched = saved ? saved.matches.card_payments + saved.matches.promoted : 0;

  return (
    <div>
      {error && <div className="error-msg">{error}</div>}
      {saved && (
        <div className="success-msg flex-gap" style={{ justifyContent: 'space-between' }}>
          <span>
            Saved {saved.inserted} transactions
            {saved.duplicates ? ` · ${saved.duplicates} already saved` : ''}
            {saved.rules_learned ? ` · ${saved.rules_learned} merchant rules learned` : ''}
            {matched ? ` · ${matched} card payments matched` : ''}
            {saved.matches.transfers ? ` · ${saved.matches.transfers} transfers matched` : ''}
            {saved.balance_updated ? ' · balance updated' : ''}
          </span>
          <button className="btn-ghost btn-sm" onClick={() => onViewTransactions(saved.month)}>View transactions</button>
        </div>
      )}

      <div className="card mb-4">
        <div className="section-title">Upload a statement</div>
        <div className="form-row">
          <div className="form-group">
            <label>Statement belongs to *</label>
            <select value={sourceKey} onChange={(e) => chooseSource(e.target.value)}>
              <option value="">Choose the account or card…</option>
              <optgroup label="Bank accounts">
                {accounts.map((a) => (
                  <option key={`account-${a.id}`} value={`account:${a.id}`}>{a.name}{a.institution ? ` · ${a.institution}` : ''}</option>
                ))}
              </optgroup>
              <optgroup label="Credit cards">
                {cards.map((c) => (
                  <option key={`card-${c.id}`} value={`liability:${c.id}`}>{c.name}{c.lender ? ` · ${c.lender}` : ''}</option>
                ))}
              </optgroup>
              <option value={NEW_SOURCE}>＋ Add a new account or card…</option>
            </select>
          </div>
          <div className="form-group">
            <label>Statement file (PDF or CSV) *</label>
            <input
              key={fileInputKey}
              type="file"
              accept=".pdf,.csv,application/pdf,text/csv"
              onChange={(e) => setFile(e.target.files?.[0] || null)}
            />
          </div>
          <div className="form-group">
            <label>PDF password</label>
            <input
              type="password"
              autoComplete="off"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Leave blank if not protected"
            />
          </div>
        </div>

        {newSource && (
          <div className="card mb-4" style={{ background: 'var(--color-surface-2)' }}>
            <div className="form-row">
              <div className="form-group">
                <label>Type</label>
                <select value={newSource.kind} onChange={(e) => setNewSource({ ...newSource, kind: e.target.value })}>
                  <option value="account">Bank account</option>
                  <option value="liability">Credit card</option>
                </select>
              </div>
              <div className="form-group">
                <label>Name *</label>
                <input
                  value={newSource.name}
                  onChange={(e) => setNewSource({ ...newSource, name: e.target.value })}
                  placeholder={newSource.kind === 'account' ? 'HDFC Savings' : 'HDFC Regalia'}
                />
              </div>
              <div className="form-group">
                <label>{newSource.kind === 'account' ? 'Bank' : 'Card issuer'}</label>
                <input value={newSource.institution} onChange={(e) => setNewSource({ ...newSource, institution: e.target.value })} />
              </div>
              <div className="form-group">
                <label>Family member</label>
                <input
                  value={newSource.family_member}
                  onChange={(e) => setNewSource({ ...newSource, family_member: e.target.value })}
                  placeholder="Self / Spouse / Child"
                />
              </div>
            </div>
            <div className="flex-gap">
              <button className="btn-primary btn-sm" onClick={createSource}>Create</button>
              <button className="btn-ghost btn-sm" onClick={() => setNewSource(null)}>Cancel</button>
            </div>
          </div>
        )}

        <button className="btn-primary" disabled={busy || !file || !sourceKey} onClick={runPreview}>
          {busy && !preview ? 'Reading statement…' : 'Preview transactions'}
        </button>
      </div>

      {preview && (
        <div className="card">
          <div className="section-title">Review before saving</div>
          <p className="muted-note mb-4">
            {preview.statement.statement_type === 'credit_card' ? 'Credit card statement' : 'Bank statement'} · {preview.sourceName}
            {preview.statement.last4 ? ` ··${preview.statement.last4}` : ''}
            {preview.statement.period_start ? ` · ${formatDate(preview.statement.period_start)} – ${formatDate(preview.statement.period_end)}` : ''}
            {` · read by ${preview.method === 'ai' ? 'AI' : 'pattern rules'}`}
          </p>
          {preview.validation_notes.length > 0 && (
            <ul className="muted-note mb-4" style={{ paddingLeft: 18 }}>
              {preview.validation_notes.map((note, i) => <li key={i}>{note}</li>)}
            </ul>
          )}

          <div className="table-container" style={{ maxHeight: 480, overflowY: 'auto' }}>
            <table>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Description</th>
                  <th style={{ textAlign: 'right' }}>Amount</th>
                  <th>Kind</th>
                  <th>Category</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const excluded = EXCLUDED_KINDS.includes(r.kind);
                  const options = r.category && !categories.includes(r.category) ? [...categories, r.category] : categories;
                  return (
                    <tr key={r.dedupe_key} className={r.duplicate ? 'row-duplicate' : r.needs_review ? 'row-review' : ''}>
                      <td>{formatDate(r.date)}</td>
                      <td>
                        <div>{r.merchant || r.description}</div>
                        {r.merchant && <div className="muted-note" style={{ fontSize: 11 }}>{r.description}</div>}
                        <div className="flex-gap" style={{ marginTop: 2 }}>
                          {r.duplicate && <span className="badge badge-duplicate">Already saved</span>}
                          {!r.duplicate && r.needs_review && <span className="badge badge-review">⚠ Check</span>}
                          {excluded && (
                            <span className="badge badge-excluded">Excluded · {r.kind === 'cc_payment' ? 'card payment' : 'own transfer'}</span>
                          )}
                        </div>
                      </td>
                      <td style={{ textAlign: 'right' }} className={`amount${r.direction === 'credit' ? ' positive' : ''}`}>
                        {r.direction === 'credit' ? '+' : '−'}{fmt(r.amount)}
                      </td>
                      <td>
                        <select
                          className="cell-select"
                          value={r.kind}
                          disabled={r.duplicate}
                          onChange={(e) => updateRow(r.dedupe_key, { kind: e.target.value })}
                        >
                          {KIND_OPTIONS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
                        </select>
                      </td>
                      <td>
                        <select
                          className="cell-select"
                          value={r.category || ''}
                          disabled={r.duplicate || excluded}
                          onChange={(e) => chooseCategory(r.dedupe_key, e.target.value)}
                        >
                          <option value="">—</option>
                          {options.map((c) => <option key={c} value={c}>{c}</option>)}
                          <option value={NEW_CATEGORY}>＋ New category…</option>
                        </select>
                        {r.edited && !r.duplicate && (
                          <label className="muted-note flex-gap" style={{ marginTop: 4 }}>
                            <input type="checkbox" checked={r.remember} onChange={(e) => setRemember(r.dedupe_key, e.target.checked)} />
                            Remember for this merchant
                          </label>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {preview.balance_update.eligible && (
            <label className="flex-gap" style={{ margin: '16px 0 8px' }}>
              <input type="checkbox" checked={updateBalance} onChange={(e) => setUpdateBalance(e.target.checked)} />
              <span>
                Update {preview.sourceName} {preview.balance_update.entity_type === 'liability' ? 'outstanding balance' : 'balance'}:{' '}
                {fmt(preview.balance_update.current)} → <strong>{fmt(preview.balance_update.proposed)}</strong> (statement closing balance)
              </span>
            </label>
          )}

          <p className="muted-note" style={{ marginTop: 8 }}>
            {saveable.length} to save
            {duplicateCount ? ` · ${duplicateCount} already saved` : ''}
            {` · spending ${fmt(spending)}`}
            {excludedCount ? ` · ${excludedCount} card payments/transfers excluded` : ''}
            {reviewCount ? ` · ${reviewCount} to check` : ''}
          </p>
          <div className="modal-actions">
            <button className="btn-ghost" onClick={() => { setPreview(null); setRows([]); }}>Discard</button>
            <button className="btn-primary" disabled={busy || saveable.length === 0} onClick={() => save(false)}>
              {busy ? 'Saving…' : `Save ${saveable.length} transactions`}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 6: Lint and build**

Run: `cd frontend && npx eslint src/components/expenses src/hooks/api.js && npm run build`
Expected: eslint prints nothing; build ends with `✓ built`.
Run: `cd frontend && npx eslint src/hooks/localApi.js`
Expected: exactly the one existing `'importType' is defined but never used` error and nothing else.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/hooks/api.js frontend/src/hooks/localApi.js frontend/src/index.css frontend/src/components/expenses
git commit -m "Add expense API client and statement upload/review tab

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: Overview tab (KPIs, category chart, trend charts, table view)

**Files:**
- Create: `frontend/src/components/expenses/ExpenseOverview.jsx`

**Interfaces:**
- Consumes: `api.getExpenseSummary`, `api.getExpenseTrend`, `api.getNetWorth` (for the member list); `SERIES_COLORS`, `currentMonth`, `formatMonth`, `formatRate` (Task 11)
- Produces: `<ExpenseOverview onOpenTransactions={(filter: { month, member?, needs_review? }) => void} />`

Chart rules this component follows (from the dataviz guidance; do not change them): one y-axis per chart (savings rate is a separate line chart, never a second axis on the bar chart); fixed series colors from `SERIES_COLORS`; legend and label text use text colors, not series colors; 4 px rounded bar ends; 2 px line with 8 px dots; horizontal grid only; a "Show as table" toggle.

- [ ] **Step 1: Implement**

Create `frontend/src/components/expenses/ExpenseOverview.jsx`:

```jsx
import { useEffect, useState } from 'react';
import {
  BarChart, Bar, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, LabelList, ResponsiveContainer,
} from 'recharts';
import { api } from '../../hooks/apiAdapter';
import { formatCurrency } from '../../hooks/format';
import { useCurrency } from '../../hooks/CurrencyContext';
import { SERIES_COLORS, currentMonth, formatMonth, formatRate } from './constants';

const TREND_SERIES = [
  { key: 'income', label: 'Income', color: SERIES_COLORS.income },
  { key: 'spending', label: 'Spending', color: SERIES_COLORS.spending },
  { key: 'invested', label: 'Invested', color: SERIES_COLORS.invested },
];
const AXIS_TICK = { fontSize: 11, fill: 'var(--color-text-muted)' };
const legendText = (value) => <span style={{ color: 'var(--color-text)' }}>{value}</span>;

function Stat({ label, value, hint }) {
  return (
    <div className="card stat-card">
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      {hint && <div className="stat-hint">{hint}</div>}
    </div>
  );
}

export default function ExpenseOverview({ onOpenTransactions }) {
  const [month, setMonth] = useState(currentMonth());
  const [member, setMember] = useState('');
  const [members, setMembers] = useState([]);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [showTable, setShowTable] = useState(false);
  const { currency } = useCurrency();
  const fmt = (v) => formatCurrency(v, currency);
  const compact = (v) => new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(v);

  useEffect(() => {
    api.getNetWorth().then((nw) => setMembers((nw.members || []).map((m) => m.name))).catch(() => {});
  }, []);

  useEffect(() => {
    let cancelled = false;
    Promise.all([api.getExpenseSummary(month, member), api.getExpenseTrend(12, member, month)])
      .then(([summary, trend]) => {
        if (cancelled) return;
        setData({ summary, trend: trend.months });
        setError('');
      })
      .catch((e) => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, [month, member]);

  if (error) return <div className="error-msg">{error}</div>;
  if (!data) return <div className="loading-center"><div className="spinner" /></div>;

  const { summary, trend } = data;
  const trendRows = trend.map((m) => ({
    ...m,
    label: formatMonth(m.month),
    savings_pct: m.savings_rate == null ? null : Math.round(m.savings_rate * 100),
  }));
  const trendHasData = trend.some((m) => m.income || m.spending || m.invested);
  const saved = summary.income - summary.spending;

  return (
    <div>
      <div className="filter-row">
        <div className="form-group">
          <label>Month</label>
          <input type="month" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} />
        </div>
        <div className="form-group">
          <label>Family member</label>
          <select value={member} onChange={(e) => setMember(e.target.value)}>
            <option value="">All members</option>
            {members.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </div>
        {summary.needs_review_count > 0 && (
          <button className="btn-ghost btn-sm" onClick={() => onOpenTransactions({ month, member, needs_review: '1' })}>
            ⚠ {summary.needs_review_count} transactions to review
          </button>
        )}
      </div>

      <div className="card-grid">
        <Stat label="Income" value={fmt(summary.income)} />
        <Stat label="Spending" value={fmt(summary.spending)} hint={summary.refunds ? `after ${fmt(summary.refunds)} of refunds` : null} />
        <Stat
          label="Invested"
          value={fmt(summary.invested)}
          hint={summary.investment_rate != null ? `${formatRate(summary.investment_rate)} of income` : null}
        />
        <Stat
          label="Savings rate"
          value={formatRate(summary.savings_rate)}
          hint={summary.savings_rate == null ? 'No income this month' : `${fmt(saved)} not spent`}
        />
        <Stat
          label="Net worth change"
          value={summary.net_worth_change == null ? '—' : `${summary.net_worth_change >= 0 ? '+' : ''}${fmt(summary.net_worth_change)}`}
          hint={member
            ? 'Shown for all members only'
            : summary.net_worth_change == null ? 'Record a snapshot before and during the month on the Dashboard' : null}
        />
      </div>

      {summary.excluded.total > 0 && (
        <p className="muted-note mb-4">
          {fmt(summary.excluded.total)} of credit card bill payments and own-account transfers is not counted as spending
          {' '}({summary.excluded.matched_count} matched to a statement, {summary.excluded.unmatched_count} unmatched).
        </p>
      )}

      <div className="card mb-4">
        <div className="section-title">Spending by category · {formatMonth(month)}</div>
        {summary.by_category.length === 0 ? (
          <div className="empty-state">
            <div className="icon">💸</div>
            <p>No spending recorded for {formatMonth(month)}. Upload a bank or credit card statement to get started.</p>
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={summary.by_category.length * 32 + 24}>
            <BarChart data={summary.by_category} layout="vertical" margin={{ top: 4, right: 88, bottom: 4, left: 8 }}>
              <XAxis type="number" hide />
              <YAxis type="category" dataKey="category" width={130} tick={AXIS_TICK} axisLine={false} tickLine={false} />
              <Tooltip formatter={(v) => [fmt(v), 'Spent']} cursor={{ fill: 'var(--color-surface-2)' }} />
              <Bar dataKey="amount" fill={SERIES_COLORS.spending} radius={[0, 4, 4, 0]} barSize={16} isAnimationActive={false}>
                <LabelList dataKey="amount" position="right" formatter={(v) => fmt(v)} style={{ fontSize: 11, fill: 'var(--color-text)' }} />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>

      {trendHasData && (
        <div className="card">
          <div className="flex-gap" style={{ justifyContent: 'space-between', marginBottom: 8 }}>
            <div className="section-title" style={{ marginBottom: 0 }}>Last 12 months</div>
            <button className="btn-ghost btn-sm" onClick={() => setShowTable((v) => !v)}>
              {showTable ? 'Show charts' : 'Show as table'}
            </button>
          </div>

          {showTable ? (
            <div className="table-container">
              <table>
                <thead>
                  <tr>
                    <th>Month</th>
                    <th style={{ textAlign: 'right' }}>Income</th>
                    <th style={{ textAlign: 'right' }}>Spending</th>
                    <th style={{ textAlign: 'right' }}>Invested</th>
                    <th style={{ textAlign: 'right' }}>Savings rate</th>
                  </tr>
                </thead>
                <tbody>
                  {[...trend].reverse().map((m) => (
                    <tr key={m.month}>
                      <td>{formatMonth(m.month)}</td>
                      <td style={{ textAlign: 'right' }} className="amount">{fmt(m.income)}</td>
                      <td style={{ textAlign: 'right' }} className="amount">{fmt(m.spending)}</td>
                      <td style={{ textAlign: 'right' }} className="amount">{fmt(m.invested)}</td>
                      <td style={{ textAlign: 'right' }}>{formatRate(m.savings_rate)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <>
              <ResponsiveContainer width="100%" height={240}>
                <BarChart data={trendRows} margin={{ top: 8, right: 16, bottom: 0, left: 8 }} barGap={2} barCategoryGap="20%">
                  <CartesianGrid vertical={false} stroke="var(--color-border)" />
                  <XAxis dataKey="label" tick={AXIS_TICK} tickLine={false} axisLine={{ stroke: 'var(--color-border)' }} />
                  <YAxis tickFormatter={compact} tick={AXIS_TICK} tickLine={false} axisLine={false} width={48} />
                  <Tooltip formatter={(v, name) => [fmt(v), name]} cursor={{ fill: 'var(--color-surface-2)' }} />
                  <Legend formatter={legendText} wrapperStyle={{ fontSize: 12 }} />
                  {TREND_SERIES.map((s) => (
                    <Bar key={s.key} dataKey={s.key} name={s.label} fill={s.color} radius={[4, 4, 0, 0]} isAnimationActive={false} />
                  ))}
                </BarChart>
              </ResponsiveContainer>

              <div className="section-title" style={{ fontSize: 14, margin: '16px 0 4px' }}>Savings rate</div>
              <ResponsiveContainer width="100%" height={160}>
                <LineChart data={trendRows} margin={{ top: 8, right: 16, bottom: 0, left: 8 }}>
                  <CartesianGrid vertical={false} stroke="var(--color-border)" />
                  <XAxis dataKey="label" tick={AXIS_TICK} tickLine={false} axisLine={{ stroke: 'var(--color-border)' }} />
                  <YAxis tickFormatter={(v) => `${v}%`} tick={AXIS_TICK} tickLine={false} axisLine={false} width={48} />
                  <Tooltip formatter={(v) => [`${v}%`, 'Savings rate']} />
                  <Line
                    type="monotone"
                    dataKey="savings_pct"
                    name="Savings rate"
                    stroke={SERIES_COLORS.savingsRate}
                    strokeWidth={2}
                    dot={{ r: 4 }}
                    activeDot={{ r: 5 }}
                    connectNulls={false}
                    isAnimationActive={false}
                  />
                </LineChart>
              </ResponsiveContainer>
            </>
          )}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Lint**

Run: `cd frontend && npx eslint src/components/expenses`
Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/expenses/ExpenseOverview.jsx
git commit -m "Add expense overview with savings rate and category charts

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: Transactions tab, page shell and navigation

**Files:**
- Create: `frontend/src/components/expenses/ExpenseTransactions.jsx`
- Create: `frontend/src/pages/ExpensesPage.jsx`
- Modify: `frontend/src/App.jsx` (imports, `NAV_ITEMS`, visible-nav filter, `PAGES`, sidebar map)

**Interfaces:**
- Consumes: everything from Tasks 11–12
- Produces: `<ExpenseTransactions initialFilter={{ month?, member?, needs_review? }} />`; `ExpensesPage` default export; nav id `'expenses'`

- [ ] **Step 1: Transactions tab**

Create `frontend/src/components/expenses/ExpenseTransactions.jsx`:

```jsx
import { useEffect, useState } from 'react';
import { api } from '../../hooks/apiAdapter';
import { formatCurrency, formatDate } from '../../hooks/format';
import { useCurrency } from '../../hooks/CurrencyContext';
import { KIND_OPTIONS, KIND_LABELS, EXCLUDED_KINDS, currentMonth, formatMonth } from './constants';

const DEFAULT_FILTER = { month: '', kind: '', category: '', member: '', needs_review: '' };

export default function ExpenseTransactions({ initialFilter }) {
  const [filter, setFilter] = useState(() => ({ ...DEFAULT_FILTER, month: currentMonth(), ...initialFilter }));
  const [rows, setRows] = useState(null);
  const [categories, setCategories] = useState([]);
  const [statements, setStatements] = useState([]);
  const [rules, setRules] = useState([]);
  const [members, setMembers] = useState([]);
  const [remember, setRemember] = useState(true);
  const [showRules, setShowRules] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [error, setError] = useState('');
  const { currency } = useCurrency();
  const fmt = (v) => formatCurrency(v, currency);

  useEffect(() => {
    api.getNetWorth().then((nw) => setMembers((nw.members || []).map((m) => m.name))).catch(() => {});
  }, []);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      api.getExpenseTransactions(filter),
      api.getExpenseCategories(),
      api.getExpenseStatements(),
      api.getMerchantRules(),
    ])
      .then(([txns, cats, stmts, rls]) => {
        if (cancelled) return;
        setRows(txns);
        setCategories(cats);
        setStatements(stmts);
        setRules(rls);
        setError('');
      })
      .catch((e) => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, [filter, reloadKey]);

  const reload = () => setReloadKey((k) => k + 1);
  const updateFilter = (patch) => setFilter((f) => ({ ...f, ...patch }));

  async function edit(row, patch) {
    try {
      await api.updateExpenseTransaction(row.id, { ...patch, remember });
      reload();
    } catch (e) {
      setError(e.message);
    }
  }

  async function removeStatement(statement) {
    if (!window.confirm(`Delete this statement and its ${statement.transaction_count} transactions?`)) return;
    try {
      await api.deleteExpenseStatement(statement.id);
      reload();
    } catch (e) {
      setError(e.message);
    }
  }

  async function removeRule(rule) {
    try {
      await api.deleteMerchantRule(rule.id);
      reload();
    } catch (e) {
      setError(e.message);
    }
  }

  return (
    <div>
      {error && <div className="error-msg">{error}</div>}

      <div className="filter-row">
        <div className="form-group">
          <label>Month</label>
          <input type="month" value={filter.month} onChange={(e) => updateFilter({ month: e.target.value })} />
        </div>
        <div className="form-group">
          <label>Kind</label>
          <select value={filter.kind} onChange={(e) => updateFilter({ kind: e.target.value })}>
            <option value="">All kinds</option>
            {KIND_OPTIONS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
          </select>
        </div>
        <div className="form-group">
          <label>Category</label>
          <select value={filter.category} onChange={(e) => updateFilter({ category: e.target.value })}>
            <option value="">All categories</option>
            {categories.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
        <div className="form-group">
          <label>Family member</label>
          <select value={filter.member} onChange={(e) => updateFilter({ member: e.target.value })}>
            <option value="">All members</option>
            {members.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </div>
        <label className="flex-gap">
          <input
            type="checkbox"
            checked={filter.needs_review === '1'}
            onChange={(e) => updateFilter({ needs_review: e.target.checked ? '1' : '' })}
          />
          Needs review only
        </label>
        <label className="flex-gap">
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
          Remember my changes for each merchant
        </label>
      </div>

      <div className="section-title">{filter.month ? formatMonth(filter.month) : 'All months'}</div>
      {rows === null ? (
        <div className="loading-center"><div className="spinner" /></div>
      ) : rows.length === 0 ? (
        <div className="card empty-state"><p>No transactions match these filters.</p></div>
      ) : (
        <div className="card">
          <div className="table-container">
            <table>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Description</th>
                  <th className="hide-mobile">Account</th>
                  <th style={{ textAlign: 'right' }}>Amount</th>
                  <th>Kind</th>
                  <th>Category</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const excluded = EXCLUDED_KINDS.includes(r.kind);
                  const options = r.category && !categories.includes(r.category) ? [...categories, r.category] : categories;
                  return (
                    <tr key={r.id} className={r.needs_review ? 'row-review' : ''}>
                      <td>{formatDate(r.txn_date)}</td>
                      <td>
                        <div>{r.merchant || r.description}</div>
                        {r.merchant && <div className="muted-note" style={{ fontSize: 11 }}>{r.description}</div>}
                        <div className="flex-gap" style={{ marginTop: 2 }}>
                          {r.needs_review ? <span className="badge badge-review">⚠ Check</span> : null}
                          {excluded && (
                            <span className="badge badge-excluded">Excluded · {r.matched_txn_id ? 'matched' : 'unmatched'}</span>
                          )}
                        </div>
                      </td>
                      <td className="hide-mobile">
                        {r.source_name || 'Unlinked source'}
                        <div className="muted-note" style={{ fontSize: 11 }}>{r.family_member}</div>
                      </td>
                      <td style={{ textAlign: 'right' }} className={`amount${r.direction === 'credit' ? ' positive' : ''}`}>
                        {r.direction === 'credit' ? '+' : '−'}{fmt(r.amount)}
                      </td>
                      <td>
                        <select className="cell-select" value={r.kind} onChange={(e) => edit(r, { kind: e.target.value })}>
                          {KIND_OPTIONS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
                        </select>
                      </td>
                      <td>
                        <select
                          className="cell-select"
                          value={r.category || ''}
                          disabled={excluded}
                          onChange={(e) => edit(r, { category: e.target.value || null })}
                        >
                          <option value="">—</option>
                          {options.map((c) => <option key={c} value={c}>{c}</option>)}
                        </select>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="card" style={{ marginTop: 16 }}>
        <div className="section-title">Uploaded statements</div>
        {statements.length === 0 ? (
          <p className="muted-note">No statements uploaded yet.</p>
        ) : (
          <div className="table-container">
            <table>
              <thead>
                <tr>
                  <th>Account / card</th>
                  <th>Period</th>
                  <th className="hide-mobile">File</th>
                  <th style={{ textAlign: 'right' }}>Transactions</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {statements.map((s) => (
                  <tr key={s.id}>
                    <td>{s.source_name || 'Unlinked source'}{s.last4 ? ` ··${s.last4}` : ''}</td>
                    <td>{formatDate(s.period_start)} – {formatDate(s.period_end)}</td>
                    <td className="hide-mobile">{s.file_name || '—'}</td>
                    <td style={{ textAlign: 'right' }}>{s.transaction_count}</td>
                    <td><button className="btn-danger btn-sm" onClick={() => removeStatement(s)}>Delete</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <button className="btn-ghost btn-sm" onClick={() => setShowRules((v) => !v)}>
          {showRules ? '▾' : '▸'} Learned merchant rules ({rules.length})
        </button>
        {showRules && (rules.length === 0 ? (
          <p className="muted-note" style={{ marginTop: 8 }}>
            Rules are created when you correct a transaction with “Remember” ticked.
          </p>
        ) : (
          <div className="table-container" style={{ marginTop: 8 }}>
            <table>
              <thead>
                <tr><th>Merchant</th><th>Kind</th><th>Category</th><th /></tr>
              </thead>
              <tbody>
                {rules.map((rule) => (
                  <tr key={rule.id}>
                    <td>{rule.merchant_key}</td>
                    <td>{KIND_LABELS[rule.kind] || rule.kind}</td>
                    <td>{rule.category || '—'}</td>
                    <td><button className="btn-ghost btn-sm" onClick={() => removeRule(rule)}>Forget</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Page shell**

Create `frontend/src/pages/ExpensesPage.jsx`:

```jsx
import { useState } from 'react';
import ExpenseOverview from '../components/expenses/ExpenseOverview';
import ExpenseTransactions from '../components/expenses/ExpenseTransactions';
import ExpenseUpload from '../components/expenses/ExpenseUpload';

const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'transactions', label: 'Transactions' },
  { id: 'upload', label: 'Upload' },
];

export default function ExpensesPage() {
  const [tab, setTab] = useState('overview');
  const [txnFilter, setTxnFilter] = useState({});

  const openTransactions = (filter) => {
    setTxnFilter(filter);
    setTab('transactions');
  };

  return (
    <div>
      <div className="page-header">
        <h2>Expenses</h2>
      </div>

      <div className="tab-bar" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            className={`tab-btn${tab === t.id ? ' active' : ''}`}
            onClick={() => { setTxnFilter({}); setTab(t.id); }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'overview' && <ExpenseOverview onOpenTransactions={openTransactions} />}
      {tab === 'transactions' && <ExpenseTransactions initialFilter={txnFilter} />}
      {tab === 'upload' && <ExpenseUpload onViewTransactions={(month) => openTransactions({ month })} />}
    </div>
  );
}
```

- [ ] **Step 3: Navigation**

In `frontend/src/App.jsx`:

1. After `import { useState } from 'react';` add `import { Capacitor } from '@capacitor/core';`
2. After `import SettingsPage from './pages/SettingsPage';` add `import ExpensesPage from './pages/ExpensesPage';`
3. In `NAV_ITEMS`, after the `liabilities` entry add:

```js
  { id: 'expenses',     label: 'Expenses',     icon: '💸' },
```

4. Immediately above the comment `// Primary tabs shown in the mobile bottom nav bar` add:

```js
// Expenses needs the REST backend's statement parser, so the Android app hides it.
const VISIBLE_NAV_ITEMS = Capacitor.isNativePlatform()
  ? NAV_ITEMS.filter((item) => item.id !== 'expenses')
  : NAV_ITEMS;

```

5. In `PAGES`, after `liabilities: LiabilitiesPage,` add `  expenses:    ExpensesPage,`
6. In the sidebar, change `{NAV_ITEMS.map((item) => (` to `{VISIBLE_NAV_ITEMS.map((item) => (`.

- [ ] **Step 4: Lint and build**

Run: `cd frontend && npx eslint src/components/expenses src/pages/ExpensesPage.jsx src/App.jsx src/hooks/api.js && npm run build`
Expected: eslint prints nothing; `✓ built`.

- [ ] **Step 5: Manual browser check**

Create sample files: `cd backend && node -e "const fx=require('./tests/helpers/expenseFixtures'); require('fs').writeFileSync('/tmp/bank-aug.csv', fx.BANK_CSV); require('fs').writeFileSync('/tmp/card-aug.pdf', fx.makePdf(fx.CARD_LINES));"`

Start both servers against a throwaway DB: `cd backend && AI_API_KEY= OPENAI_API_KEY= DB_PATH=/tmp/expenses-smoke.db npm start` (empty AI keys force the pattern parser so the numbers below are predictable) and, in a second terminal, `cd frontend && npm run dev`. Open http://localhost:5173 and check each item:

1. Sidebar shows **💸 Expenses** after Liabilities.
2. Upload tab → "＋ Add a new account or card…" → create credit card "HDFC Regalia" → choose `/tmp/card-aug.pdf` → Preview: 5 rows; "PAYMENT RECEIVED" shows *Excluded · card payment*; "AMAZON REFUND" kind Refund; the balance checkbox reads `… → 12,300` and is ticked → Save.
3. Create bank account "HDFC Savings" → upload `/tmp/bank-aug.csv` → Preview: "CC PAYMENT XX1234" is *Excluded · card payment*; change the Swiggy row's category to Groceries (the "Remember for this merchant" box appears, ticked) → Save → the success line mentions "1 card payments matched" and "1 merchant rules learned".
4. Overview → set month to Aug 2026: Income 100,000 · Spending = 450 + 800 + 3,500 + 9,000 − 1,000 = **12,750** · Invested 5,000 · Savings rate 87%. The note says 20,000 of card payments was not counted (1 matched, 0 unmatched). The category chart shows Transport, Shopping, Food & Dining, Groceries. "Show as table" swaps the charts for a table.
5. Transactions tab: change a row's kind; the row stops showing ⚠ Check. Delete the card statement under "Uploaded statements": the bank's card-payment row now shows *Excluded · unmatched* and ⚠ Check.
6. Upload the same CSV again: every row shows *Already saved* and Save is disabled.

Stop both servers, then run `rm /tmp/expenses-smoke.db* /tmp/bank-aug.csv /tmp/card-aug.pdf`.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/expenses/ExpenseTransactions.jsx frontend/src/pages/ExpensesPage.jsx frontend/src/App.jsx
git commit -m "Add Expenses page with transactions tab and navigation

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 14: Release housekeeping (v1.10.0) and final verification

**Files:**
- Modify: `frontend/src/version.js`, `backend/package.json`, `backend/package-lock.json`, `frontend/package.json`, `frontend/package-lock.json`, `backend/src/routes/exportRoutes.js:16`, `CHANGELOG.md`, `README.md`

- [ ] **Step 1: Bump versions**

```bash
cd backend && npm version 1.10.0 --no-git-tag-version && cd ../frontend && npm version 1.10.0 --no-git-tag-version && cd ..
sed -i "s/export const APP_VERSION = '1.9.2';/export const APP_VERSION = '1.10.0';/" frontend/src/version.js
sed -i "s/const APP_VERSION           = '1.9.2';/const APP_VERSION           = '1.10.0';/" backend/src/routes/exportRoutes.js
git grep -n "1\.9\.2" -- ':!CHANGELOG.md' ':!docs' ':!frontend/package-lock.json'
```

Expected: the final `git grep` prints nothing. (`frontend/package-lock.json` still contains unrelated `@emnapi/*` 1.9.2 packages; that is correct.)

- [ ] **Step 2: CHANGELOG**

In `CHANGELOG.md`, insert above `## [1.9.2] – 2026-05-05`:

```markdown
## [1.10.0] – 2026-09-28

### Added
- **Expenses module** (web) — upload bank and credit card statements (PDF, including password-protected, or CSV) and track monthly income, spending by category, investments and savings rate.
  - Parsing follows the existing import pipeline: AI three-pass extraction per PDF page (extract → validate → accuracy review) with a pattern-based fallback; CSV columns mapped by AI with a header-alias fallback. Numeric dates are read day-first.
  - Every transaction gets a kind (expense, refund, income, investment, card payment, own transfer) and a category. Corrections can be remembered per merchant.
  - **No double counting:** credit card bill payments in bank statements and transfers between your own accounts are excluded from all totals by fixed rules. They are paired with the card's "payment received" line (same amount ±₹1, within 5 days) or the other account's credit (within 3 days), whichever statement is uploaded first.
  - Review screen before saving, with duplicate detection across re-uploads and overlapping statements, a reconciliation warning when totals don't add up, and an optional update of the linked account/card balance (never overwriting a newer balance without confirmation).
  - Overview with KPIs, category chart, 12-month trend, savings-rate chart, table view, and the month's net worth change from snapshots.
  - Full data export/import includes expense statements, transactions and merchant rules (export schema unchanged at v3).
- **DB schema v9**: new tables `expense_statements`, `transactions`, `merchant_rules`.

---

```

- [ ] **Step 3: README**

In `README.md`:

1. In **Features**, after the Liabilities bullet add:

```markdown
- 💸 **Expenses** — upload bank & credit card statements (PDF/CSV); transactions are classified into categories, investments and income, and credit card bill payments are never double counted
```

2. In the **API Reference** table, after the `POST /api/import/json` row add:

```markdown
| POST | `/api/expenses/preview` | Parse a bank/card statement (nothing saved) |
| POST | `/api/expenses/commit` | Save reviewed transactions |
| GET | `/api/expenses/summary?month=YYYY-MM` | Monthly income, spending, invested, savings rate |
| GET | `/api/expenses/trend?months=12` | Monthly series |
| GET | `/api/expenses/transactions` | List transactions (filters: month, kind, category, member, needs_review) |
| PUT | `/api/expenses/transactions/:id` | Change kind/category (optionally remember for the merchant) |
| GET / DELETE | `/api/expenses/statements[/:id]` | List / undo uploaded statements |
| GET / DELETE | `/api/expenses/rules[/:id]` | List / forget learned merchant rules |
```

3. In **Running Tests**, replace the sentence starting `All 35 tests should pass` with:

```markdown
All tests should pass (189 at v1.10.0), covering accounts, holdings, assets, liabilities, insurance, metals, net worth, snapshots, imports, export, and the expenses module.
```

- [ ] **Step 4: Final verification**

Run: `cd backend && npm test`
Expected: `Tests: 189 passed, 189 total`.
Run: `cd frontend && npx eslint src/components/expenses src/pages/ExpensesPage.jsx src/App.jsx src/hooks/api.js && npm run build`
Expected: eslint silent; `✓ built`.
Run: `git status --short`
Expected: only the files from this task, plus the user's pre-existing ` M docker-compose.yml` (do not stage it).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/version.js backend/package.json backend/package-lock.json frontend/package.json frontend/package-lock.json backend/src/routes/exportRoutes.js CHANGELOG.md README.md
git commit -m "Release 1.10.0: expenses module

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
