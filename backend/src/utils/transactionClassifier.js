/**
 * transactionClassifier.js – pure classification helpers for the expense module.
 *
 * No DB access: callers pass learned merchant rules and known last-4 digits in.
 * The same post-processing runs on AI and pattern-parser output so that
 * double-count protection never depends on the AI getting it right.
 */
const crypto = require('crypto');

const KINDS = ['expense', 'refund', 'income', 'investment', 'cc_payment', 'transfer'];
// The direction each counted kind normally has; a row running the other way nets against it
// (a debit marked income is income given back, a credit marked expense is money returned).
const NATURAL_DIRECTION = { expense: 'debit', refund: 'credit', income: 'credit', investment: 'debit' };

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

// Statement text that is not a transaction: summary boxes, limits, reward points, interest and
// fee illustrations, and terms. Real fee rows (LATE PAYMENT FEE, FINANCE CHARGES, INTEREST CHARGED)
// deliberately do not match.
const STATEMENT_NOISE_RE = new RegExp([
  'amount\\s*due', 'minimum\\s*(amount\\s*)?due', 'total\\s*dues?\\b', 'payment\\s*due', 'due\\s*date',
  'credit\\s*limit', 'cash\\s*limit', 'available\\s*(credit|cash)', 'previous\\s*(statement\\s*)?balance',
  'opening\\s*balance', 'closing\\s*balance', 'statement\\s*(date|period|summary)', 'account\\s*summary',
  'reward\\s*points?', 'payments?\\s*/\\s*credits', 'purchases?\\s*/\\s*debits', 'illustration',
  'for\\s*example', '\\be\\.g\\.', 'if\\s*you\\s*(purchase|pay|spend|make)', 'interest\\s*of\\b',
  'will\\s*be\\s*charged', 'outstanding\\s*amount', 'balance\\s*up\\s*to',
].join('|'), 'i');

// Words that explain a card credit; any other card credit is a refund the user should check.
const REFUND_WORDS_RE = /REFUND|REVERS|CASH\s*BACK|RETURN/i;

/** True when a "transaction" is really statement summary, example or terms text. */
function isStatementNoise(description) {
  return STATEMENT_NOISE_RE.test(String(description || ''));
}

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

    // A rule applies only when its kind fits this row's direction: "AMAZON = Groceries" learned
    // from a purchase must not turn an Amazon refund into spending.
    const learned = key ? rules.get(key) : null;
    const rule = learned && (!NATURAL_DIRECTION[learned.kind] || NATURAL_DIRECTION[learned.kind] === t.direction)
      ? learned : null;
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
    const unexplainedRefund = hard === 'refund' && !REFUND_WORDS_RE.test(t.description);
    const needs_review = unexplainedRefund || (!rule && !hard && (
      (confidence != null && confidence < 0.7) ||
      (kind === 'expense' && (!category || category === 'Other')) ||
      personalUpi
    ));
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
  KINDS, EXCLUDED_KINDS, DEFAULT_CATEGORIES, NATURAL_DIRECTION,
  merchantKey, mentionsLast4, keywordClassify, isStatementNoise, applyPostProcessing, computeDedupeKeys, reconciliationNote,
};
