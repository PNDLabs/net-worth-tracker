# Expense Tracking Module — Design Spec

**Date:** 2026-09-28
**Status:** Draft — awaiting review
**Target version:** 1.10.0 (DB schema v9)

---

## 1. Goal

Let the user upload monthly bank and credit card statements and see, per month:

- where money went (spending by category),
- how much came in (income) and how much was invested,
- the resulting **savings rate**, shown next to the month's **net worth change**.

The module must classify each transaction as a debit or credit, assign a kind and category, and
**never double-count credit card spending** — a bank debit that pays a credit card bill is excluded
because the individual purchases are already counted from the card statement.

### Confirmed requirements and assumptions

| # | Decision |
|---|----------|
| R1 | Statements are mostly Indian banks/cards (INR, UPI/NEFT/IMPS/NACH), as PDF or CSV. |
| R2 | Parsing follows the **existing parser pattern**: AI 3-pass when a key is configured, pattern-based fallback otherwise. |
| R3 | Users can recategorise; corrections are remembered per merchant. |
| R4 | Own-account transfers are treated like card payments (excluded). Salary is income. |
| R5 | Re-uploading or overlapping statements must not create duplicate transactions. |
| R6 | Each statement is linked to an existing **account** (bank) or **credit_card liability** (card); the family member is inherited from it. |
| R7 | User **reviews before saving** (preview → review → commit), like the existing import preview. |
| R8 | Monthly view includes savings rate tied to net worth growth. |
| R9 | One upload serves both modules: the review screen offers an opt-in **balance update** for the linked account/card. |
| R10 | Web (REST backend) only in v1. Android shows the module as unavailable. |

### Out of scope (v1)

- Excel (`.xlsx`) upload — needs a new dependency; CSV/PDF are available from all target banks.
- Budgets and overspend alerts.
- Android (Capacitor local SQLite) implementation.
- Re-using previously uploaded net-worth statements — the existing import keeps files in memory only
  (`multer.memoryStorage()`), so nothing is stored to reuse.
- Deriving net worth change from `value_history`; snapshots are used instead.

---

## 2. Data model (DB schema v9)

No existing tables change. Four new tables are added in `backend/src/db/database.js` via
`CREATE TABLE IF NOT EXISTS`; `DB_SCHEMA_VERSION` → 9 with a history line.

### `expense_statements` — one row per committed upload

| Column | Type | Notes |
|--------|------|-------|
| id | INTEGER PK | |
| source_type | TEXT NOT NULL | `'account'` \| `'liability'` |
| source_id | INTEGER NOT NULL | id in `accounts` or `liabilities` |
| statement_type | TEXT NOT NULL | `'bank'` \| `'credit_card'` |
| file_name | TEXT | |
| last4 | TEXT | account/card last 4 digits detected in the header |
| period_start, period_end | TEXT | ISO dates |
| opening_balance, closing_balance | REAL | as detected; nullable |
| parse_method | TEXT | `'ai'` \| `'pattern'` |
| created_at | TEXT | default now |

`source_id` is polymorphic, so no FK. Deleting an account/liability does not cascade; statements with
a missing source are shown as "Unlinked source" and remain deletable.

### `transactions`

| Column | Type | Notes |
|--------|------|-------|
| id | INTEGER PK | |
| statement_id | INTEGER NOT NULL | FK → `expense_statements(id)` ON DELETE CASCADE |
| source_type, source_id | | denormalised from the statement for query speed |
| txn_date | TEXT NOT NULL | ISO date |
| description | TEXT NOT NULL | raw narration |
| merchant | TEXT | cleaned display name |
| merchant_key | TEXT | normalised key used for rules (see §3.3) |
| amount | REAL NOT NULL | always positive |
| direction | TEXT NOT NULL | `'debit'` \| `'credit'` |
| kind | TEXT NOT NULL | see below |
| category | TEXT | spending bucket; null for non-expense kinds is allowed |
| matched_txn_id | INTEGER | FK → `transactions(id)` ON DELETE SET NULL |
| needs_review | INTEGER NOT NULL DEFAULT 0 | |
| kind_locked | INTEGER NOT NULL DEFAULT 0 | 1 once the user set the kind manually; the matcher never changes a locked row |
| dedupe_key | TEXT NOT NULL UNIQUE | see §3.4 |
| created_at, updated_at | TEXT | |

Indexes: `(txn_date)`, `(source_type, source_id, txn_date)`, `(merchant_key)`.

**`kind`** determines what counts toward totals:

