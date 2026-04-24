/**
 * statementParser.js
 *
 * Parses raw text extracted from bank / investment / loan PDF statements.
 *
 * Flow:
 *  1. Try AI parsing when OPENAI_API_KEY (or AI_API_KEY) is configured.
 *  2. Fall back to rule-based regex parsing.
 *
 * AI configuration (optional, via environment variables or runtime options):
 *   AI_API_KEY  – API key (also accepts OPENAI_API_KEY)
 *   AI_API_URL  – Base URL (default: https://api.openai.com/v1)
 *   AI_MODEL    – Model name (default: gpt-4o-mini)
 *
 * Parsed output shape:
 *  {
 *    import_type : 'accounts' | 'assets' | 'liabilities' | 'insurance' | 'sip',
 *    records     : Array<object>,
 *    method      : 'ai' | 'pattern',
 *    raw_preview : string   // first 2000 chars of extracted text
 *  }
 */

// Maximum characters of PDF text sent to the AI model.
// 100 000 chars ≈ 25 000 tokens at the typical 4 chars/token ratio,
// which fits well within gpt-4o-mini's 128k context and ensures large
// multi-page documents (e.g. CAS PDFs with many funds) are fully analysed.
const MAX_AI_INPUT_CHARS = 100000;

const AI_SYSTEM_PROMPT = `You are a financial document parser. The user will send you raw text from a financial document (bank statement, investment statement, loan statement, insurance policy document, SIP/mutual fund transaction statement, CAS (Consolidated Account Statement), or any other financial record).

Your task is to identify the financial records in the text and return structured JSON in EXACTLY this format – no markdown fences, no prose, only the JSON object:
{
  "import_type": "<accounts|assets|liabilities|insurance|sip>",
  "records": [ ... ]
}

For "accounts" records use:
{ "name": string, "institution": string, "type": "<checking|savings|money_market|cd|brokerage|401k|ira|roth_ira|pension|other>", "currency": "<ISO 4217 currency code>", "balance": number }

For "assets" records use:
{ "name": string, "category": "<real_estate|vehicle|crypto|collectible|business|other>", "acquisition_date": "YYYY-MM-DD|null", "acquisition_cost": number|null, "current_value": number }

For "liabilities" records use:
{ "name": string, "lender": string, "type": "<mortgage|auto|student|personal|credit_card|heloc|other>", "original_principal": number|null, "current_balance": number, "interest_rate": number|null, "minimum_payment": number|null }

For "insurance" records use:
{ "name": string, "provider": string|null, "type": "<life|term_life|health|dental|vision|auto|home|renters|disability|umbrella|travel|pet|business|other>", "policy_number": string|null, "premium_amount": number|null, "premium_frequency": "<monthly|quarterly|semi_annual|annual|one_time>", "coverage_amount": number|null, "start_date": "YYYY-MM-DD|null", "end_date": "YYYY-MM-DD|null", "renewal_date": "YYYY-MM-DD|null", "notes": string|null, "terms": string|null, "covered_conditions": ["<condition1>", "<condition2>"] }
- "terms": A comprehensive summary of the policy's key terms extracted verbatim or closely paraphrased from the document. Include: what is covered, coverage limits, deductibles, co-pays/co-insurance, exclusions, waiting periods, claim procedures, and any other material conditions. This is the most important field for enabling later coverage questions — be thorough. Use null only when the document contains no coverage detail at all.
- "covered_conditions": A JSON array of specific covered conditions, procedures, events, or items explicitly listed in the document (e.g. ["hospitalization", "surgery", "accidental death", "critical illness", "maternity", "dental cleaning"]). Use [] when none can be identified.

For "sip" records (SIP / mutual fund transaction statements) use:
{ "name": string, "symbol": string|null, "amount": number, "units": number|null, "nav": number|null, "installment_date": "YYYY-MM-DD" }

Rules:
- Return ONLY the JSON, nothing else.
- If you cannot identify any records, return {"import_type":"accounts","records":[]}.
- Convert all monetary values to plain positive numbers (no $ or ₹ signs, no commas, no negative signs).
- Liabilities current_balance must always be a positive number even if the statement shows it with a minus sign.
- If a field is unknown, use null.
- For investment/brokerage accounts include the total value as the balance.
- FD (Fixed Deposit) accounts should use type "cd" in accounts records.
- Choose "insurance" as import_type when the document is primarily an insurance policy or premium notice.
- Choose "sip" as import_type when the document contains mutual fund SIP/systematic investment plan transactions with NAV and units data. Each transaction row becomes one record.
- For CAS (Consolidated Account Statement) documents that list multiple mutual fund scheme portfolios: return each scheme as an "accounts" record with type="brokerage", balance=current market value, institution=AMC name, and use import_type="accounts".
- When a single document contains both account balances and loan/liability details, prefer returning the type that has more records, or return all records as the detected dominant type.

CURRENCY DETECTION (critical – do not default to USD unless the document clearly uses US dollars):
- Look for currency symbols in the document: ₹ or "Rs." or "INR" → use "INR"; "$" or "USD" → use "USD"; "€" or "EUR" → use "EUR"; "£" or "GBP" → use "GBP"; "¥" or "JPY" → use "JPY".
- If the institution is an Indian bank/fund and no explicit currency symbol is given, default to "INR".
- Apply the detected currency consistently to ALL account records in the document.

AMOUNT PARSING (critical – do not misread Indian number format):
- Indian number format uses groups of 2 after the first group of 3: 1,00,000 = 100000 (one lakh); 10,00,000 = 1000000 (ten lakhs); 1,00,00,000 = 10000000 (one crore).
- Always remove ALL commas before converting to a number: "1,00,000" → 100000; "10,00,000" → 1000000.
- Never treat a comma-separated group as a decimal separator.

ACCOUNT TYPE CLASSIFICATION (critical – classify precisely):
- "savings" → savings bank account or savings account
- "checking" → current account, checking account
- "cd" → fixed deposit (FD), certificate of deposit, recurring deposit (RD)
- "brokerage" → demat account, trading account, mutual fund portfolio, investment account
- "401k" → 401(k) retirement plan
- "ira" → IRA (traditional)
- "roth_ira" → Roth IRA
- "pension" → pension, provident fund (PF, EPF, PPF)
- "money_market" → money market account or liquid fund
- "other" → use only when no other type fits`;

