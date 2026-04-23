/**
 * statementParser.js  (frontend)
 *
 * Browser-side port of backend/src/utils/statementParser.js.
 *
 * On Android (Capacitor native) the AI key is read from @capacitor/preferences
 * instead of environment variables.  Pass `options.apiKey` explicitly, or call
 * getAiSettings() from aiSettings.js to obtain the stored key.
 *
 * Parsed output shape:
 *  { import_type, records, method, raw_preview, validation_notes }
 */

const MAX_AI_INPUT_CHARS = 100000;

const AI_SYSTEM_PROMPT = `You are a financial document parser. The user will send you raw text from a financial document (bank statement, investment statement, loan statement, insurance policy document, SIP/mutual fund transaction statement, CAS (Consolidated Account Statement), or any other financial record).

Your task is to identify the financial records in the text and return structured JSON in EXACTLY this format – no markdown fences, no prose, only the JSON object:
{
  "import_type": "<accounts|assets|liabilities|insurance|sip>",
  "records": [ ... ]
}

For "accounts" records use:
{ "name": string, "institution": string, "type": "<checking|savings|money_market|cd|brokerage|401k|ira|roth_ira|pension|other>", "currency": "USD", "balance": number }

For "assets" records use:
{ "name": string, "category": "<real_estate|vehicle|crypto|collectible|business|other>", "acquisition_date": "YYYY-MM-DD|null", "acquisition_cost": number|null, "current_value": number }

For "liabilities" records use:
{ "name": string, "lender": string, "type": "<mortgage|auto|student|personal|credit_card|heloc|other>", "original_principal": number|null, "current_balance": number, "interest_rate": number|null, "minimum_payment": number|null }

For "insurance" records use:
{ "name": string, "provider": string|null, "type": "<life|term_life|health|dental|vision|auto|home|renters|disability|umbrella|travel|pet|business|other>", "policy_number": string|null, "premium_amount": number|null, "premium_frequency": "<monthly|quarterly|semi_annual|annual|one_time>", "coverage_amount": number|null, "start_date": "YYYY-MM-DD|null", "end_date": "YYYY-MM-DD|null", "renewal_date": "YYYY-MM-DD|null", "notes": string|null }

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
- When a single document contains both account balances and loan/liability details, prefer returning the type that has more records, or return all records as the detected dominant type.`;

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
- Preserve the import_type from the initial extraction exactly as provided; do not change, infer, or reclassify it during validation.
- Add any records that are clearly present in the raw text but were missed in the initial extraction.
- Correct any field values that do not match what is stated in the raw text.
- Fill in null fields where the value is clearly present in the raw text.
- Remove records that have no basis in the raw text.
- validation_notes must be an array of short human-readable strings, one entry per change made. If no changes were needed, return an empty array [].
- Convert all monetary values to plain positive numbers (no $ or ₹ signs, no commas, no negative signs).
- Liabilities current_balance must always be a positive number.
- Return ONLY the JSON, nothing else.`;

// ─── AI Parsing ───────────────────────────────────────────────────────────────

async function parseWithAI(text, options = {}) {
  const { apiKey, apiUrl = 'https://api.openai.com/v1', model = 'gpt-4o-mini' } = options;
  if (!apiKey) return null;

  const truncated = text.slice(0, MAX_AI_INPUT_CHARS);
  const response = await fetch(`${apiUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
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

async function validateAndRefineWithAI(text, initialResult, options = {}) {
  const { apiKey, apiUrl = 'https://api.openai.com/v1', model = 'gpt-4o-mini' } = options;
  if (!apiKey) return null;

  const truncated = text.slice(0, MAX_AI_INPUT_CHARS);
  const userMessage =
    `RAW TEXT:\n${truncated}\n\n` +
    `INITIAL EXTRACTION:\n${JSON.stringify(initialResult, null, 2)}`;

  const response = await fetch(`${apiUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
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

// ─── Pattern-based Fallback ───────────────────────────────────────────────────

function normalizeDate(s) {
  if (!s) return null;
  s = s.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const mmmMatch = s.match(/^(\d{1,2})[-\s/](Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[-\s/](\d{2,4})$/i);
  if (mmmMatch) {
    const MONTHS = { jan:'01',feb:'02',mar:'03',apr:'04',may:'05',jun:'06',jul:'07',aug:'08',sep:'09',oct:'10',nov:'11',dec:'12' };
    // 2-digit years are assumed to be in the 2000s (e.g. "25" → "2025").
    // Financial documents from before 2000 are out of scope for this parser.
    const year = mmmMatch[3].length === 2 ? `20${mmmMatch[3]}` : mmmMatch[3];
    const month = MONTHS[mmmMatch[2].toLowerCase()];
    return `${year}-${month}-${mmmMatch[1].padStart(2, '0')}`;
  }
  const parts = s.split(/[/-]/);
  if (parts.length === 3) {
    const [a, b, c] = parts;
    const year = c.length === 2 ? `20${c}` : c;
    return `${year}-${a.padStart(2, '0')}-${b.padStart(2, '0')}`;
  }
  return null;
}

function detectStatementType(text) {
  const lower = text.toLowerCase();
  if (
    /\bconsolidated\s+account\s+statement\b/.test(lower) ||
    (/\bfolio\b/.test(lower) && /\bclosing\s+balance\b/.test(lower))
  ) return 'cas';
  if (
    /\bsystematic\s+investment\s+plan\b/.test(lower) ||
    /\bsip\s*(?:purchase|installment|debit|transaction)\b/.test(lower) ||
    (/\bfolio\b/.test(lower) && /\bnav\b/.test(lower)) ||
    /\bunits\s+allotted\b/.test(lower)
  ) return 'sip';
  if (
    /\b(insurance\s+policy|policy\s+number|premium\s+(?:due|payment|amount)|coverage\s+amount|insured|beneficiary|deductible|insurance\s+certificate|renewal\s+date|policy\s+holder)\b/.test(lower)
  ) return 'insurance';
  if (
    /\b(mortgage|loan\s+number|loan\s+balance|principal\s+balance|outstanding\s+balance|heloc|credit\s+card\s+statement|minimum\s+payment\s+due)\b/.test(lower)
  ) return 'liabilities';
  if (
    /\b(portfolio|holdings|shares|symbol|ticker|401\s*k|ira|brokerage|mutual\s+fund|etf|dividend|investment\s+account)\b/.test(lower)
  ) return 'accounts';
  return 'accounts';
}

function extractInstitution(text) {
  const firstBlock = text.slice(0, 400);
  const patterns = [
    /(?:bank|financial|credit union|fidelity|vanguard|schwab|merrill|wells fargo|chase|citi|bofa|bank of america|td bank|us bank|pnc|ally|capital one|discover|morgan stanley|edward jones)\w*/gi,
  ];
  for (const re of patterns) {
    const m = firstBlock.match(re);
    if (m) return m[0].replace(/\s+/g, ' ').trim();
  }
  const header = firstBlock.match(/^([A-Z][A-Za-z&,.\s]{3,40})/m);
  return header ? header[1].trim() : 'Unknown Institution';
}

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

function parseBankStatement(text) {
  const institution = extractInstitution(text);
  const records = [];
  const balancePatterns = [
    /(?:ending|closing|available|current|account)\s+balance[:\s]+(?:\$|₹|Rs\.?)?\s*([\d,]+(?:\.\d{1,2})?)/gi,
    /(?:total|portfolio)\s+value[:\s]+(?:\$|₹|Rs\.?)?\s*([\d,]+(?:\.\d{1,2})?)/gi,
    /balance\s+as\s+of[^$₹\n]*(?:\$|₹|Rs\.?)?\s*([\d,]+(?:\.\d{1,2})?)/gi,
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
        const before = text.slice(Math.max(0, m.index - 150), m.index);
        const nameMatch = before.match(/(?:account name|account\s*:)[:\s]+([A-Za-z0-9 &\-]+)/i)
          || before.match(/([A-Z][A-Za-z &\-]{3,30}(?:Checking|Savings|Account|Plus|Premier|Select|Gold|Silver))/);
        const name = nameMatch ? nameMatch[1].trim() : `${institution} Account`;
        const matchLine = m[0].toLowerCase();
        const context = (before + m[0]).toLowerCase();
        let type = 'other';
        if (/fixed\s*deposit/.test(matchLine)) type = 'cd';
        else if (/checking/.test(context)) type = 'checking';
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
  if (records.length === 0) {
    const totalLine = text.match(/(?:total|net)\s+(?:assets?|balance|worth)[^$₹\n]*(?:\$|₹|Rs\.?)?\s*([\d,]+(?:\.\d{1,2})?)/i);
    if (totalLine) {
      const balance = parseFloat(totalLine[1].replace(/,/g, ''));
      records.push({ name: `${institution} Account`, institution, type: 'other', currency: 'USD', balance });
    } else {
      const amounts = extractAmounts(text);
      if (amounts.length > 0) {
        records.push({ name: `${institution} Account`, institution, type: 'other', currency: 'USD', balance: amounts[0] });
      }
    }
  }
  return { import_type: 'accounts', records };
}

function parseLiabilityStatement(text) {
  const institution = extractInstitution(text);
  const records = [];
  const loanNameMatch = text.match(/(?:loan\s+type|account\s+type|account\s+name)\s*:\s*([A-Za-z0-9 \-]+)/i);
  const name = loanNameMatch ? loanNameMatch[1].trim() : `${institution} Loan`;
  const balanceMatch = text.match(
    /(?:current|outstanding|remaining|principal)\s+balance[:\s]+\$?\s*([\d,]+(?:\.\d{1,2})?)/i
  ) || text.match(/balance[:\s]+\$?\s*([\d,]+(?:\.\d{1,2})?)/i);
  const originalMatch = text.match(/(?:original|total)\s+(?:loan\s+)?(?:amount|principal)[:\s]+\$?\s*([\d,]+(?:\.\d{1,2})?)/i);
  const rateMatch = text.match(/(?:interest|apr|annual\s+percentage)\s+rate[:\s]+\s*([\d.]+)\s*%/i);
  const minPayMatch = text.match(/(?:minimum|minimum\s+payment|monthly\s+payment|payment\s+due)[:\s]+\$?\s*([\d,]+(?:\.\d{1,2})?)/i);
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
      name, lender: institution, type,
      original_principal: originalMatch ? parseFloat(originalMatch[1].replace(/,/g, '')) : null,
      current_balance: Math.abs(parseFloat(balanceMatch[1].replace(/,/g, ''))),
      interest_rate: rateMatch ? parseFloat(rateMatch[1]) : null,
      minimum_payment: minPayMatch ? parseFloat(minPayMatch[1].replace(/,/g, '')) : null,
    });
  }
  return { import_type: 'liabilities', records };
}

function parseSipStatement(text) {
  const records = [];
  const schemeNames = [];
  for (const m of text.matchAll(/scheme(?:\s+name)?[ \t:]+([A-Za-z0-9 \-&()/]+?)(?:\r?\n|ISIN|folio|\s{3,})/gi)) {
    const name = m[1].trim();
    if (name && !schemeNames.includes(name)) schemeNames.push(name);
  }
  const tabRe = /(\d{1,2}[-/](?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[-/]\d{2,4}|\d{4}-\d{2}-\d{2}|\d{1,2}[-/]\d{1,2}[-/]\d{2,4})\s+(?:SIP[- ]?(?:Purchase|Installment|Debit)?|Purchase|Systematic Investment)\s*([\d,]+(?:\.\d{1,2})?)\s+([\d.]+)\s+([\d.]+)/gi;
  let m;
  let si = 0;
  while ((m = tabRe.exec(text)) !== null) {
    const schemeName = schemeNames[si] || schemeNames[0] || 'SIP';
    records.push({
      name: schemeName, symbol: null,
      amount: parseFloat(m[2].replace(/,/g, '')),
      units: parseFloat(m[3]),
      nav: parseFloat(m[4]),
      installment_date: normalizeDate(m[1]) || new Date().toISOString().slice(0, 10),
    });
    si++;
  }
  if (records.length === 0) {
    const amtMatch = text.match(/(?:amount|invested)[ \t:]+(?:Rs\.?|₹|INR)?\s*([\d,]+(?:\.\d{1,2})?)/i);
    const unitsMatch = text.match(/units?(?:\s+allotted|\s+purchased)?[ \t:]+\s*([\d.]+)/i);
    const navMatch = text.match(/\bNAV[ \t:]+(?:Rs\.?|₹|INR)?\s*([\d.]+)/i);
    const dateMatch = text.match(
      /(?:transaction\s+date|sip\s+date|date)[ \t:]+(\d{1,2}[-/](?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[-/]\d{2,4}|\d{4}-\d{2}-\d{2}|\d{1,2}[-/]\d{1,2}[-/]\d{2,4})/i
    );
    if (amtMatch) {
      records.push({
        name: schemeNames[0] || 'SIP', symbol: null,
        amount: parseFloat(amtMatch[1].replace(/,/g, '')),
        units: unitsMatch ? parseFloat(unitsMatch[1]) : null,
        nav: navMatch ? parseFloat(navMatch[1]) : null,
        installment_date: (dateMatch && normalizeDate(dateMatch[1])) || new Date().toISOString().slice(0, 10),
      });
    }
  }
  return { import_type: 'sip', records };
}

function parseInsuranceDocument(text) {
  const institution = extractInstitution(text);
  const nameMatch = text.match(/(?:policy\s+(?:name|type)|coverage\s+type|plan\s+name|product\s+name)[ \t:]{1,20}([A-Za-z0-9 \-]+)/i);
  const name = nameMatch ? nameMatch[1].trim() : `${institution} Insurance`;
  const policyNumMatch = text.match(/policy\s+(?:number|no\.?|#)[ \t:]{1,20}([A-Z0-9\-]+)/i);
  const premiumMatch = text.match(/(?:premium|payment)[ \t:]{1,30}\$?\s*([\d,]+(?:\.\d{1,2})?)/i);
  const coverageMatch = text.match(/(?:coverage|face\s+value|sum\s+assured|benefit\s+amount)[ \t:]{1,30}\$?\s*([\d,]+(?:\.\d{1,2})?)/i);
  const startMatch = text.match(/(?:effective\s+date|start\s+date|policy\s+start)[ \t:]{1,20}(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}|\d{4}-\d{2}-\d{2})/i);
  const endMatch = text.match(/(?:expiry\s+date|expiration\s+date|end\s+date|policy\s+end)[ \t:]{1,20}(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}|\d{4}-\d{2}-\d{2})/i);
  const renewalMatch = text.match(/(?:renewal\s+date|renews\s+on)[ \t:]{1,20}(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}|\d{4}-\d{2}-\d{2})/i);
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
  const record = {
    name, provider: institution !== 'Unknown Institution' ? institution : null,
    type, policy_number: policyNumMatch ? policyNumMatch[1].trim() : null,
    premium_amount: premiumMatch ? parseFloat(premiumMatch[1].replace(/,/g, '')) : null,
    premium_frequency: 'monthly',
    coverage_amount: coverageMatch ? parseFloat(coverageMatch[1].replace(/,/g, '')) : null,
    start_date: normalizeDate(startMatch ? startMatch[1] : null),
    end_date: normalizeDate(endMatch ? endMatch[1] : null),
    renewal_date: normalizeDate(renewalMatch ? renewalMatch[1] : null),
    notes: null,
  };
  return { import_type: 'insurance', records: [record] };
}

function parseCasStatement(text) {
  const records = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!/^closing\s+balance/i.test(line)) continue;
    const nums = [];
    const numRe = /[\d,]+(?:\.\d+)?/g;
    let nm;
    while ((nm = numRe.exec(line)) !== null) {
      const val = parseFloat(nm[0].replace(/,/g, ''));
      if (!isNaN(val)) nums.push(val);
    }
    if (nums.length === 0) continue;
    const marketValue = nums[nums.length - 1];
    if (marketValue <= 0) continue;
    let schemeName = null;
    let amcName = null;
    for (let j = i - 1; j >= Math.max(0, i - 25); j--) {
      const prev = lines[j].trim();
      if (!prev) continue;
      if (/\b(?:opening|closing|balance|transaction|date|amount|units?|nav|folio)\b/i.test(prev)) continue;
      if (!amcName && /\b(?:mutual\s+fund|amc|asset\s+management|trustee)\b/i.test(prev)) {
        amcName = prev.replace(/\s+/g, ' ').trim();
      }
      if (!schemeName && /\b(?:fund|growth|dividend|direct|regular|plan|scheme)\b/i.test(prev) && prev.length > 8) {
        schemeName = prev.replace(/\s*\(ISIN[^)]{0,20}\)/gi, '').replace(/\s+/g, ' ').trim();
      }
      if (schemeName && amcName) break;
    }
    records.push({
      name: schemeName || `Mutual Fund Scheme ${records.length + 1}`,
      institution: amcName || 'Mutual Fund',
      type: 'brokerage', currency: 'INR', balance: marketValue,
    });
  }
  if (records.length === 0) return parseBankStatement(text);
  return { import_type: 'accounts', records };
}

// ─── Main entry point ─────────────────────────────────────────────────────────

/**
 * Parse extracted text into structured financial records.
 *
 * @param {string} text     – raw text (from PDF or user paste)
 * @param {object} options  – { apiKey?, apiUrl?, model?, forcePattern? }
 * @returns {Promise<{ import_type, records, method, raw_preview, validation_notes }>}
 */
export async function parseStatement(text, options = {}) {
  const raw_preview = text.slice(0, 2000);

  if (!options.forcePattern) {
    try {
      const aiResult = await parseWithAI(text, options);
      if (aiResult && Array.isArray(aiResult.records) && aiResult.records.length > 0) {
        try {
          const refined = await validateAndRefineWithAI(text, aiResult, options);
          if (
            refined &&
            Array.isArray(refined.records) &&
            refined.records.length >= aiResult.records.length &&
            refined.import_type === aiResult.import_type
          ) {
            return { import_type: refined.import_type, records: refined.records, method: 'ai', raw_preview, validation_notes: refined.validation_notes };
          }
        } catch (_) {
          // validation failed — use Pass 1 result
        }
        return { ...aiResult, method: 'ai', raw_preview, validation_notes: [] };
      }
    } catch (_) {
      // AI failed — fall through to pattern
    }
  }

  const stmtType = detectStatementType(text);
  const result =
    stmtType === 'cas' ? parseCasStatement(text)
    : stmtType === 'sip' ? parseSipStatement(text)
    : stmtType === 'liabilities' ? parseLiabilityStatement(text)
    : stmtType === 'insurance' ? parseInsuranceDocument(text)
    : parseBankStatement(text);

  return { ...result, method: 'pattern', raw_preview, validation_notes: [] };
}