| kind | Direction (typical) | Counted as |
|------|---------------------|-----------|
| `expense` | debit | spending |
| `refund` | credit | reduces spending |
| `income` | credit | income |
| `investment` | debit | invested |
| `cc_payment` | bank debit / card credit | **excluded from all totals** |
| `transfer` | debit or credit | **excluded from all totals** |

**`category`** default list (constant in code): Food & Dining, Groceries, Shopping, Transport,
Fuel, Utilities & Bills, Rent, EMI & Loans, Health, Travel, Entertainment, Education,
Personal Care, Fees & Charges, Other. Users may enter a new category free-text when editing;
the category list shown in UI is defaults ∪ distinct categories in use.

### `merchant_rules` — learned from user corrections

| Column | Type | Notes |
|--------|------|-------|
| id | INTEGER PK | |
| merchant_key | TEXT NOT NULL UNIQUE | |
| kind | TEXT NOT NULL | |
| category | TEXT | |
| created_at, updated_at | TEXT | |

---

## 3. Parsing and classification pipeline

New file `backend/src/utils/transactionParser.js`, structured like `statementParser.js`
(same AI option handling: `options.apiKey || AI_API_KEY || OPENAI_API_KEY`, `AI_API_URL`, `AI_MODEL`,
`temperature: 0`). Classification rules live in `backend/src/utils/transactionClassifier.js`
(pure functions, no DB), and matching in `backend/src/utils/transactionMatcher.js` (takes a DB
connection).

### 3.1 Extraction

- **PDF:** add `extractPdfPages(buffer, password, { preserveLines })` to `pdfExtractor.js` returning
  `string[]` (one per page). With `preserveLines: true` text items are joined with `\n` where pdf.js
  reports an end-of-line (`item.hasEOL`), otherwise with a space. `extractPdfText` becomes
  `extractPdfPages(buffer, password).join('\n')` — behaviour unchanged. `PASSWORD_REQUIRED` handling
  is identical. The expense module uses `preserveLines: true`.
- **CSV:** parsed with `csv-parse` as today. Columns are mapped by an AI column mapper call
  (a transactions variant of `mapCsvColumnsWithAI`) to target fields
  `date, description, debit, credit, amount, dr_cr, balance`. Without AI, a fallback alias map:
  - `narration | particulars | details | remarks | transaction_details` → `description`
  - `txn_date | transaction_date | value_date | date` → `date`
  - `withdrawal | withdrawal_amt | debit | dr | debit_amount` → `debit`
  - `deposit | deposit_amt | credit | cr | credit_amount` → `credit`
  - `closing_balance | balance` → `balance`

  Rows with only `amount` use `dr_cr` (or a trailing `Dr`/`Cr`, or a negative sign) for direction.

### 3.2 Parse + classify (AI path, mirrors `parseStatement`)

Because one statement can hold 100–300 transactions, which exceeds the existing `max_tokens: 4096`
output budget, the AI passes run **per page** and results are concatenated in page order.

For each page:

1. **Pass 1 — extract & classify.** Returns
   ```json
   {
     "statement": { "statement_type": "bank|credit_card", "last4": "1234",
                    "period_start": "YYYY-MM-DD", "period_end": "YYYY-MM-DD",
                    "opening_balance": 0, "closing_balance": 0 },
     "transactions": [ { "date": "YYYY-MM-DD", "description": "", "merchant": "",
                         "amount": 0, "direction": "debit|credit",
                         "kind": "expense|refund|income|investment|cc_payment|transfer",
                         "category": "", "confidence": 0.0 } ]
   }
   ```
   The `statement` block is taken from the first page that returns non-null values.
   Prompt covers: Dr/Cr markers, Indian lakh format (1,00,000), UPI/NEFT/IMPS/NACH/ACH narration
   shapes, investment keywords (SIP, mutual fund, Zerodha, Groww, Kuvera, NPS, PPF, BSE/NSE clearing),
   card statement semantics (purchases are debits; payments/refunds are credits).
2. **Pass 2 — validate against raw page text:** add missed lines, fix amounts and swapped
   directions, return `validation_notes`. Accepted only if it returns ≥ as many transactions as
   Pass 1 (same rule as the existing parser).
3. **Pass 3 — accuracy review** (amount magnitude, direction, kind): runs only when Pass 2 produced
   notes. Returns `accuracy_notes`.

Any AI failure on a page falls back to the pattern parser **for that page**; `parse_method` is
`'ai'` only if every page was parsed by AI, else `'pattern'`.

**CSV classification:** CSV rows skip the text passes. Descriptions are sent in batches of 100 to
a single AI classification call returning `{merchant, kind, category, confidence}` per row;
fallback is the keyword classifier.

### 3.3 Pattern fallback