// ─── AI Parsing ───────────────────────────────────────────────────────────────

async function parseWithAI(text, options = {}) {
  const apiKey = options.apiKey || process.env.AI_API_KEY || process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

  const apiUrl = options.apiUrl || process.env.AI_API_URL || 'https://api.openai.com/v1';
  const model = options.model || process.env.AI_MODEL || 'gpt-4o-mini';

  const truncated = text.slice(0, MAX_AI_INPUT_CHARS); // ~3000 tokens at ~4 chars/token

  const response = await fetch(`${apiUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: AI_SYSTEM_PROMPT },
        { role: 'user', content: truncated },
      ],
      temperature: 0,
      max_tokens: 4096,
    }),
  });

  if (!response.ok) {
    const err = await response.text().catch(() => '');
    throw new Error(`AI API error ${response.status}: ${err}`);
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content?.trim();
  if (!content) throw new Error('AI returned empty response');

  const parsed = JSON.parse(content);
  if (!parsed.records) throw new Error('AI response missing records field');
  return parsed;
}

// ─── AI Validation (Pass 2) ───────────────────────────────────────────────────

const AI_VALIDATION_PROMPT = `You are a financial data validator. You will receive:
1. Raw text extracted from a financial document.
2. An initial JSON extraction produced by a previous parsing pass.

Your task is to cross-check every field in the initial extraction against the raw text, then return a corrected and completed result in EXACTLY this JSON format – no markdown fences, no prose, only the JSON object:
{
  "import_type": "<accounts|assets|liabilities|insurance|sip>",
  "records": [ ... ],
  "validation_notes": [ "<string describing each correction or addition>" ]
}

Rules:
- Use the same record schemas as the initial extraction (same field names and types).
- Preserve the import_type from the initial extraction unless it is clearly and obviously wrong (e.g. the document is unambiguously a liability statement but was classified as accounts).
- Add any records that are clearly present in the raw text but were missed in the initial extraction.
- Correct any field values that do not match what is stated in the raw text.
- Fill in null fields where the value is clearly present in the raw text.
- Remove records that have no basis in the raw text.
- validation_notes must be an array of short human-readable strings, one entry per change made. If no changes were needed, return an empty array [].
- Convert all monetary values to plain positive numbers (no $ or ₹ signs, no commas, no negative signs).
- Liabilities current_balance must always be a positive number.
- Return ONLY the JSON, nothing else.

CURRENCY VALIDATION (check every record):
- Scan the raw text for currency indicators: ₹ or "Rs." or "INR" → set currency to "INR"; "$" or "USD" → "USD"; "€" or "EUR" → "EUR"; "£" or "GBP" → "GBP".
- If any record has the wrong currency code, correct it and add a validation note.
- If the document is from an Indian institution and the currency field says "USD", change it to "INR".

AMOUNT VALIDATION (check every monetary value):
- Indian number format: 1,00,000 = 100000; 10,00,000 = 1000000; 1,00,00,000 = 10000000. Remove ALL commas before interpreting.
- If a balance/amount appears to be off by a factor of 10, 100, or 1000 compared to what the raw text shows, correct it.
- Verify the numeric value against the raw text and correct any misreading.

ACCOUNT / RECORD TYPE VALIDATION (check every type field):
- For accounts: "savings" = savings account; "checking" = current/checking account; "cd" = fixed deposit/FD/RD; "brokerage" = demat/trading/mutual fund; "pension" = PF/EPF/PPF; "money_market" = liquid fund.
- Correct the type field if the label in the raw text clearly indicates a different classification.

INSURANCE DETAIL VALIDATION (applies only when import_type is "insurance"):
- "terms": Verify the terms field contains a thorough summary of coverage. If the raw text has coverage details, exclusions, deductibles, co-pays, waiting periods, or claim procedures that are missing from terms, expand the field. This is critical — a sparse or missing terms field will make coverage queries useless.
- "covered_conditions": Verify the array contains all specific conditions, procedures, or events explicitly listed as covered in the raw text. Add any that were missed (e.g. hospitalization, surgery, maternity, accidental death, critical illness, dental cleaning, vision exam). Must be a JSON array of strings, not a plain string.`;

/**
 * Pass 2: validate and refine an initial extraction against the source text.
 *
 * @param {string} text           – full document text (truncated to MAX_AI_INPUT_CHARS)
 * @param {object} initialResult  – { import_type, records } from Pass 1
 * @param {object} options        – same AI options as parseWithAI
 * @returns {Promise<{ import_type, records, validation_notes }|null>}
 */
async function validateAndRefineWithAI(text, initialResult, options = {}) {
  const apiKey = options.apiKey || process.env.AI_API_KEY || process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

  const apiUrl = options.apiUrl || process.env.AI_API_URL || 'https://api.openai.com/v1';
  const model = options.model || process.env.AI_MODEL || 'gpt-4o-mini';

  const truncated = text.slice(0, MAX_AI_INPUT_CHARS);
  const userMessage =
    `RAW TEXT:\n${truncated}\n\n` +
    `INITIAL EXTRACTION:\n${JSON.stringify(initialResult, null, 2)}`;

  const response = await fetch(`${apiUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: AI_VALIDATION_PROMPT },
        { role: 'user', content: userMessage },
      ],
      temperature: 0,
      max_tokens: 4096,
    }),
  });

  if (!response.ok) {
    const err = await response.text().catch(() => '');
    throw new Error(`AI validation API error ${response.status}: ${err}`);
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content?.trim();
  if (!content) throw new Error('AI validation returned empty response');

  const parsed = JSON.parse(content);
  if (!parsed.records) throw new Error('AI validation response missing records field');
  if (!Array.isArray(parsed.validation_notes)) parsed.validation_notes = [];
  return parsed;
}

