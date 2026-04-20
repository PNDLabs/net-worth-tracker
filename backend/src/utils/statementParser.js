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
 *    import_type : 'accounts' | 'assets' | 'liabilities',
 *    records     : Array<object>,
 *    method      : 'ai' | 'pattern',
 *    raw_preview : string   // first 2000 chars of extracted text
 *  }
 */

// Maximum characters of PDF text sent to the AI model.
// ~12 000 chars ≈ 3 000 tokens at the typical 4 chars/token ratio,
// which fits well within gpt-4o-mini's 128k context while keeping costs low.
const MAX_AI_INPUT_CHARS = 12000;

const AI_SYSTEM_PROMPT = `You are a financial document parser. The user will send you the raw text extracted from a PDF bank, investment, or loan statement.

Your task is to identify the financial records in the text and return structured JSON in EXACTLY this format – no markdown fences, no prose, only the JSON object:
{
  "import_type": "<accounts|assets|liabilities>",
  "records": [ ... ]
}

For "accounts" records use:
{ "name": string, "institution": string, "type": "<checking|savings|money_market|cd|brokerage|401k|ira|roth_ira|pension|other>", "currency": "USD", "balance": number }

For "assets" records use:
{ "name": string, "category": "<real_estate|vehicle|crypto|collectible|business|other>", "acquisition_date": "YYYY-MM-DD|null", "acquisition_cost": number|null, "current_value": number }

For "liabilities" records use:
{ "name": string, "lender": string, "type": "<mortgage|auto|student|personal|credit_card|heloc|other>", "original_principal": number|null, "current_balance": number, "interest_rate": number|null, "minimum_payment": number|null }

Rules:
- Return ONLY the JSON, nothing else.
- If you cannot identify any records, return {"import_type":"accounts","records":[]}.
- Convert all monetary values to plain numbers (no $ signs or commas).
- If a field is unknown, use null.
- For investment/brokerage accounts include the total value as the balance.`;

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
      max_tokens: 2048,
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

// ─── Pattern-based Fallback ───────────────────────────────────────────────────

/**
 * Detect the dominant statement type from the full text.
 */
function detectStatementType(text) {
  const lower = text.toLowerCase();

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
 */
function extractAmounts(text) {
  const re = /\$?\s*(\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?)/g;
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
  const records = [];

  // Look for labelled balance lines
  const balancePatterns = [
    /(?:ending|closing|available|current|account)\s+balance[:\s]+\$?\s*([\d,]+(?:\.\d{1,2})?)/gi,
    /(?:total|portfolio)\s+value[:\s]+\$?\s*([\d,]+(?:\.\d{1,2})?)/gi,
    /balance\s+as\s+of[^$\n]*\$?\s*([\d,]+(?:\.\d{1,2})?)/gi,
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
        const context = (before + m[0]).toLowerCase();
        let type = 'other';
        if (/checking/.test(context)) type = 'checking';
        else if (/saving/.test(context)) type = 'savings';
        else if (/money\s*market/.test(context)) type = 'money_market';
        else if (/cd|certificate/.test(context)) type = 'cd';
        else if (/401\s*k/.test(context)) type = '401k';
        else if (/roth/.test(context)) type = 'roth_ira';
        else if (/ira/.test(context)) type = 'ira';
        else if (/brokerage|portfolio|invest/.test(context)) type = 'brokerage';

        records.push({ name, institution, type, currency: 'USD', balance });
      }
    }
  }

  // If no labelled balances found, try the largest amounts on "total" lines
  if (records.length === 0) {
    const totalLine = text.match(/(?:total|net)\s+(?:assets?|balance|worth)[^$\n]*\$?\s*([\d,]+(?:\.\d{1,2})?)/i);
    if (totalLine) {
      const balance = parseFloat(totalLine[1].replace(/,/g, ''));
      records.push({ name: `${institution} Account`, institution, type: 'other', currency: 'USD', balance });
    } else {
      // Last resort: largest dollar amount found
      const amounts = extractAmounts(text);
      if (amounts.length > 0) {
        records.push({ name: `${institution} Account`, institution, type: 'other', currency: 'USD', balance: amounts[0] });
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
      current_balance: parseFloat(balanceMatch[1].replace(/,/g, '')),
      interest_rate: rateMatch ? parseFloat(rateMatch[1]) : null,
      minimum_payment: minPayMatch ? parseFloat(minPayMatch[1].replace(/,/g, '')) : null,
    });
  }

  return { import_type: 'liabilities', records };
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Parse extracted PDF text into structured financial records.
 *
 * @param {string} text     – full PDF text
 * @param {object} options  – optional: { apiKey, apiUrl, model, forcePattern }
 * @returns {Promise<{ import_type, records, method, raw_preview }>}
 */
async function parseStatement(text, options = {}) {
  const raw_preview = text.slice(0, 2000);

  // Try AI first (if key available and not explicitly bypassed)
  if (!options.forcePattern) {
    try {
      const aiResult = await parseWithAI(text, options);
      if (aiResult && Array.isArray(aiResult.records) && aiResult.records.length > 0) {
        return { ...aiResult, method: 'ai', raw_preview };
      }
    } catch (_err) {
      // AI failed — fall through to pattern parser silently
    }
  }

  // Pattern-based fallback
  const stmtType = detectStatementType(text);
  const result =
    stmtType === 'liabilities'
      ? parseLiabilityStatement(text)
      : parseBankStatement(text);

  return { ...result, method: 'pattern', raw_preview };
}

module.exports = { parseStatement, detectStatementType };