- **Line parser:** detects rows starting with a date (`DD/MM/YYYY`, `DD-MM-YY`, `DD MMM YYYY`,
  `DD-MMM-YYYY`), captures description and one or two amounts, then direction from a `Dr`/`Cr`
  token, or from the running-balance delta when a balance column is present. Dates are parsed by
  a new `parseTxnDate` that reads numeric dates **day-first** (`05/08/2026` = 5 Aug), as Indian
  statements do. The existing `normalizeDate` is not reused because it reads numeric dates
  month-first (US).
- **Header detection:** statement type (credit card if text contains "credit card",
  "minimum amount due", "total amount due"), last4 (`XX1234`, `**** 1234`, `ending 1234`),
  period and opening/closing balance via regex.
- **Keyword classifier** (`transactionClassifier.js`): ordered keyword → `{kind, category}` table
  (e.g. `SALARY` → income; `SIP|MUTUAL FUND|ZERODHA|GROWW|NPS|PPF` → investment;
  `SWIGGY|ZOMATO` → Food & Dining; `BIGBASKET|BLINKIT|ZEPTO|DMART` → Groceries;
  `UBER|OLA|IRCTC|METRO` → Transport; `ELECTRICITY|BESCOM|AIRTEL|JIO` → Utilities & Bills;
  `EMI|LOAN` → EMI & Loans; `INTEREST CREDIT|INT.PD` → income). Unknown → `expense`/`Other`
  with `needs_review`.

### 3.4 Post-processing (deterministic, runs on AI and pattern output alike)

Applied in this order in `transactionClassifier.js`:

1. **Merchant key:** uppercase the description; strip `UPI/`, `POS`, `NEFT`, `IMPS`, `ACH`,
   `NACH` prefixes, reference numbers, VPA suffixes after `@`, and all digits; collapse whitespace.
2. **Merchant rules:** if `merchant_rules` has the key, its `kind`/`category` override the parser.
3. **Hard exclusion rules** (override AI and merchant rules — double counting must not depend on AI.
   They apply only at parse time: a kind the user sets manually in the review screen or via
   `PUT /transactions/:id` is final):
   - Bank statement, debit, description matches
     `CC PAYMENT|CREDIT CARD|CARD PAYMENT|AUTOPAY.*CC|BILLDESK.*CC|CRED CLUB|CREDCLUB`
     or contains the last4 of any card statement already stored → `cc_payment`.
   - Card statement, credit, matches `PAYMENT RECEIVED|THANK YOU|BBPS|PAYMENT - ` → `cc_payment`.
   - Card statement, any other credit → `refund` (unless a merchant rule says otherwise).
   - Any row whose description contains the last4 of a *different* stored bank statement source
     → `transfer`.
4. **Needs review:** `confidence < 0.7`, category `Other`, or UPI payment to a personal VPA
   (VPA without a known merchant keyword).
5. **Dedupe key:** `sha1(source_type|source_id|txn_date|amount.toFixed(2)|direction|merchant_key|n)`
   where `n` is the occurrence index of identical tuples within the uploaded statement. Rows whose
   key already exists in `transactions` are marked `duplicate: true` in the preview.
6. **Reconciliation note:** when opening and closing balances are known, check
   `opening + credits − debits ≈ closing` (bank) or `opening + debits − credits ≈ closing` (card),
   tolerance ₹1. A mismatch adds a note to `validation_notes`; it does not block commit.

---

## 4. Commit and matching

### 4.1 `POST /api/expenses/commit`

Body: `{ source_type, source_id, statement, transactions, update_balance }` — exactly what the
user reviewed (no re-parse). In a single `conn.transaction`:

1. Insert the `expense_statements` row.
2. Insert non-duplicate transactions (`INSERT OR IGNORE` on `dedupe_key` as a safety net).
3. For each transaction where the user changed `kind`/`category` from the parser's value and
   `remember` is true (default), upsert `merchant_rules`.
4. Run the matcher (§4.2) over transactions in a window of ±10 days around the statement period.
5. If `update_balance` is true: set the linked account `balance` (bank) or liability
   `current_balance` (card) to `closing_balance`, and insert a `value_history` row with
   `recorded_at = period_end`, `notes = 'expense statement import'`.

Response: counts of inserted / duplicates skipped / rules learned / matches made / balance updated.

**Balance-update default:** the checkbox is pre-ticked only when `closing_balance` is present and
either the current balance is 0 (a freshly created source), no `value_history` exists for the
entity, or `period_end` is later than the latest `value_history.recorded_at`.
The server re-checks this and refuses (`409`) to apply an older statement's balance unless
`force_balance: true` is sent.

### 4.2 Matcher (`transactionMatcher.js`)