// ─── AI Accuracy Review (Pass 3) ─────────────────────────────────────────────

const AI_ACCURACY_REVIEW_PROMPT = `You are a specialist financial data accuracy reviewer. You will receive:
1. Raw text extracted from a financial document.
2. A previously validated JSON extraction.

Your SOLE job is to catch and fix three specific categories of errors:

CATEGORY 1 – WRONG CURRENCY
- Scan the raw text carefully for any currency indicator: ₹, Rs., INR → "INR"; $, USD → "USD"; €, EUR → "EUR"; £, GBP → "GBP"; ¥, JPY → "JPY".
- If an account record has the wrong currency code, correct it.
- Consistency rule: all records in the same document should use the same currency unless the document explicitly mixes currencies.

CATEGORY 2 – WRONG AMOUNT / MAGNITUDE
- Verify every monetary value (balance, current_balance, current_value, amount, premium_amount, coverage_amount, original_principal, minimum_payment) against the raw text.
- Indian number format: 1,00,000 = 100000; 10,00,000 = 1000000; 1,00,00,000 = 10000000. Remove ALL commas, then read the integer.
- If an amount is off by a factor of 10, 100, 1000, or any other magnitude, correct it to exactly match the raw text.

CATEGORY 3 – WRONG TYPE CLASSIFICATION
- For accounts "type": check whether "savings"/"checking"/"cd"/"brokerage"/"pension"/"money_market"/"401k"/"ira"/"roth_ira"/"other" matches the label in the raw text.
  - Fixed Deposit / FD / RD → "cd"
  - Current Account → "checking"
  - Savings Account / SB Account → "savings"
  - Demat / Trading / Mutual Fund portfolio → "brokerage"
  - EPF / PPF / Provident Fund / Pension → "pension"
  - Liquid Fund / Money Market → "money_market"
- For liabilities "type": mortgage/auto/student/personal/credit_card/heloc/other – verify against the raw text.
- For insurance "type": verify the policy type against the raw text.
- For insurance records: if "terms" is null or very short (< 50 characters) but the raw text contains coverage details, expand "terms" with all coverage information, exclusions, deductibles, and claim procedures found. If "covered_conditions" is empty but the raw text lists covered items, populate it as a JSON array.

Return the corrected result in EXACTLY this JSON format – no markdown fences, no prose, only the JSON:
{
  "import_type": "<same as input unless obviously wrong>",
  "records": [ ... ],
  "accuracy_notes": [ "<one short string per correction made>" ]
}
If no corrections are needed, return the records unchanged with "accuracy_notes": [].`;

/**
 * Pass 3: specialist accuracy review for currency, amount magnitude, and type classification.
 *
 * @param {string} text            – full document text (truncated to MAX_AI_INPUT_CHARS)
 * @param {object} validatedResult – { import_type, records } from Pass 2
 * @param {object} options         – same AI options as parseWithAI
 * @returns {Promise<{ import_type, records, accuracy_notes }|null>}
 */
