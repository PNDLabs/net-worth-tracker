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
const { parse } = require('csv-parse/sync');
const { KINDS, DEFAULT_CATEGORIES, keywordClassify, isStatementNoise } = require('./transactionClassifier');

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
  // Exports often append a time ("05/08/2026 10:22:11", "05-Aug-2026 10:22 AM").
  const s = String(value).trim().replace(/[\sT]+\d{1,2}:\d{2}(?::\d{2})?(?:\s*[AP]M)?$/i, '');
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

/**
 * Parse a balance keeping its sign. A leading "-" is negative; so is "Dr" on a bank
 * balance (overdrawn) and "Cr" on a card balance (paid in advance). Zero is a valid balance.
 */
function parseSignedBalance(value, statementType = 'bank') {
  if (value == null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const raw = String(value).trim();
  const cleaned = raw.replace(/₹|rs\.?|inr|\s|,/gi, '').replace(/(dr|cr)$/i, '').replace(/^-/, '');
  if (!cleaned) return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return null;
  const negativeMark = statementType === 'credit_card' ? /cr$/i : /dr$/i;
  return raw.startsWith('-') || negativeMark.test(raw) ? -n : n;
}

/** Regex detection of statement header fields (last4, period, opening/closing balance). */
function detectStatementHeader(text, statementType = 'bank') {
  const t = String(text || '');
  const AMT = String.raw`(?:₹|Rs\.?|INR)?\s*(-?[\d,]+\.\d{2})(?:\s*(Dr|Cr)\b)?`;
  const amountAfter = (labels) => {
    const m = t.match(new RegExp(`(?:${labels})\\s*:?\\s*${AMT}`, 'i'));
    return m ? parseSignedBalance(m[1] + (m[2] || ''), statementType) : null;
  };
  const last4 = (t.match(/(?:X{2,}|x{2,}|\*{2,})[\s-]?(\d{4})(?!\d)/) || [])[1] || null;
  const period = t.match(new RegExp(`(?:statement\\s*period|period|from)\\s*:?\\s*(${DATE_TOKEN})\\s*(?:to|-|–)\\s*:?\\s*(${DATE_TOKEN})`, 'i'));
  return {
    last4,
    period_start: period ? parseTxnDate(period[1]) : null,
    period_end: period ? parseTxnDate(period[2]) : null,
    opening_balance: amountAfter('opening balance|previous balance|previous statement balance'),
    closing_balance: amountAfter('closing balance|total amount due|total dues'),
    statement_date: parseTxnDate((t.match(new RegExp(`statement\\s*date\\s*:?\\s*(${DATE_TOKEN})`, 'i')) || [])[1]),
  };
}

// Rows this far outside the statement period are examples or terms, not transactions.
const PERIOD_GRACE_DAYS = 7;
// A statement covers roughly a month before its statement date.
const STATEMENT_DATE_LOOKBACK_DAYS = 40;

function shiftIsoDate(iso, days) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Drop rows that are statement noise (summary figures, limits, illustrations, terms) or
 * dated well outside the statement period. Returns the kept rows and a note naming what was
 * dropped, so nothing disappears silently.
 */
function dropStatementNoise(statement, transactions) {
  let window = null;
  if (statement.period_start && statement.period_end) {
    window = [shiftIsoDate(statement.period_start, -PERIOD_GRACE_DAYS), shiftIsoDate(statement.period_end, PERIOD_GRACE_DAYS)];
  } else if (statement.statement_date) {
    window = [shiftIsoDate(statement.statement_date, -STATEMENT_DATE_LOOKBACK_DAYS), shiftIsoDate(statement.statement_date, PERIOD_GRACE_DAYS)];
  }
  const kept = [];
  const dropped = [];
  for (const t of transactions) {
    const outside = window && (t.date < window[0] || t.date > window[1]);
    (outside || isStatementNoise(t.description) ? dropped : kept).push(t);
  }
  if (dropped.length === 0) return { kept, note: null };
  const shown = dropped.slice(0, 5).map((t) => `"${t.description.slice(0, 40)}" ${t.amount}`).join('; ');
  const more = dropped.length > 5 ? `; and ${dropped.length - 5} more` : '';
  return {
    kept,
    note: `Ignored ${dropped.length} ${dropped.length === 1 ? 'line' : 'lines'} that looked like statement summary, ` +
      `examples or terms, or fell outside the statement period: ${shown}${more}.`,
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
    // A row ends with the line holding its first amount; text below it (summary boxes,
    // illustrations, terms) must not be read as part of this transaction.
    const firstAmount = new RegExp(AMOUNT_RE.source).exec(body);
    if (firstAmount) {
      const eol = body.indexOf('\n', firstAmount.index + firstAmount[0].length);
      if (eol > 0) body = body.slice(0, eol);
    }
    const amounts = [...body.matchAll(AMOUNT_RE)];
    const date = parseTxnDate(row.date);
    if (!amounts.length || !date) continue;
    const first = amounts[0];
    const last = amounts[amounts.length - 1];
    const isCard = statementType === 'credit_card';
    // Card rows have no running balance: a second amount is the billed INR amount after a
    // foreign-currency one. Bank rows end with the running balance.
    const amountToken = isCard ? last : first;
    const amount = parseAmount(amountToken[1]);
    const balance = !isCard && amounts.length >= 2 ? parseSignedBalance(last[1] + (last[2] || ''), 'bank') : null;
    const description = body.slice(0, first.index).replace(new RegExp(DATE_TOKEN, 'g'), ' ').replace(/\s+/g, ' ').trim();
    if (!amount || !description || description.length > 200 || SKIP_ROW_RE.test(description)) {
      if (balance != null) state.prevBalance = balance;
      continue;
    }
    let direction;
    let certain = true;
    const marker = amountToken[2] || (isCard ? first[2] : null);
    if (marker) direction = /cr/i.test(marker) ? 'credit' : 'debit';
    else if (balance != null && state.prevBalance != null) direction = balance > state.prevBalance ? 'credit' : 'debit';
    else if (isCard) direction = /PAYMENT|REFUND|REVERSAL|CASHBACK|THANK YOU/i.test(description) ? 'credit' : 'debit';
    else certain = false;
    if (!direction) direction = 'debit';
    if (isCard && amounts.length >= 2) certain = false;
    if (balance != null) state.prevBalance = balance;

    const k = keywordClassify(description, direction, statementType);
    txns.push({
      date, description, merchant: null, amount, direction,
      kind: k.kind, category: k.category, confidence: certain ? k.confidence : Math.min(k.confidence, 0.4),
    });
  }
  return txns;
}

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
- One entry per posted transaction row. Skip everything else, even when it contains dates and amounts: headers, opening/closing balance lines, summary boxes (Total Amount Due, Minimum Amount Due, Payment Due Date, Total Dues, credit and cash limits, previous balance, payments/credits and purchases/debits totals), reward points, interest or fee illustrations and worked examples, and terms and conditions.
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
- Remove rows that are not posted transactions: headers, balances, totals, summary figures (Total Amount Due, Minimum Amount Due, Payment Due Date, credit/cash limits), reward points, interest or fee illustrations and examples, and terms text.
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
  const statement = detectStatementHeader(pages.join('\n'), statementType);
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

  const { kept, note } = dropStatementNoise(statement, transactions);
  if (note) validation_notes.push(note);
  fillPeriodFromTransactions(statement, kept);
  return { statement, transactions: kept, method: usedPattern ? 'pattern' : 'ai', validation_notes };
}

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

