const request = require('supertest');
const { createApp } = require('../src/app');
const { createDatabase } = require('../src/db/database');

// Override getDb to use a fresh in-memory DB per test
const dbModule = require('../src/db/database');

let testDb;
let app;

beforeEach(() => {
  testDb = createDatabase(':memory:');
  jest.spyOn(dbModule, 'getDb').mockReturnValue(testDb);
  app = createApp();
});

afterEach(() => {
  testDb.close();
  jest.restoreAllMocks();
});

// ─── Accounts ────────────────────────────────────────────────────────────────

describe('Accounts API', () => {
  test('GET /api/accounts - returns empty array initially', async () => {
    const res = await request(app).get('/api/accounts');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  test('POST /api/accounts - creates an account', async () => {
    const res = await request(app).post('/api/accounts').send({
      name: 'Chase Checking',
      institution: 'Chase',
      type: 'checking',
      currency: 'USD',
      balance: 5000,
    });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('Chase Checking');
    expect(res.body.balance).toBe(5000);
    expect(res.body.id).toBeDefined();
  });

  test('POST /api/accounts - rejects missing name', async () => {
    const res = await request(app).post('/api/accounts').send({ balance: 100 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/name/i);
  });

  test('POST /api/accounts - rejects invalid type', async () => {
    const res = await request(app).post('/api/accounts').send({ name: 'X', type: 'invalid' });
    expect(res.status).toBe(400);
  });

  test('GET /api/accounts - returns created accounts', async () => {
    await request(app).post('/api/accounts').send({ name: 'Acct A', type: 'savings', balance: 1000 });
    await request(app).post('/api/accounts').send({ name: 'Acct B', type: 'checking', balance: 2000 });
    const res = await request(app).get('/api/accounts');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
  });

  test('GET /api/accounts/:id - returns single account', async () => {
    const created = await request(app).post('/api/accounts').send({ name: 'Solo', type: 'cd', balance: 10000 });
    const res = await request(app).get(`/api/accounts/${created.body.id}`);
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Solo');
  });

  test('GET /api/accounts/:id - 404 for unknown id', async () => {
    const res = await request(app).get('/api/accounts/9999');
    expect(res.status).toBe(404);
  });

  test('PUT /api/accounts/:id - updates balance', async () => {
    const created = await request(app).post('/api/accounts').send({ name: 'UpdateMe', type: 'checking', balance: 100 });
    const res = await request(app).put(`/api/accounts/${created.body.id}`).send({ balance: 999 });
    expect(res.status).toBe(200);
    expect(res.body.balance).toBe(999);
  });

  test('DELETE /api/accounts/:id - deletes account', async () => {
    const created = await request(app).post('/api/accounts').send({ name: 'DeleteMe', type: 'checking', balance: 0 });
    const del = await request(app).delete(`/api/accounts/${created.body.id}`);
    expect(del.status).toBe(200);
    const get = await request(app).get(`/api/accounts/${created.body.id}`);
    expect(get.status).toBe(404);
  });
});

// ─── Holdings ────────────────────────────────────────────────────────────────

describe('Holdings API', () => {
  let accountId;
  beforeEach(async () => {
    const res = await request(app).post('/api/accounts').send({ name: 'Brokerage', type: 'brokerage', balance: 0 });
    accountId = res.body.id;
  });

  test('GET /api/accounts/:id/holdings - empty initially', async () => {
    const res = await request(app).get(`/api/accounts/${accountId}/holdings`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  test('POST /api/accounts/:id/holdings - adds a holding', async () => {
    const res = await request(app).post(`/api/accounts/${accountId}/holdings`).send({
      symbol: 'AAPL',
      shares: 10,
      current_price: 180,
      current_value: 1800,
    });
    expect(res.status).toBe(201);
    expect(res.body.symbol).toBe('AAPL');
    expect(res.body.shares).toBe(10);
  });

  test('POST /api/accounts/:id/holdings - rejects missing symbol', async () => {
    const res = await request(app).post(`/api/accounts/${accountId}/holdings`).send({ shares: 5 });
    expect(res.status).toBe(400);
  });
});

// ─── Assets ──────────────────────────────────────────────────────────────────

describe('Assets API', () => {
  test('GET /api/assets - returns empty array initially', async () => {
    const res = await request(app).get('/api/assets');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  test('POST /api/assets - creates an asset', async () => {
    const res = await request(app).post('/api/assets').send({
      name: 'Home',
      category: 'real_estate',
      acquisition_cost: 300000,
      current_value: 350000,
    });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('Home');
    expect(res.body.current_value).toBe(350000);
  });

  test('POST /api/assets - rejects missing name', async () => {
    const res = await request(app).post('/api/assets').send({ current_value: 100 });
    expect(res.status).toBe(400);
  });

  test('POST /api/assets - rejects invalid category', async () => {
    const res = await request(app).post('/api/assets').send({ name: 'X', category: 'invalid' });
    expect(res.status).toBe(400);
  });

  test('PUT /api/assets/:id - updates current value', async () => {
    const created = await request(app).post('/api/assets').send({ name: 'Car', category: 'vehicle', current_value: 20000 });
    const res = await request(app).put(`/api/assets/${created.body.id}`).send({ current_value: 18000 });
    expect(res.status).toBe(200);
    expect(res.body.current_value).toBe(18000);
  });

  test('DELETE /api/assets/:id - deletes asset', async () => {
    const created = await request(app).post('/api/assets').send({ name: 'Junk', category: 'other', current_value: 0 });
    await request(app).delete(`/api/assets/${created.body.id}`);
    const res = await request(app).get(`/api/assets/${created.body.id}`);
    expect(res.status).toBe(404);
  });
});

// ─── Liabilities ─────────────────────────────────────────────────────────────

describe('Liabilities API', () => {
  test('GET /api/liabilities - returns empty array initially', async () => {
    const res = await request(app).get('/api/liabilities');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  test('POST /api/liabilities - creates a liability', async () => {
    const res = await request(app).post('/api/liabilities').send({
      name: 'Home Mortgage',
      lender: 'Wells Fargo',
      type: 'mortgage',
      original_principal: 400000,
      current_balance: 380000,
      interest_rate: 3.5,
    });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('Home Mortgage');
    expect(res.body.current_balance).toBe(380000);
  });

  test('POST /api/liabilities - rejects missing name', async () => {
    const res = await request(app).post('/api/liabilities').send({ current_balance: 5000 });
    expect(res.status).toBe(400);
  });

  test('POST /api/liabilities - rejects invalid type', async () => {
    const res = await request(app).post('/api/liabilities').send({ name: 'X', type: 'bad' });
    expect(res.status).toBe(400);
  });

  test('PUT /api/liabilities/:id - updates current balance', async () => {
    const created = await request(app).post('/api/liabilities').send({ name: 'Car Loan', type: 'auto', current_balance: 15000 });
    const res = await request(app).put(`/api/liabilities/${created.body.id}`).send({ current_balance: 14500 });
    expect(res.status).toBe(200);
    expect(res.body.current_balance).toBe(14500);
  });

  test('DELETE /api/liabilities/:id - deletes liability', async () => {
    const created = await request(app).post('/api/liabilities').send({ name: 'Del', type: 'personal', current_balance: 0 });
    await request(app).delete(`/api/liabilities/${created.body.id}`);
    const res = await request(app).get(`/api/liabilities/${created.body.id}`);
    expect(res.status).toBe(404);
  });
});

// ─── Net Worth ────────────────────────────────────────────────────────────────

describe('Net Worth API', () => {
  test('GET /api/networth - returns zero values when no data', async () => {
    const res = await request(app).get('/api/networth');
    expect(res.status).toBe(200);
    expect(res.body.netWorth).toBe(0);
    expect(res.body.totalAssets).toBe(0);
    expect(res.body.totalLiabilities).toBe(0);
  });

  test('GET /api/networth - calculates correctly across accounts, assets, liabilities', async () => {
    await request(app).post('/api/accounts').send({ name: 'Bank', type: 'checking', balance: 10000 });
    await request(app).post('/api/assets').send({ name: 'Car', category: 'vehicle', current_value: 20000 });
    await request(app).post('/api/liabilities').send({ name: 'Loan', type: 'personal', current_balance: 5000 });

    const res = await request(app).get('/api/networth');
    expect(res.status).toBe(200);
    expect(res.body.totalAssets).toBe(30000);
    expect(res.body.totalLiabilities).toBe(5000);
    expect(res.body.netWorth).toBe(25000);
  });

  test('POST /api/networth/snapshots - creates a snapshot', async () => {
    await request(app).post('/api/accounts').send({ name: 'Bank', type: 'savings', balance: 50000 });
    const res = await request(app).post('/api/networth/snapshots').send({ notes: 'Monthly check' });
    expect(res.status).toBe(201);
    expect(res.body.net_worth).toBe(50000);
    expect(res.body.notes).toBe('Monthly check');
  });

  test('GET /api/networth/snapshots - lists snapshots', async () => {
    await request(app).post('/api/networth/snapshots').send({});
    await request(app).post('/api/networth/snapshots').send({});
    const res = await request(app).get('/api/networth/snapshots');
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThanOrEqual(2);
  });
});

// ─── Import ───────────────────────────────────────────────────────────────────

describe('Import API', () => {
  test('POST /api/import/csv - imports accounts from CSV', async () => {
    const csv = `name,institution,type,currency,balance
Chase Checking,Chase,checking,USD,5000
Savings Account,BoA,savings,USD,12000`;

    const res = await request(app)
      .post('/api/import/csv?import_type=accounts')
      .attach('file', Buffer.from(csv), 'accounts.csv');

    expect(res.status).toBe(200);
    expect(res.body.imported).toBe(2);
    expect(res.body.skipped).toBe(0);

    const list = await request(app).get('/api/accounts');
    expect(list.body).toHaveLength(2);
  });

  test('POST /api/import/csv - imports assets from CSV', async () => {
    const csv = `name,category,acquisition_cost,current_value
My Home,real_estate,300000,350000
Tesla,vehicle,45000,30000`;

    const res = await request(app)
      .post('/api/import/csv?import_type=assets')
      .attach('file', Buffer.from(csv), 'assets.csv');

    expect(res.status).toBe(200);
    expect(res.body.imported).toBe(2);
  });

  test('POST /api/import/csv - imports liabilities from CSV', async () => {
    const csv = `name,lender,type,original_principal,current_balance,interest_rate
Mortgage,Wells Fargo,mortgage,400000,380000,3.5
Car Loan,Toyota Finance,auto,25000,20000,4.9`;

    const res = await request(app)
      .post('/api/import/csv?import_type=liabilities')
      .attach('file', Buffer.from(csv), 'liabilities.csv');

    expect(res.status).toBe(200);
    expect(res.body.imported).toBe(2);
  });

  test('POST /api/import/csv - rejects missing file', async () => {
    const res = await request(app).post('/api/import/csv?import_type=accounts');
    expect(res.status).toBe(400);
  });

  test('POST /api/import/json - imports accounts from JSON', async () => {
    const res = await request(app).post('/api/import/json').send({
      import_type: 'accounts',
      records: [
        { name: 'JSON Account', type: 'savings', balance: 3000 },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body.imported).toBe(1);
  });

  test('POST /api/import/json - rejects empty records', async () => {
    const res = await request(app).post('/api/import/json').send({ import_type: 'accounts', records: [] });
    expect(res.status).toBe(400);
  });
});

// ─── Health ───────────────────────────────────────────────────────────────────

describe('Health endpoint', () => {
  test('GET /api/health - returns ok', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });
});

// ─── Config ───────────────────────────────────────────────────────────────────

describe('Config endpoint', () => {
  test('GET /api/config - returns aiEnabled false when no key set', async () => {
    const saved = process.env.AI_API_KEY;
    delete process.env.AI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    const res = await request(app).get('/api/config');
    expect(res.status).toBe(200);
    expect(res.body.aiEnabled).toBe(false);
    if (saved !== undefined) process.env.AI_API_KEY = saved;
  });

  test('GET /api/config - returns aiEnabled true when AI_API_KEY set', async () => {
    process.env.AI_API_KEY = 'test-key';
    const res = await request(app).get('/api/config');
    expect(res.status).toBe(200);
    expect(res.body.aiEnabled).toBe(true);
    delete process.env.AI_API_KEY;
  });
});

// ─── Insurance Plans ─────────────────────────────────────────────────────────

describe('Insurance Plans API', () => {
  test('GET /api/insurance - returns empty array initially', async () => {
    const res = await request(app).get('/api/insurance');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  test('POST /api/insurance - creates a plan', async () => {
    const res = await request(app).post('/api/insurance').send({
      name: 'Life Insurance',
      provider: 'Prudential',
      type: 'life',
      premium_amount: 200,
      premium_frequency: 'monthly',
      coverage_amount: 500000,
      start_date: '2023-01-01',
    });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('Life Insurance');
    expect(res.body.provider).toBe('Prudential');
    expect(res.body.type).toBe('life');
    expect(res.body.premium_amount).toBe(200);
    expect(res.body.coverage_amount).toBe(500000);
    expect(res.body.id).toBeDefined();
  });

  test('POST /api/insurance - rejects missing name', async () => {
    const res = await request(app).post('/api/insurance').send({ type: 'health', premium_amount: 100 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/name/i);
  });

  test('POST /api/insurance - rejects invalid type', async () => {
    const res = await request(app).post('/api/insurance').send({ name: 'X', type: 'invalid_type' });
    expect(res.status).toBe(400);
  });

  test('POST /api/insurance - rejects invalid premium_frequency', async () => {
    const res = await request(app).post('/api/insurance').send({ name: 'X', premium_frequency: 'weekly' });
    expect(res.status).toBe(400);
  });

  test('GET /api/insurance/:id - returns single plan', async () => {
    const created = await request(app).post('/api/insurance').send({ name: 'Health Plan', type: 'health', premium_amount: 300 });
    const res = await request(app).get(`/api/insurance/${created.body.id}`);
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Health Plan');
  });

  test('GET /api/insurance/:id - 404 for unknown id', async () => {
    const res = await request(app).get('/api/insurance/9999');
    expect(res.status).toBe(404);
  });

  test('PUT /api/insurance/:id - updates premium amount', async () => {
    const created = await request(app).post('/api/insurance').send({ name: 'Auto', type: 'auto', premium_amount: 100, premium_frequency: 'monthly' });
    const res = await request(app).put(`/api/insurance/${created.body.id}`).send({ premium_amount: 120 });
    expect(res.status).toBe(200);
    expect(res.body.premium_amount).toBe(120);
  });

  test('DELETE /api/insurance/:id - deletes plan', async () => {
    const created = await request(app).post('/api/insurance').send({ name: 'DeleteMe', type: 'other' });
    const del = await request(app).delete(`/api/insurance/${created.body.id}`);
    expect(del.status).toBe(200);
    const get = await request(app).get(`/api/insurance/${created.body.id}`);
    expect(get.status).toBe(404);
  });

  test('DELETE /api/insurance/:id - 404 for unknown id', async () => {
    const res = await request(app).delete('/api/insurance/9999');
    expect(res.status).toBe(404);
  });
});

// ─── PDF Import ───────────────────────────────────────────────────────────────

/**
 * Generate a minimal valid PDF containing the given text.
 * No external tools needed – hand-crafted PDF structure.
 */
function makePdf(text) {
  const safeText = text.replace(/[()\\]/g, '\\$&');
  const streamContent = `BT /F1 12 Tf 50 750 Td (${safeText}) Tj ET`;
  const streamLen = streamContent.length;
  const obj1 = '1 0 obj\n<</Type /Catalog /Pages 2 0 R>>\nendobj\n';
  const obj2 = '2 0 obj\n<</Type /Pages /Kids [3 0 R] /Count 1>>\nendobj\n';
  const obj3 = `3 0 obj\n<</Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources <</Font <</F1 5 0 R>>>>>>\nendobj\n`;
  const obj4 = `4 0 obj\n<</Length ${streamLen}>>\nstream\n${streamContent}\nendstream\nendobj\n`;
  const obj5 = '5 0 obj\n<</Type /Font /Subtype /Type1 /BaseFont /Helvetica>>\nendobj\n';
  const header = '%PDF-1.4\n';
  const body = [obj1, obj2, obj3, obj4, obj5];
  let offset = header.length;
  const offsets = [];
  const bodyStr = body.map((o) => { offsets.push(offset); offset += o.length; return o; }).join('');
  const xrefOffset = header.length + bodyStr.length;
  const xref = `xref\n0 6\n0000000000 65535 f \n${offsets.map((o) => o.toString().padStart(10, '0') + ' 00000 n ').join('\n')}\n`;
  const trailer = `trailer\n<</Size 6 /Root 1 0 R>>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(header + bodyStr + xref + trailer, 'latin1');
}

describe('PDF Import API', () => {
  test('POST /api/import/pdf/preview - parses bank statement PDF', async () => {
    const pdfBuf = makePdf('Chase Bank  Ending Balance: $12,345.67  Checking Account');
    const res = await request(app)
      .post('/api/import/pdf/preview')
      .attach('file', pdfBuf, { filename: 'statement.pdf', contentType: 'application/pdf' });

    expect(res.status).toBe(200);
    expect(res.body.import_type).toBe('accounts');
    expect(Array.isArray(res.body.records)).toBe(true);
    expect(res.body.records.length).toBeGreaterThan(0);
    expect(res.body.records[0].balance).toBeCloseTo(12345.67, 0);
    expect(res.body.method).toBe('pattern');
  });

  test('POST /api/import/pdf/preview - parses loan statement PDF', async () => {
    const pdfBuf = makePdf('Wells Fargo Mortgage  Outstanding Balance: $320,000.00  Interest Rate: 4.50%');
    const res = await request(app)
      .post('/api/import/pdf/preview')
      .attach('file', pdfBuf, { filename: 'mortgage.pdf', contentType: 'application/pdf' });

    expect(res.status).toBe(200);
    expect(res.body.import_type).toBe('liabilities');
    expect(res.body.records[0].current_balance).toBeCloseTo(320000, 0);
    expect(res.body.records[0].interest_rate).toBeCloseTo(4.5, 1);
  });

  test('POST /api/import/pdf/preview - rejects missing file', async () => {
    const res = await request(app).post('/api/import/pdf/preview');
    expect(res.status).toBe(400);
  });

  test('POST /api/import/pdf - imports accounts from PDF into DB', async () => {
    const pdfBuf = makePdf('Chase Bank  Ending Balance: $5,000.00  Savings Account');
    const res = await request(app)
      .post('/api/import/pdf')
      .attach('file', pdfBuf, { filename: 'savings.pdf', contentType: 'application/pdf' });

    expect(res.status).toBe(200);
    expect(res.body.imported).toBeGreaterThan(0);

    const list = await request(app).get('/api/accounts');
    expect(list.body.length).toBeGreaterThan(0);
  });

  test('POST /api/import/pdf - rejects missing file', async () => {
    const res = await request(app).post('/api/import/pdf');
    expect(res.status).toBe(400);
  });
});