async function reviewFieldAccuracy(text, validatedResult, options = {}) {
  const apiKey = options.apiKey || process.env.AI_API_KEY || process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

  const apiUrl = options.apiUrl || process.env.AI_API_URL || 'https://api.openai.com/v1';
  const model = options.model || process.env.AI_MODEL || 'gpt-4o-mini';

  const truncated = text.slice(0, MAX_AI_INPUT_CHARS);
  const userMessage =
    `RAW TEXT:\n${truncated}\n\n` +
    `VALIDATED EXTRACTION:\n${JSON.stringify(validatedResult, null, 2)}`;

  const response = await fetch(`${apiUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: AI_ACCURACY_REVIEW_PROMPT },
        { role: 'user', content: userMessage },
      ],
      temperature: 0,
      max_tokens: 4096,
    }),
  });

  if (!response.ok) {
    const err = await response.text().catch(() => '');
    throw new Error(`AI accuracy review API error ${response.status}: ${err}`);
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content?.trim();
  if (!content) throw new Error('AI accuracy review returned empty response');

  const parsed = JSON.parse(content);
  if (!parsed.records) throw new Error('AI accuracy review response missing records field');
  if (!Array.isArray(parsed.accuracy_notes)) parsed.accuracy_notes = [];
  return parsed;
}

// ─── Pattern-based Fallback ───────────────────────────────────────────────────

/**
 * Normalize a date string to ISO YYYY-MM-DD.
 * Handles:
 *   YYYY-MM-DD      → pass-through
 *   DD-MMM-YYYY     → 15-Jan-2025  (common in Indian fund / SIP statements)
 *   DD-MMM-YY       → 15-Jan-25
 *   MM/DD/YYYY      → US insurance format (when no month abbreviation)
 *   MM-DD-YYYY      → same
 */
function normalizeDate(s) {
  if (!s) return null;
  s = s.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  // DD-MMM-YYYY or DD-MMM-YY (e.g. 15-Jan-2025, 15-Jan-25)
  const mmmMatch = s.match(/^(\d{1,2})[-\s/](Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[-\s/](\d{2,4})$/i);
  if (mmmMatch) {
    const MONTHS = { jan:'01',feb:'02',mar:'03',apr:'04',may:'05',jun:'06',jul:'07',aug:'08',sep:'09',oct:'10',nov:'11',dec:'12' };
    const year = mmmMatch[3].length === 2 ? `20${mmmMatch[3]}` : mmmMatch[3];
    const month = MONTHS[mmmMatch[2].toLowerCase()];
    return `${year}-${month}-${mmmMatch[1].padStart(2, '0')}`;
  }
  // MM/DD/YYYY, MM-DD-YYYY, MM/DD/YY, etc.
  const parts = s.split(/[/-]/);
  if (parts.length === 3) {
    const [a, b, c] = parts;
    const year = c.length === 2 ? `20${c}` : c;
    return `${year}-${a.padStart(2, '0')}-${b.padStart(2, '0')}`;
  }
  return null;
}

/**
 * Detect the ISO 4217 currency code from document text.
 * Scans the first 5 000 characters (enough to cover document headers and the first
 * few pages of a statement) and scores currency indicators by frequency.
 * Returns 'USD' as the default when no clear indicator is found.
 */
function detectCurrency(text) {
  // 5 000 chars covers the document header and first pages without reading the entire
  // document, balancing detection accuracy against performance.
  const sample = text.slice(0, 5000);
  // Count occurrences to determine dominant currency
  const inrScore =
    (sample.match(/₹/g) || []).length * 3 +
    (sample.match(/\bRs\.?\b/g) || []).length * 2 +
    (sample.match(/\bINR\b/g) || []).length * 2;
  const usdScore =
    (sample.match(/\$/g) || []).length * 3 +
    (sample.match(/\bUSD\b/g) || []).length * 2;
  const eurScore =
    (sample.match(/€/g) || []).length * 3 +
    (sample.match(/\bEUR\b/g) || []).length * 2;
  const gbpScore =
    (sample.match(/£/g) || []).length * 3 +
    (sample.match(/\bGBP\b/g) || []).length * 2;
  const jpyScore =
    (sample.match(/¥/g) || []).length * 3 +
    (sample.match(/\bJPY\b/g) || []).length * 2;

  const scores = { INR: inrScore, USD: usdScore, EUR: eurScore, GBP: gbpScore, JPY: jpyScore };
  const best = Object.entries(scores).reduce((a, b) => (b[1] > a[1] ? b : a));
  return best[1] > 0 ? best[0] : 'USD';
}

/**
 * Detect the dominant statement type from the full text.
 */
function detectStatementType(text) {
  const lower = text.toLowerCase();

  // CAS (Consolidated Account Statement) – must be checked before generic SIP
  // because CAS also contains folio/NAV signals
  if (
    /\bconsolidated\s+account\s+statement\b/.test(lower) ||
    (/\bfolio\b/.test(lower) && /\bclosing\s+balance\b/.test(lower))
  ) return 'cas';

  // Strong signals for SIP / mutual fund transaction statements
  if (
    /\bsystematic\s+investment\s+plan\b/.test(lower) ||
    /\bsip\s*(?:purchase|installment|debit|transaction)\b/.test(lower) ||
    (/\bfolio\b/.test(lower) && /\bnav\b/.test(lower)) ||
    /\bunits\s+allotted\b/.test(lower)
  ) return 'sip';

  // Strong signals for insurance
  if (
    /\b(insurance\s+policy|policy\s+number|premium\s+(?:due|payment|amount)|coverage\s+amount|insured|beneficiary|deductible|insurance\s+certificate|renewal\s+date|policy\s+holder)\b/.test(lower)
  ) return 'insurance';

  // Strong signals for liabilities
  if (
    /\b(mortgage|loan\s+number|loan\s+balance|principal\s+balance|outstanding\s+balance|heloc|credit\s+card\s+statement|minimum\s+payment\s+due)\b/.test(lower)
  ) return 'liabilities';

  // Strong signals for investment / brokerage
  if (
    /\b(portfolio|holdings|shares|symbol|ticker|401\s*k|ira|brokerage|mutual\s+fund|etf|dividend|investment\s+account)\b/.test(lower)
  ) return 'accounts';

  // Default: bank account
  return 'accounts';
}

/**
 * Attempt to pull an institution name from the first 400 chars.
 */
function extractInstitution(text) {
  const firstBlock = text.slice(0, 400);
  const patterns = [
    /(?:bank|financial|credit union|fidelity|vanguard|schwab|merrill|wells fargo|chase|citi|bofa|bank of america|td bank|us bank|pnc|ally|capital one|discover|morgan stanley|edward jones)\w*/gi,
  ];
  for (const re of patterns) {
    const m = firstBlock.match(re);
    if (m) return m[0].replace(/\s+/g, ' ').trim();
  }
  // Grab the very first capitalized phrase (likely the bank name header)
  const header = firstBlock.match(/^([A-Z][A-Za-z&,.\s]{3,40})/m);
  return header ? header[1].trim() : 'Unknown Institution';
}

/**
 * Extract currency amounts from a string, largest first.
 * Handles USD ($), INR (₹ / Rs.), EUR (€), GBP (£) prefixes and
 * both Western (1,000,000) and Indian (10,00,000) number formats.
 *
 * The regex enforces either:
 *   – Western grouping: 1–3 digits then zero-or-more groups of exactly 3 digits (1,000,000)
 *   – Indian grouping: 1–3 digits then zero-or-more groups of exactly 2 digits (10,00,000)
 * Each individual number must be consistently Western or Indian; arbitrary mixed
 * comma placement (e.g. "1,2,3") will not be matched.
 */
function extractAmounts(text) {
  // Two alternatives: Western (groups of 3) or Indian (first group 1-3, then groups of 2)
  const re = /(?:\$|₹|Rs\.?|€|£|¥)?\s*((?:\d{1,3})(?:,\d{3})+(?:\.\d{1,2})?|(?:\d{1,3})(?:,\d{2})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)/g;
  const amounts = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    const val = parseFloat(m[1].replace(/,/g, ''));
    if (!isNaN(val) && val >= 0) amounts.push(val);
  }
  return amounts.sort((a, b) => b - a);
}

/**
 * Parse a bank statement into account records.
 */
function parseBankStatement(text) {
  const institution = extractInstitution(text);
  const currency = detectCurrency(text);
  const records = [];

  // Look for labelled balance lines (supports both $ and ₹/Rs. prefixes)
  const balancePatterns = [
    /(?:ending|closing|available|current|account)\s+balance[:\s]+(?:\$|₹|Rs\.?)?\s*([\d,]+(?:\.\d{1,2})?)/gi,
    /(?:total|portfolio)\s+value[:\s]+(?:\$|₹|Rs\.?)?\s*([\d,]+(?:\.\d{1,2})?)/gi,
    /balance\s+as\s+of[^$₹\n]*(?:\$|₹|Rs\.?)?\s*([\d,]+(?:\.\d{1,2})?)/gi,
    // Fixed Deposit / FD balances (common in Indian bank statements)
    /(?:fixed\s+deposit|fd)\s+(?:balance|amount|principal)[:\s]+(?:\$|₹|Rs\.?|INR)?\s*([\d,]+(?:\.\d{1,2})?)/gi,
  ];

  const foundBalances = new Set();

  for (const re of balancePatterns) {
    let m;
    const localRe = new RegExp(re.source, re.flags);
    while ((m = localRe.exec(text)) !== null) {
      const balance = parseFloat(m[1].replace(/,/g, ''));
      if (!isNaN(balance) && !foundBalances.has(balance)) {
        foundBalances.add(balance);

        // Try to find an account name nearby
        const before = text.slice(Math.max(0, m.index - 150), m.index);
        const nameMatch = before.match(/(?:account name|account\s*:)[:\s]+([A-Za-z0-9 &\-]+)/i)
          || before.match(/([A-Z][A-Za-z &\-]{3,30}(?:Checking|Savings|Account|Plus|Premier|Select|Gold|Silver))/);

        const name = nameMatch ? nameMatch[1].trim() : `${institution} Account`;

        // Detect account type
        const matchLine = m[0].toLowerCase();
        const context = (before + m[0]).toLowerCase();
        let type = 'other';
        // Check FD only in the matched text itself to avoid contaminating nearby accounts
        if (/fixed\s*deposit|\bfd\b/.test(matchLine)) type = 'cd';
        else if (/recurring\s*deposit|\brd\b/.test(matchLine)) type = 'cd';
        else if (/checking|current\s+account/.test(context)) type = 'checking';
        else if (/saving/.test(context)) type = 'savings';
        else if (/money\s*market/.test(context)) type = 'money_market';
        else if (/cd|certificate/.test(context)) type = 'cd';
        else if (/401\s*k/.test(context)) type = '401k';
        else if (/roth/.test(context)) type = 'roth_ira';
        else if (/\bira\b/.test(context)) type = 'ira';
        else if (/\bepf\b|\bppf\b|\bprovident\b|\bpension\b/.test(context)) type = 'pension';
        else if (/brokerage|portfolio|invest|demat/.test(context)) type = 'brokerage';

        records.push({ name, institution, type, currency, balance });
      }
    }
  }

  // If no labelled balances found, try the largest amounts on "total" lines
  if (records.length === 0) {
    const totalLine = text.match(/(?:total|net)\s+(?:assets?|balance|worth)[^$₹\n]*(?:\$|₹|Rs\.?)?\s*([\d,]+(?:\.\d{1,2})?)/i);
    if (totalLine) {
      const balance = parseFloat(totalLine[1].replace(/,/g, ''));
      records.push({ name: `${institution} Account`, institution, type: 'other', currency, balance });
    } else {
      // Last resort: largest amount found
      const amounts = extractAmounts(text);
      if (amounts.length > 0) {
        records.push({ name: `${institution} Account`, institution, type: 'other', currency, balance: amounts[0] });
      }
    }
  }

  return { import_type: 'accounts', records };
}

/**
 * Parse a loan / credit-card statement into liability records.
 */
function parseLiabilityStatement(text) {
  const institution = extractInstitution(text);
  const records = [];

  const loanNameMatch = text.match(/(?:loan\s+type|account\s+type|account\s+name)\s*:\s*([A-Za-z0-9 \-]+)/i);
  const name = loanNameMatch ? loanNameMatch[1].trim() : `${institution} Loan`;

  const balanceMatch = text.match(
    /(?:current|outstanding|remaining|principal)\s+balance[:\s]+\$?\s*([\d,]+(?:\.\d{1,2})?)/i
  ) || text.match(/balance[:\s]+\$?\s*([\d,]+(?:\.\d{1,2})?)/i);

  const originalMatch = text.match(
    /(?:original|total)\s+(?:loan\s+)?(?:amount|principal)[:\s]+\$?\s*([\d,]+(?:\.\d{1,2})?)/i
  );

  const rateMatch = text.match(
    /(?:interest|apr|annual\s+percentage)\s+rate[:\s]+\s*([\d.]+)\s*%/i
  );

  const minPayMatch = text.match(
    /(?:minimum|minimum\s+payment|monthly\s+payment|payment\s+due)[:\s]+\$?\s*([\d,]+(?:\.\d{1,2})?)/i
  );

  const lowerText = text.toLowerCase();
  let type = 'other';
  if (/mortgage|home\s+loan/.test(lowerText)) type = 'mortgage';
  else if (/auto|vehicle|car/.test(lowerText)) type = 'auto';
  else if (/student/.test(lowerText)) type = 'student';
  else if (/credit\s*card/.test(lowerText)) type = 'credit_card';
  else if (/heloc/.test(lowerText)) type = 'heloc';
  else if (/personal/.test(lowerText)) type = 'personal';

  if (balanceMatch) {
    records.push({
      name,
      lender: institution,
      type,
      original_principal: originalMatch ? parseFloat(originalMatch[1].replace(/,/g, '')) : null,
      current_balance: Math.abs(parseFloat(balanceMatch[1].replace(/,/g, ''))),
      interest_rate: rateMatch ? parseFloat(rateMatch[1]) : null,
      minimum_payment: minPayMatch ? parseFloat(minPayMatch[1].replace(/,/g, '')) : null,
    });
  }

  return { import_type: 'liabilities', records };
}

/**
 * Parse a SIP / mutual fund transaction statement into sip_installments records.
 * Handles both tabular format (one row per transaction) and key-value format
 * (single transaction described inline).
 */
function parseSipStatement(text) {
  const records = [];

  // Extract scheme/fund name(s) from common header patterns
  const schemeNames = [];
  for (const m of text.matchAll(/scheme(?:\s+name)?[ \t:]+([A-Za-z0-9 \-&()/]+?)(?:\r?\n|ISIN|folio|\s{3,})/gi)) {
    const name = m[1].trim();
    if (name && !schemeNames.includes(name)) schemeNames.push(name);
  }

  // Pattern 1: tabular rows "date  SIP-Purchase  amount  units  nav"
  // e.g. "15-Jan-2025  SIP Purchase  5,000.00  10.2341  488.80"
  const tabRe = /(\d{1,2}[-/](?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[-/]\d{2,4}|\d{4}-\d{2}-\d{2}|\d{1,2}[-/]\d{1,2}[-/]\d{2,4})\s+(?:SIP[- ]?(?:Purchase|Installment|Debit)?|Purchase|Systematic Investment)\s*([\d,]+(?:\.\d{1,2})?)\s+([\d.]+)\s+([\d.]+)/gi;
  let m;
  let si = 0;
  while ((m = tabRe.exec(text)) !== null) {
    const schemeName = schemeNames[si] || schemeNames[0] || 'SIP';
    records.push({
      name: schemeName,
      symbol: null,
      amount: parseFloat(m[2].replace(/,/g, '')),
      units: parseFloat(m[3]),
      nav: parseFloat(m[4]),
      installment_date: normalizeDate(m[1]) || new Date().toISOString().slice(0, 10),
    });
    si++;
  }

  // Pattern 2: key-value format (single or sparse transaction)
  // e.g. "Amount: 5000  Units: 26.286  NAV: 190.25  Date: 15-Jan-2025"
  if (records.length === 0) {
    const amtMatch = text.match(/(?:amount|invested)[ \t:]+(?:Rs\.?|₹|INR)?\s*([\d,]+(?:\.\d{1,2})?)/i);
    const unitsMatch = text.match(/units?(?:\s+allotted|\s+purchased)?[ \t:]+\s*([\d.]+)/i);
    const navMatch = text.match(/\bNAV[ \t:]+(?:Rs\.?|₹|INR)?\s*([\d.]+)/i);
    const dateMatch = text.match(
      /(?:transaction\s+date|sip\s+date|date)[ \t:]+(\d{1,2}[-/](?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[-/]\d{2,4}|\d{4}-\d{2}-\d{2}|\d{1,2}[-/]\d{1,2}[-/]\d{2,4})/i
    );
    if (amtMatch) {
      records.push({
        name: schemeNames[0] || 'SIP',
        symbol: null,
        amount: parseFloat(amtMatch[1].replace(/,/g, '')),
        units: unitsMatch ? parseFloat(unitsMatch[1]) : null,
        nav: navMatch ? parseFloat(navMatch[1]) : null,
        installment_date: (dateMatch && normalizeDate(dateMatch[1])) || new Date().toISOString().slice(0, 10),
      });
    }
  }

  return { import_type: 'sip', records };
}

/**
 * Parse an insurance document into insurance plan records.
 */
function parseInsuranceDocument(text) {
  const institution = extractInstitution(text);

  const nameMatch = text.match(
    /(?:policy\s+(?:name|type)|coverage\s+type|plan\s+name|product\s+name)[ \t:]{1,20}([A-Za-z0-9 \-]+)/i
  );
  const name = nameMatch ? nameMatch[1].trim() : `${institution} Insurance`;

  const policyNumMatch = text.match(/policy\s+(?:number|no\.?|#)[ \t:]{1,20}([A-Z0-9\-]+)/i);
  const premiumMatch = text.match(
    /(?:premium|payment)[ \t:]{1,30}\$?\s*([\d,]+(?:\.\d{1,2})?)/i
  );
  const coverageMatch = text.match(
    /(?:coverage|face\s+value|sum\s+assured|benefit\s+amount)[ \t:]{1,30}\$?\s*([\d,]+(?:\.\d{1,2})?)/i
  );
  const startMatch = text.match(
    /(?:effective\s+date|start\s+date|policy\s+start)[ \t:]{1,20}(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}|\d{4}-\d{2}-\d{2})/i
  );
  const endMatch = text.match(
    /(?:expiry\s+date|expiration\s+date|end\s+date|policy\s+end)[ \t:]{1,20}(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}|\d{4}-\d{2}-\d{2})/i
  );
  const renewalMatch = text.match(
    /(?:renewal\s+date|renews\s+on)[ \t:]{1,20}(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}|\d{4}-\d{2}-\d{2})/i
  );

  const lowerText = text.toLowerCase();
  let type = 'other';
  if (/\bterm\s+life\b/.test(lowerText)) type = 'term_life';
  else if (/\bwhole\s+life\b|\blife\s+insurance\b/.test(lowerText)) type = 'life';
  else if (/\bhealth\b/.test(lowerText)) type = 'health';
  else if (/\bdental\b/.test(lowerText)) type = 'dental';
  else if (/\bvision\b/.test(lowerText)) type = 'vision';
  else if (/\bauto\b|\bvehicle\b|\bcar\s+insurance\b/.test(lowerText)) type = 'auto';
  else if (/\bhome\s+insurance\b|\bhomeowner\b/.test(lowerText)) type = 'home';
  else if (/\brenters?\b/.test(lowerText)) type = 'renters';
  else if (/\bdisability\b/.test(lowerText)) type = 'disability';
  else if (/\btravel\b/.test(lowerText)) type = 'travel';
  else if (/\bpet\b/.test(lowerText)) type = 'pet';
  else if (/\bumbrella\b/.test(lowerText)) type = 'umbrella';
  else if (/\bbusiness\b/.test(lowerText)) type = 'business';

  // Extract covered conditions: look for bullet-list or comma-separated covered items
  const coveredConditions = [];
  const conditionKeywords = [
    /\bhospitali[sz]ation\b/i, /\bsurgery\b/i, /\baccidental\s+death\b/i,
    /\bcritical\s+illness\b/i, /\bmaternity\b/i, /\bdental\b/i, /\bvision\b/i,
    /\bprescription\b/i, /\bemergency\b/i, /\bambulance\b/i, /\bmental\s+health\b/i,
    /\bphysical\s+therapy\b/i, /\bpre[-\s]?existing\b/i, /\bICU\b/, /\bchemotherapy\b/i,
    /\bdialysis\b/i, /\borgan\s+transplant\b/i, /\brehabilitation\b/i,
    /\bpreventive\s+care\b/i, /\boutpatient\b/i, /\binpatient\b/i,
    /\bcollision\b/i, /\bcomprehensive\b/i, /\bliability\b/i, /\buninsured\s+motorist\b/i,
    /\bdisability\b/i, /\bfuneral\s+expense\b/i, /\bpersonal\s+accident\b/i,
  ];
  for (const re of conditionKeywords) {
    if (re.test(text)) {
      const label = re.source
        .replace(/\\b/g, '').replace(/\\s\+/g, ' ').replace(/\\s\?\+?/g, '')
        .replace(/[-\s]*\?/g, '').replace(/\\/g, '').replace(/\(\?:.*?\)/g, '')
        .replace(/[()\\]/g, '').trim().toLowerCase();
      if (label && !coveredConditions.includes(label)) {
        coveredConditions.push(label);
      }
    }
  }

  // Extract terms: pull text from sections that describe coverage, benefits, exclusions
  const termsSections = [];
  const sectionRe = /(?:coverage|benefits?|exclusions?|terms?\s+(?:and\s+conditions?)?|what\s+(?:is|is\s+not)\s+covered|deductible|co[-\s]?pay|waiting\s+period|claim\s+(?:procedure|process))[\s\S]{0,800}/gi;
  let sm;
  while ((sm = sectionRe.exec(text)) !== null) {
    const section = sm[0].replace(/\s+/g, ' ').trim();
    if (section.length > 30) termsSections.push(section);
    if (termsSections.length >= 5) break;
  }
  const terms = termsSections.length > 0 ? termsSections.join(' | ') : null;

  const record = {
    name,
    provider: institution !== 'Unknown Institution' ? institution : null,
    type,
    policy_number: policyNumMatch ? policyNumMatch[1].trim() : null,
    premium_amount: premiumMatch ? parseFloat(premiumMatch[1].replace(/,/g, '')) : null,
    premium_frequency: 'monthly',
    coverage_amount: coverageMatch ? parseFloat(coverageMatch[1].replace(/,/g, '')) : null,
    start_date: normalizeDate(startMatch ? startMatch[1] : null),
    end_date: normalizeDate(endMatch ? endMatch[1] : null),
    renewal_date: normalizeDate(renewalMatch ? renewalMatch[1] : null),
    notes: null,
    terms,
    covered_conditions: coveredConditions,
  };

  return { import_type: 'insurance', records: [record] };
}

// ─── CAS (Consolidated Account Statement) Parser ─────────────────────────────

/**
 * Parse a CAS (Consolidated Account Statement) that lists multiple mutual fund
 * scheme portfolios with closing balances.
 *
 * Each scheme's "Closing Balance" line is extracted as an accounts record where
 * balance = current market value.  Falls back to parseBankStatement if no
 * closing balance lines are found.
 *
 * Typical CAS line formats:
 *   Closing Balance:  110.234  490.00  54,014.66
 *   Closing Balance   110.234  490.00  ₹54,014.66
 *   Closing Balance   110.234 units @ ₹490.00 = ₹54,014.66
 */
function parseCasStatement(text) {
  const records = [];
  const lines = text.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // Only process lines that begin with "Closing Balance"
    if (!/^closing\s+balance/i.test(line)) continue;

    // Extract all numbers from the line; the last (rightmost) is the market value,
    // the second-to-last is the NAV, and the first is the unit count.
    // Handles formats: "Closing Balance: 110.234  490.00  54,014.66"
    //                  "Closing Balance  110.234 units @ Rs. 490.00 = Rs. 54,014.66"
    const nums = [];
    const numRe = /[\d,]+(?:\.\d+)?/g;
    let nm;
    while ((nm = numRe.exec(line)) !== null) {
      const val = parseFloat(nm[0].replace(/,/g, ''));
      if (!isNaN(val)) nums.push(val);
    }

    // Need at least one number (the market value); largest single value is safest proxy
    // if only one number found.  With three numbers: [units, nav, marketValue].
    if (nums.length === 0) continue;
    const marketValue = nums[nums.length - 1];
    if (marketValue <= 0) continue;

    // Look backwards (up to 25 lines) to find the scheme name and AMC name
    let schemeName = null;
    let amcName = null;

    for (let j = i - 1; j >= Math.max(0, i - 25); j--) {
      const prev = lines[j].trim();
      if (!prev) continue;

      // Skip pure balance/transaction/header lines
      if (/\b(?:opening|closing|balance|transaction|date|amount|units?|nav|folio)\b/i.test(prev)) continue;

      // AMC/institution: line contains "Mutual Fund", "AMC", "Asset Management", or "Limited"
      if (!amcName && /\b(?:mutual\s+fund|amc|asset\s+management|trustee)\b/i.test(prev)) {
        amcName = prev.replace(/\s+/g, ' ').trim();
      }

      // Scheme name: line contains "Fund", "Growth", "Dividend", "Direct", "Regular", or "Plan"
      if (!schemeName &&
          /\b(?:fund|growth|dividend|direct|regular|plan|scheme)\b/i.test(prev) &&
          prev.length > 8) {
        schemeName = prev.replace(/\s*\(ISIN[^)]{0,20}\)/gi, '').replace(/\s+/g, ' ').trim();
      }

      if (schemeName && amcName) break;
    }

    records.push({
      name: schemeName || `Mutual Fund Scheme ${records.length + 1}`,
      institution: amcName || 'Mutual Fund',
      type: 'brokerage',
      currency: 'INR',
      balance: marketValue,
    });
  }

  // Fall back to generic bank-statement parsing if nothing was found
  if (records.length === 0) {
    return parseBankStatement(text);
  }

  return { import_type: 'accounts', records };
}



/**
 * Parse extracted PDF text into structured financial records.
 *
 * Flow:
 *   Pass 1 – AI extraction (parseWithAI)                    [when AI key available]
 *   Pass 2 – AI validation & refinement                     [when Pass 1 succeeded]
 *   Pass 3 – AI accuracy review (currency / amount / type)  [when Pass 2 succeeded]
 *   Fallback – pattern-based parser                         [when AI unavailable or Pass 1 returned 0 records]
 *
 * @param {string} text     – full PDF text
 * @param {object} options  – optional: { apiKey, apiUrl, model, forcePattern }
 * @returns {Promise<{ import_type, records, method, raw_preview, validation_notes }>}
 */
async function parseStatement(text, options = {}) {
  const raw_preview = text.slice(0, 2000);

  // Try AI first (if key available and not explicitly bypassed)
  if (!options.forcePattern) {
    try {
      const aiResult = await parseWithAI(text, options);
      if (aiResult && Array.isArray(aiResult.records) && aiResult.records.length > 0) {
        // Pass 2: validate and refine the initial extraction
        let pass2Result = null;
        try {
          const refined = await validateAndRefineWithAI(text, aiResult, options);
          // Accept the refined result when it has records and its import_type is either
          // unchanged (most common) or clearly correcting an obvious misclassification.
          // When the import_type changes we additionally verify that the records contain
          // the required key for the new type (to avoid schema mismatches).
          // We still require it not to silently drop records compared to Pass 1.
          const REQUIRED_KEY = { accounts: 'balance', assets: 'current_value', liabilities: 'current_balance', insurance: 'premium_amount', sip: 'amount' };
          const typeChanged = refined && refined.import_type !== aiResult.import_type;
          const schemaOk = !typeChanged ||
            (Array.isArray(refined.records) && refined.records.length > 0 &&
             REQUIRED_KEY[refined.import_type] &&
             refined.records[0][REQUIRED_KEY[refined.import_type]] !== undefined);
          if (
            refined &&
            Array.isArray(refined.records) &&
            refined.records.length >= aiResult.records.length &&
            schemaOk
          ) {
            pass2Result = refined;
          }
        } catch (_validateErr) {
          // Validation pass failed — fall through to Pass 3 with Pass 1 result
        }

        // Pass 3: specialist accuracy review (currency, amount magnitude, type classification)
        // Only run when Pass 2 actually made corrections — if validation_notes is empty,
        // Pass 1 was already accurate and there is nothing for Pass 3 to catch.
        if (pass2Result && pass2Result.validation_notes.length > 0) {
          try {
            const accurate = await reviewFieldAccuracy(text, pass2Result, options);
            if (accurate && Array.isArray(accurate.records) && accurate.records.length > 0) {
              return {
                import_type: accurate.import_type,
                records: accurate.records,
                method: 'ai',
                raw_preview,
                validation_notes: [
                  ...pass2Result.validation_notes,
                  ...(accurate.accuracy_notes || []),
                ],
              };
            }
          } catch (_accuracyErr) {
            // Pass 3 failed — fall through to return Pass 2 result
          }
        }

        if (pass2Result) {
          return {
            import_type: pass2Result.import_type,
            records: pass2Result.records,
            method: 'ai',
            raw_preview,
            validation_notes: pass2Result.validation_notes,
          };
        }
        return { ...aiResult, method: 'ai', raw_preview, validation_notes: [] };
      }
    } catch (_err) {
      // AI failed — fall through to pattern parser silently
    }
  }

  // Pattern-based fallback
  const stmtType = detectStatementType(text);
  const result =
    stmtType === 'cas'
      ? parseCasStatement(text)
      : stmtType === 'sip'
        ? parseSipStatement(text)
        : stmtType === 'liabilities'
          ? parseLiabilityStatement(text)
          : stmtType === 'insurance'
            ? parseInsuranceDocument(text)
            : parseBankStatement(text);

  return { ...result, method: 'pattern', raw_preview, validation_notes: [] };
}

module.exports = { parseStatement, detectStatementType, parseCasStatement };