/** @param {boolean} signedCredits – the amount column uses signs, so an unsigned amount is a credit */
function csvRowToTxn(row, fields, signedCredits = false) {
  const get = (f) => (fields[f] != null ? row[fields[f]] : undefined);
  const date = parseTxnDate(get('date'));
  const description = String(get('description') ?? '').replace(/\s+/g, ' ').trim();
  if (!date || !description) return null;
  const debit = parseAmount(get('debit'));
  const credit = parseAmount(get('credit'));
  const balance = parseSignedBalance(get('balance'), 'bank');
  if (debit) return { date, description, amount: debit, direction: 'debit', balance };
  if (credit) return { date, description, amount: credit, direction: 'credit', balance };
  const raw = String(get('amount') ?? '').trim();
  const amount = parseAmount(raw);
  if (!amount) return null;
  const flag = String(get('dr_cr') ?? '').trim().toLowerCase();
  let direction = null;
  if (/^(cr|credit|c)$/.test(flag) || /cr$/i.test(raw)) direction = 'credit';
  else if (/^(dr|debit|d)$/.test(flag) || /dr$/i.test(raw) || raw.startsWith('-')) direction = 'debit';
  else if (signedCredits) direction = 'credit';
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
  // A bank amount column holding negative values is signed: negative = debit, positive = credit.
  const signedCredits = statementType === 'bank' && !!fields.amount && !fields.dr_cr &&
    records.some((r) => String(r[fields.amount] ?? '').trim().startsWith('-'));
  const parsed = records.map((r) => csvRowToTxn(r, fields, signedCredits)).filter(Boolean);
  const skipped = records.length - parsed.length;
  if (skipped > 0) {
    validation_notes.push(`${skipped} ${skipped === 1 ? 'row' : 'rows'} could not be read (missing date, description or amount) ` +
      `and ${skipped === 1 ? 'was' : 'were'} skipped. Check them against the statement.`);
  }

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
  const { kept, note } = dropStatementNoise(statement, transactions);
  if (note) validation_notes.push(note);
  fillPeriodFromTransactions(statement, kept);
  return { statement, transactions: kept, method: classified ? 'ai' : 'pattern', validation_notes };
}

module.exports = {
  PROMPTS,
  parseTxnDate, parseAmount, detectStatementHeader, parsePageWithPattern,
  parseTransactionsFromPages, parseTransactionsFromCsv,
};
