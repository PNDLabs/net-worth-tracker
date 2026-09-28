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
