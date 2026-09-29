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

// A card page wrapped in the usual noise: summary box (column layout with the due date
// after the amounts), limits, account summary, reward points, an interest illustration
// with its own dates, and terms. Only the three rows under the table header are real.
const NOISY_CARD_LINES = [
  'HDFC Bank Credit Card Statement',
  'Card No: 4893 XXXX XXXX 1234   Statement Date 31/08/2026',
  'Total Amount Due   Minimum Amount Due   Payment Due Date',
  '12,300.00   615.00   20/09/2026',
  'Credit Limit 2,00,000.00 Available Credit Limit 1,87,700.00 Available Cash Limit 40,000.00',
  'Account Summary',
  'Previous Balance 20,000.00 Payments/Credits 21,000.00 Purchases/Debits 13,300.00 Finance Charges 0.00 Total Dues 12,300.00',
  'Date Transaction Description Amount',
  '02/08/2026 SWIGGY BANGALORE 800.00',
  '06/08/2026 PAYMENT RECEIVED - THANK YOU 20,000.00 Cr',
  '12/08/2026 AMAZON REFUND 1,000.00 Cr',
  'Reward Points Summary Opening 1,200 Earned 150',
  'Illustration of interest calculation: if you purchase goods worth Rs 10,000.00 on 10/04/2026 and pay the minimum amount due of Rs 500.00 on 15/05/2026,',
  'interest of Rs 342.00 will be charged on 15/05/2026 on the outstanding amount of Rs 9,500.00',
  'Late payment charges: Rs 100.00 for balance up to 500.00',
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

module.exports = {
  BANK_LINES, CARD_LINES, NOISY_CARD_LINES,
  NOISY_CARD_TEXT: NOISY_CARD_LINES.join('\n'),
  BANK_TEXT: BANK_LINES.join('\n'),
  CARD_TEXT: CARD_LINES.join('\n'),
  BANK_CSV, BANK_CSV_HEADER, BANK_CSV_ROWS, CARD_CSV,
  makePdf,
  mockAi,
};