Runs on every commit, so upload order does not matter. Only unmatched rows are considered.

1. **Card payment pairing:** bank `cc_payment` debit ↔ card `cc_payment` credit with equal amount
   (±₹1) and `|date diff| ≤ 5 days`. Prefer the card whose statement last4 appears in the bank
   description; otherwise the closest date. Both rows get `matched_txn_id` pointing to each other.
2. **Missed card payment promotion:** a bank debit of any kind other than `cc_payment` that
   exactly matches (amount ±₹1, ≤ 5 days) an unmatched card `cc_payment` credit is changed to
   `cc_payment`, paired, and flagged `needs_review`.
3. **Own-transfer pairing:** debit in bank source A ↔ credit in bank source B (A ≠ B), equal amount,
   `|date diff| ≤ 3 days`, where at least one side is already `transfer` or the description
   contains the other side's last4. Both become `transfer` and are paired.

Unmatched `cc_payment` rows remain excluded and are reported as "unmatched" in the summary.

**Known gap:** a card payment with no recognisable keyword or last4 in the bank narration, when
the card statement is never uploaded, is stored as `expense`. It will usually surface via
`needs_review`.

---

## 5. API — `backend/src/routes/expenses.js`

Mounted at `/api/expenses` in `app.js`. `/preview` and `/commit` use `importLimiter`;
everything else uses `apiLimiter`. `/commit` bodies can exceed the global `express.json()` 100 KB
limit, so `express.json({ limit: '5mb' })` for `/api/expenses/commit` is registered **before** the
global parser in `app.js`.

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/preview` | multipart `file`, `password?`, `source_type`, `source_id`. Returns `{ statement, transactions[], method, validation_notes, balance_update: { eligible, default_checked, current, proposed } }`. Writes nothing. |
| POST | `/commit` | §4.1 |
| GET | `/summary?month=YYYY-MM&member=` | income, spending, refunds, invested, savings_rate, investment_rate, net_worth_change, by_category[], excluded { total, matched_count, unmatched_count }, needs_review_count |
| GET | `/trend?months=12&member=` | per-month income / spending / invested / savings_rate |
| GET | `/transactions?month=&kind=&category=&member=&needs_review=` | list, joined with source name and family member |
| PUT | `/transactions/:id` | `{ kind?, category?, remember? }`; clears `needs_review`; a supplied `kind` sets `kind_locked = 1`; changing a paired row to a non-excluded kind unpairs both rows and flags the partner `needs_review`; upserts rule when `remember` |
| GET | `/statements` | uploads with source name, period, transaction count |
| DELETE | `/statements/:id` | removes statement and its transactions; partners are unpaired (`matched_txn_id` → NULL via FK) and flagged `needs_review = 1`; their `kind` is unchanged |
| GET | `/rules` · DELETE `/rules/:id` | view / remove learned rules |

Validation: `source_type` ∈ {account, liability}; source must exist; a `liability` source must be
`type = 'credit_card'`; `kind` must be in the kind list; `month` must match `YYYY-MM`.

### Summary math

For month M and optional member filter (member resolved via the linked account/liability's
`family_member`, normalised with the same `normalizedMemberName` as `networth.js` — moved to a
shared helper):

- `income = Σ amount where kind='income'`
- `spending = Σ amount where kind='expense' − Σ amount where kind='refund'`
- `invested = Σ amount where kind='investment'`
- `savings_rate = (income − spending) / income`, `null` when income = 0
- `investment_rate = invested / income`, `null` when income = 0
- `net_worth_change = nw(latest snapshot ≤ end of M) − nw(latest snapshot < start of M)`;
  `null` if either is missing. Only computed for "All members" (snapshots are household-level).
- `by_category` sums `expense` rows only; refunds are reported as one `refunds` total.
- `excluded.total` = Σ amount of **debit** rows whose kind is `cc_payment` or `transfer` (money that
  left an account without counting as spending); `matched_count` / `unmatched_count` count those
  rows with / without `matched_txn_id`. Card-side payment credits are not added, so a matched pair
  is not counted twice.

---

## 6. Frontend

- **Nav:** `{ id: 'expenses', label: 'Expenses', icon: '💸' }` after Liabilities in `NAV_ITEMS`;
  filtered out when `Capacitor.isNativePlatform()`.
- **`pages/ExpensesPage.jsx`** with three tabs; tabs split into
  `components/expenses/{ExpenseOverview,ExpenseTransactions,ExpenseUpload}.jsx` to keep files focused.
- **API:** new methods in `hooks/api.js`; `hooks/localApi.js` gets stubs that reject with
  `"Expenses is available in the web version"`.

### Upload tab (review screen)
1. File picker, source picker (accounts + credit-card liabilities, with "create new" opening the
   existing create flow), optional PDF password (re-prompt on `PASSWORD_REQUIRED`, as ImportPage does).
2. Header: detected type · source · last4 · period · parse method; `validation_notes` listed.
3. Table sorted needs-review first: date, description, amount (Dr/Cr), Kind select, Category select.
   Excluded kinds show a badge ("Excluded — card payment" / "Excluded — transfer"). Duplicates are
   greyed and not editable.
4. Balance-update checkbox (label shows current → proposed value).
5. Save button summarises: transactions to save, duplicates skipped, spending total, excluded count.

### Overview tab
Month picker, member filter, KPI row (Income, Spending, Invested, Savings rate, Net worth change),
spending-by-category horizontal bar chart (single hue, direct value labels), 12-month trend as two
stacked charts sharing the month axis — grouped bars for income / spending / invested (validated
categorical slots 1–3: `#2a78d6`, `#eb6834`, `#1baf7a`) and a separate savings-rate line chart (no
dual y-axis) — with a "Show as table" toggle (required because `#1baf7a` is below 3:1 contrast),
excluded-amount note, needs-review badge linking to the Transactions tab filtered.

### Transactions tab
Filterable table; inline Kind/Category edit with "Remember for this merchant" (default on);
statements list with delete.

---

## 7. Export / import

- `GET /api/export` adds `expense_statements`, `transactions`, `merchant_rules` to `data`.
- `POST /api/export/import` imports them after accounts/liabilities, remapping `source_id` through
  `accountIdMap` / `liabilityIdMap`, `statement_id` through a new statement map, and
  `matched_txn_id` in a second pass. Transactions dedupe on `dedupe_key`; rules on `merchant_key`.
- `EXPORT_SCHEMA_VERSION` stays 3 — the change is additive; both existing importers (backend and
  Android `exportService.js`) read only known keys, so older apps ignore the new tables.

---

## 8. Testing

New file `backend/tests/expenses.test.js`, same harness as `api.test.js` (in-memory DB per test,
`global.fetch` mocked for AI).

- **Pattern parser:** fixture text for a bank statement and a card statement — dates in each format,
  Dr/Cr tokens, lakh amounts, direction from balance delta, header detection.
- **CSV:** alias mapping, debit/credit columns, single amount + Dr/Cr column.
- **AI flow:** passes run in order per page; Pass 2 rejected when it drops rows; Pass 3 skipped when
  no notes; page-level fallback to pattern on AI error.
- **Classifier:** merchant key normalisation; merchant rule overrides parser; hard exclusion rules
  override both an AI answer and a merchant rule; needs-review flags.
- **Matcher:** card payment pairs regardless of upload order; day 5 matches, day 6 does not; amount
  mismatch does not match; unmatched cc_payment still excluded; missed-payment promotion;
  own-transfer pairing.
- **Commit:** re-upload skips duplicates; overlapping statements skip duplicates; rules learned from
  edits; balance update writes `value_history`; older statement rejected without `force_balance`.
- **Summary:** excluded kinds not counted; refunds reduce spending; savings rate and `null` at
  zero income; member filter; net worth change from snapshots.
- **Delete statement:** cascades transactions, unpairs partners.
- **Export/import round trip** of the new tables with ID remapping.

---

## 9. Housekeeping

- `DB_SCHEMA_VERSION` 8 → 9 with history comment.
- App version 1.9.2 → 1.10.0 in `frontend/src/version.js`, both `package.json`, and
  `backend/src/routes/exportRoutes.js`.
- `CHANGELOG.md` entry; README features list, API table, and test description updated.

## 10. Files touched

**New:** `backend/src/routes/expenses.js`, `backend/src/utils/transactionParser.js`,
`backend/src/utils/transactionClassifier.js`, `backend/src/utils/transactionMatcher.js`,
`backend/src/utils/familyMember.js`,
`backend/tests/expenses.test.js`, `frontend/src/pages/ExpensesPage.jsx`,
`frontend/src/components/expenses/*.jsx`.

**Modified:** `backend/src/app.js`, `backend/src/db/database.js`, `backend/src/utils/pdfExtractor.js`,
`backend/src/routes/networth.js` (use shared `normalizeFamilyMember` from new
`backend/src/utils/familyMember.js`), `backend/src/routes/exportRoutes.js`, `frontend/src/App.jsx`,
`frontend/src/hooks/api.js`, `frontend/src/hooks/localApi.js`, `frontend/src/version.js`,
both `package.json`, `CHANGELOG.md`, `README.md`.
