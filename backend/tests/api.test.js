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
    expect(res.body.family_member).toBe('Self');
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

  test('GET /api/networth - returns family member net worth breakdown', async () => {
    const spouseAccount = await request(app).post('/api/accounts').send({
      name: 'Spouse Brokerage',
      type: 'brokerage',
      balance: 1000,
      family_member: ' spouse ',
    });
    await request(app).post(`/api/accounts/${spouseAccount.body.id}/holdings`).send({
      symbol: 'VTI',
      shares: 2,
      current_price: 100,
    });
    await request(app).post('/api/assets').send({
      name: 'Family Home',
      category: 'real_estate',
      current_value: 200000,
      family_member: 'Self',
    });
    await request(app).post('/api/liabilities').send({
      name: 'Family Mortgage',
      type: 'mortgage',
      current_balance: 50000,
      family_member: 'Self',
    });

    const res = await request(app).get('/api/networth');
    expect(res.status).toBe(200);
    expect(res.body.familyNetWorth).toBe(151200);
    expect(res.body.members).toEqual([
      expect.objectContaining({ name: 'Self', totalAssets: 200000, totalLiabilities: 50000, netWorth: 150000 }),
      expect.objectContaining({ name: 'Spouse', totalAssets: 1200, totalLiabilities: 0, netWorth: 1200 }),
    ]);
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

  test('POST /api/import/json - skips duplicate account by default', async () => {
    await request(app).post('/api/import/json').send({
      import_type: 'accounts',
      records: [{ name: 'Dup Account', type: 'savings', balance: 1000 }],
    });
    const res = await request(app).post('/api/import/json').send({
      import_type: 'accounts',
      records: [{ name: 'Dup Account', type: 'savings', balance: 2000 }],
    });
    expect(res.status).toBe(200);
    expect(res.body.imported).toBe(0);
    expect(res.body.duplicates).toBe(1);
    // Balance should still be original value
    const list = await request(app).get('/api/accounts');
    expect(list.body.find((a) => a.name === 'Dup Account').balance).toBe(1000);
  });

  test('POST /api/import/json - _updateExisting updates record and records history', async () => {
    // Create the initial account
    await request(app).post('/api/import/json').send({
      import_type: 'accounts',
      records: [{ name: 'Monthly Savings', institution: 'BankA', type: 'savings', balance: 5000 }],
    });

    // Import again with _updateExisting
    const res = await request(app).post('/api/import/json').send({
      import_type: 'accounts',
      records: [{ name: 'Monthly Savings', institution: 'BankA', type: 'savings', balance: 5500, _updateExisting: true }],
    });
    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(1);
    expect(res.body.imported).toBe(0);
    expect(res.body.duplicates).toBe(0);

    // Balance should be updated
    const list = await request(app).get('/api/accounts');
    const acct = list.body.find((a) => a.name === 'Monthly Savings');
    expect(acct.balance).toBe(5500);

    // value_history should contain the new balance
    const hist = await request(app).get(`/api/value-history?entity_type=account&entity_id=${acct.id}`);
    expect(hist.status).toBe(200);
    const importEntry = hist.body.find((h) => h.notes === 'import update');
    expect(importEntry).toBeDefined();
    expect(importEntry.value).toBe(5500);
  });

  test('POST /api/import/json - _updateExisting for assets records history', async () => {
    await request(app).post('/api/import/json').send({
      import_type: 'assets',
      records: [{ name: 'My Home', category: 'real_estate', current_value: 300000 }],
    });

    const res = await request(app).post('/api/import/json').send({
      import_type: 'assets',
      records: [{ name: 'My Home', category: 'real_estate', current_value: 320000, _updateExisting: true }],
    });
    expect(res.body.updated).toBe(1);

    const list = await request(app).get('/api/assets');
    const asset = list.body.find((a) => a.name === 'My Home');
    expect(asset.current_value).toBe(320000);

    const hist = await request(app).get(`/api/value-history?entity_type=asset&entity_id=${asset.id}`);
    const entry = hist.body.find((h) => h.notes === 'import update');
    expect(entry).toBeDefined();
    expect(entry.value).toBe(320000);
  });

  test('POST /api/import/json - _updateExisting for liabilities records history', async () => {
    await request(app).post('/api/import/json').send({
      import_type: 'liabilities',
      records: [{ name: 'Car Loan', lender: 'AutoBank', type: 'auto', current_balance: 20000 }],
    });

    const res = await request(app).post('/api/import/json').send({
      import_type: 'liabilities',
      records: [{ name: 'Car Loan', lender: 'AutoBank', type: 'auto', current_balance: 18000, _updateExisting: true }],
    });
    expect(res.body.updated).toBe(1);

    const list = await request(app).get('/api/liabilities');
    const liab = list.body.find((l) => l.name === 'Car Loan');
    expect(liab.current_balance).toBe(18000);

    const hist = await request(app).get(`/api/value-history?entity_type=liability&entity_id=${liab.id}`);
    const entry = hist.body.find((h) => h.notes === 'import update');
    expect(entry).toBeDefined();
    expect(entry.value).toBe(18000);
  });

  test('POST /api/import/json - _updateExisting for insurance records history', async () => {
    await request(app).post('/api/import/json').send({
      import_type: 'insurance',
      records: [{ name: 'Life Policy', provider: 'Insurer A', type: 'life', premium_amount: 200 }],
    });

    const res = await request(app).post('/api/import/json').send({
      import_type: 'insurance',
      records: [{ name: 'Life Policy', provider: 'Insurer A', type: 'life', premium_amount: 220, _updateExisting: true }],
    });
    expect(res.body.updated).toBe(1);

    const list = await request(app).get('/api/insurance');
    const plan = list.body.find((p) => p.name === 'Life Policy');
    expect(plan.premium_amount).toBe(220);

    const hist = await request(app).get(`/api/value-history?entity_type=insurance&entity_id=${plan.id}`);
    const entry = hist.body.find((h) => h.notes === 'import update');
    expect(entry).toBeDefined();
    expect(entry.value).toBe(220);
  });

  test('POST /api/import/json - _updateExisting does not zero balance when field missing', async () => {
    await request(app).post('/api/import/json').send({
      import_type: 'accounts',
      records: [{ name: 'Safe Account', type: 'savings', balance: 9000 }],
    });

    // Import update without providing balance
    const res = await request(app).post('/api/import/json').send({
      import_type: 'accounts',
      records: [{ name: 'Safe Account', type: 'savings', _updateExisting: true }],
    });
    expect(res.body.updated).toBe(1);

    const list = await request(app).get('/api/accounts');
    const acct = list.body.find((a) => a.name === 'Safe Account');
    expect(acct.balance).toBe(9000); // balance preserved, not zeroed
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

  test('POST /api/insurance/:id/create-asset - creates vehicle asset from auto IDV', async () => {
    const ins = await request(app).post('/api/insurance').send({
      name: 'Car Insurance', type: 'auto', coverage_amount: 500000, insured_name: 'Honda City 2022',
    });
    expect(ins.status).toBe(201);

    const res = await request(app).post(`/api/insurance/${ins.body.id}/create-asset`);
    expect(res.status).toBe(201);
    expect(res.body.asset.name).toBe('Honda City 2022');
    expect(res.body.asset.category).toBe('vehicle');
    expect(res.body.asset.current_value).toBe(500000);
    expect(res.body.plan.linked_asset_id).toBe(res.body.asset.id);
  });

  test('POST /api/insurance/:id/create-asset - falls back to plan name when insured_name absent', async () => {
    const ins = await request(app).post('/api/insurance').send({
      name: 'My Bike Insurance', type: 'auto', coverage_amount: 80000,
    });
    const res = await request(app).post(`/api/insurance/${ins.body.id}/create-asset`);
    expect(res.status).toBe(201);
    expect(res.body.asset.name).toBe('My Bike Insurance');
  });

  test('POST /api/insurance/:id/create-asset - 400 for non-auto type', async () => {
    const ins = await request(app).post('/api/insurance').send({ name: 'Health', type: 'health', coverage_amount: 200000 });
    const res = await request(app).post(`/api/insurance/${ins.body.id}/create-asset`);
    expect(res.status).toBe(400);
  });

  test('POST /api/insurance/:id/create-asset - 400 when coverage_amount missing', async () => {
    const ins = await request(app).post('/api/insurance').send({ name: 'Auto No IDV', type: 'auto' });
    const res = await request(app).post(`/api/insurance/${ins.body.id}/create-asset`);
    expect(res.status).toBe(400);
  });

  test('POST /api/insurance/:id/create-asset - 409 when asset already exists', async () => {
    await request(app).post('/api/assets').send({ name: 'Maruti Swift', category: 'vehicle', current_value: 400000 });
    const ins = await request(app).post('/api/insurance').send({
      name: 'Swift Insurance', type: 'auto', coverage_amount: 350000, insured_name: 'Maruti Swift',
    });
    const res = await request(app).post(`/api/insurance/${ins.body.id}/create-asset`);
    expect(res.status).toBe(409);
  });

  test('POST /api/insurance/:id/create-asset - 404 for unknown insurance id', async () => {
    const res = await request(app).post('/api/insurance/9999/create-asset');
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
    // 2-pass: validation_notes always present
    expect(Array.isArray(res.body.validation_notes)).toBe(true);
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
    expect(Array.isArray(res.body.validation_notes)).toBe(true);
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

  test('POST /api/import/pdf - imports using pre-parsed previewed_records', async () => {
    const pdfBuf = makePdf('Some Bank  Ending Balance: $9,999.00');
    const previewedRecords = [
      { name: 'My Savings', institution: 'Some Bank', type: 'savings', currency: 'USD', balance: 9999 },
    ];
    const res = await request(app)
      .post('/api/import/pdf')
      .attach('file', pdfBuf, { filename: 'some.pdf', contentType: 'application/pdf' })
      .field('import_type', 'accounts')
      .field('previewed_records', JSON.stringify(previewedRecords));

    expect(res.status).toBe(200);
    expect(res.body.imported).toBe(1);
    expect(res.body.method).toBe('preview');

    const list = await request(app).get('/api/accounts');
    const acct = list.body.find((a) => a.name === 'My Savings');
    expect(acct).toBeDefined();
    expect(acct.balance).toBe(9999);
  });

  test('POST /api/import/pdf - rejects invalid previewed_records JSON', async () => {
    const pdfBuf = makePdf('Any Bank  Ending Balance: $1,000.00');
    const res = await request(app)
      .post('/api/import/pdf')
      .attach('file', pdfBuf, { filename: 'any.pdf', contentType: 'application/pdf' })
      .field('import_type', 'accounts')
      .field('previewed_records', 'not-valid-json');

    expect(res.status).toBe(400);
  });

  test('POST /api/import/pdf - rejects previewed_records without import_type', async () => {
    const pdfBuf = makePdf('Any Bank  Ending Balance: $1,000.00');
    const res = await request(app)
      .post('/api/import/pdf')
      .attach('file', pdfBuf, { filename: 'any.pdf', contentType: 'application/pdf' })
      .field('previewed_records', JSON.stringify([{ name: 'Test', type: 'savings', balance: 100 }]));

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/import_type/i);
  });

  test('POST /api/import/pdf - rejects missing file', async () => {
    const res = await request(app).post('/api/import/pdf');
    expect(res.status).toBe(400);
  });
});


// ─── Deduplication ────────────────────────────────────────────────────────────

describe('Deduplication', () => {
  test('POST /api/accounts - rejects duplicate name+institution with 409', async () => {
    await request(app).post('/api/accounts').send({ name: 'Chase Checking', institution: 'Chase', type: 'checking', balance: 1000 });
    const res = await request(app).post('/api/accounts').send({ name: 'Chase Checking', institution: 'Chase', type: 'savings', balance: 2000 });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already exists/i);
  });

  test('POST /api/accounts - allows same name with different institution', async () => {
    await request(app).post('/api/accounts').send({ name: 'Savings', institution: 'BankA', type: 'savings', balance: 1000 });
    const res = await request(app).post('/api/accounts').send({ name: 'Savings', institution: 'BankB', type: 'savings', balance: 2000 });
    expect(res.status).toBe(201);
  });

  test('POST /api/assets - rejects duplicate name with 409', async () => {
    await request(app).post('/api/assets').send({ name: 'My Car', category: 'vehicle', current_value: 20000 });
    const res = await request(app).post('/api/assets').send({ name: 'My Car', category: 'vehicle', current_value: 18000 });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already exists/i);
  });

  test('POST /api/liabilities - rejects duplicate name+lender with 409', async () => {
    await request(app).post('/api/liabilities').send({ name: 'Car Loan', lender: 'Toyota', type: 'auto', current_balance: 15000 });
    const res = await request(app).post('/api/liabilities').send({ name: 'Car Loan', lender: 'Toyota', type: 'auto', current_balance: 14000 });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already exists/i);
  });

  test('POST /api/accounts/:id/holdings - rejects duplicate symbol with 409', async () => {
    const acc = await request(app).post('/api/accounts').send({ name: 'Brokerage', type: 'brokerage', balance: 0 });
    await request(app).post(`/api/accounts/${acc.body.id}/holdings`).send({ symbol: 'AAPL', shares: 10 });
    const res = await request(app).post(`/api/accounts/${acc.body.id}/holdings`).send({ symbol: 'AAPL', shares: 5 });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already exists/i);
  });

  test('POST /api/insurance - rejects duplicate name+provider with 409', async () => {
    await request(app).post('/api/insurance').send({ name: 'Life Policy', provider: 'LIC', type: 'life', premium_amount: 500 });
    const res = await request(app).post('/api/insurance').send({ name: 'Life Policy', provider: 'LIC', type: 'life', premium_amount: 600 });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already exists/i);
  });

  test('POST /api/import/csv - skips duplicate accounts silently', async () => {
    await request(app).post('/api/accounts').send({ name: 'Chase Checking', institution: 'Chase', type: 'checking', balance: 5000 });
    const csv = `name,institution,type,currency,balance\nChase Checking,Chase,checking,USD,6000\nNew Account,BoA,savings,USD,1000`;
    const res = await request(app)
      .post('/api/import/csv?import_type=accounts')
      .attach('file', Buffer.from(csv), 'accounts.csv');
    expect(res.status).toBe(200);
    expect(res.body.imported).toBe(1);
    expect(res.body.skipped).toBe(1);
    expect(res.body.duplicates).toBe(1);
  });

  test('POST /api/import/json - skips duplicate assets silently', async () => {
    await request(app).post('/api/assets').send({ name: 'House', category: 'real_estate', current_value: 300000 });
    const res = await request(app).post('/api/import/json').send({
      import_type: 'assets',
      records: [
        { name: 'House', category: 'real_estate', current_value: 310000 },
        { name: 'New Asset', category: 'other', current_value: 5000 },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body.imported).toBe(1);
    expect(res.body.skipped).toBe(1);
    expect(res.body.duplicates).toBe(1);
  });

  test('POST /api/import/check-duplicates - returns indices of duplicate records', async () => {
    await request(app).post('/api/accounts').send({ name: 'Savings', institution: 'BoA', type: 'savings', balance: 1000 });
    const res = await request(app).post('/api/import/check-duplicates').send({
      import_type: 'accounts',
      records: [
        { name: 'Savings', institution: 'BoA' },
        { name: 'Checking', institution: 'Chase' },
        { name: 'savings', institution: 'boa' }, // case-insensitive match
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body.duplicates).toEqual([0, 2]);
  });

  test('POST /api/import/check-duplicates - returns empty array when no duplicates', async () => {
    const res = await request(app).post('/api/import/check-duplicates').send({
      import_type: 'assets',
      records: [{ name: 'New Asset' }],
    });
    expect(res.status).toBe(200);
    expect(res.body.duplicates).toEqual([]);
  });

  test('POST /api/import/json - _forceImport bypasses duplicate check', async () => {
    await request(app).post('/api/assets').send({ name: 'My House', category: 'real_estate', current_value: 300000 });
    const res = await request(app).post('/api/import/json').send({
      import_type: 'assets',
      records: [{ name: 'My House', category: 'real_estate', current_value: 320000, _forceImport: true }],
    });
    expect(res.status).toBe(200);
    expect(res.body.imported).toBe(1);
    expect(res.body.duplicates).toBe(0);
  });

  test('POST /api/import/pdf - _forceImport in previewed_records bypasses duplicate check', async () => {
    await request(app).post('/api/accounts').send({ name: 'Force Account', institution: 'TestBank', type: 'savings', balance: 1000 });
    const res = await request(app)
      .post('/api/import/pdf')
      .attach('file', Buffer.from('%PDF-1.4'), 'test.pdf')
      .field('import_type', 'accounts')
      .field('previewed_records', JSON.stringify([
        { name: 'Force Account', institution: 'TestBank', type: 'savings', currency: 'USD', balance: 2000, _forceImport: true },
      ]));
    expect(res.status).toBe(200);
    expect(res.body.imported).toBe(1);
    expect(res.body.duplicates).toBe(0);
  });
});

// ─── Value History ────────────────────────────────────────────────────────────

describe('Value History API', () => {
  test('POST /api/accounts auto-records initial balance in value_history', async () => {
    const acc = await request(app).post('/api/accounts').send({ name: 'History Test', type: 'savings', balance: 5000 });
    const res = await request(app).get(`/api/value-history?entity_type=account&entity_id=${acc.body.id}`);
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThanOrEqual(1);
    expect(res.body[0].value).toBe(5000);
  });

  test('PUT /api/accounts records new balance in value_history on change', async () => {
    const acc = await request(app).post('/api/accounts').send({ name: 'BalChg', type: 'checking', balance: 1000 });
    await request(app).put(`/api/accounts/${acc.body.id}`).send({ balance: 2000 });
    const res = await request(app).get(`/api/value-history?entity_type=account&entity_id=${acc.body.id}`);
    expect(res.status).toBe(200);
    const values = res.body.map((r) => r.value);
    expect(values).toContain(1000);
    expect(values).toContain(2000);
  });

  test('POST /api/assets auto-records initial value in value_history', async () => {
    const asset = await request(app).post('/api/assets').send({ name: 'VH Asset', category: 'other', current_value: 8000 });
    const res = await request(app).get(`/api/value-history?entity_type=asset&entity_id=${asset.body.id}`);
    expect(res.status).toBe(200);
    expect(res.body[0].value).toBe(8000);
  });

  test('PUT /api/assets records updated value in value_history', async () => {
    const asset = await request(app).post('/api/assets').send({ name: 'VH Asset2', category: 'other', current_value: 5000 });
    await request(app).put(`/api/assets/${asset.body.id}`).send({ current_value: 6000 });
    const res = await request(app).get(`/api/value-history?entity_type=asset&entity_id=${asset.body.id}`);
    const values = res.body.map((r) => r.value);
    expect(values).toContain(6000);
  });

  test('GET /api/value-history/growth - returns growth data', async () => {
    const acc = await request(app).post('/api/accounts').send({ name: 'Growth Test', type: 'savings', balance: 1000 });
    await request(app).put(`/api/accounts/${acc.body.id}`).send({ balance: 1200 });
    const res = await request(app).get(`/api/value-history/growth?entity_type=account&entity_id=${acc.body.id}`);
    expect(res.status).toBe(200);
    expect(res.body.first_value).toBe(1000);
    expect(res.body.latest_value).toBe(1200);
    expect(res.body.absolute_change).toBe(200);
    expect(res.body.percent_change).toBeCloseTo(20, 0);
  });

  test('POST /api/value-history - manually records a value', async () => {
    const acc = await request(app).post('/api/accounts').send({ name: 'Manual VH', type: 'savings', balance: 3000 });
    const res = await request(app).post('/api/value-history').send({
      entity_type: 'account',
      entity_id: acc.body.id,
      value: 3500,
      recorded_at: '2025-01-01',
      notes: 'Manual entry',
    });
    expect(res.status).toBe(201);
    expect(res.body.value).toBe(3500);
    expect(res.body.notes).toBe('Manual entry');
  });

  test('GET /api/value-history - returns 400 for invalid entity_type', async () => {
    const res = await request(app).get('/api/value-history?entity_type=invalid&entity_id=1');
    expect(res.status).toBe(400);
  });
});

// ─── Insurance Terms & Coverage AI ───────────────────────────────────────────

describe('Insurance Terms & Coverage AI', () => {
  test('POST /api/insurance - creates plan with terms and covered_conditions', async () => {
    const res = await request(app).post('/api/insurance').send({
      name: 'Health Plus',
      provider: 'StarHealth',
      type: 'health',
      premium_amount: 1200,
      terms: 'Covers hospitalisation, pre and post hospitalisation, day care procedures. Exclusions: cosmetic surgery, dental.',
      covered_conditions: ['Hospitalisation', 'Day care', 'Pre/post hospitalisation'],
    });
    expect(res.status).toBe(201);
    expect(res.body.terms).toBe('Covers hospitalisation, pre and post hospitalisation, day care procedures. Exclusions: cosmetic surgery, dental.');
    expect(Array.isArray(res.body.covered_conditions)).toBe(true);
    expect(res.body.covered_conditions).toContain('Hospitalisation');
    expect(res.body.covered_conditions).toContain('Day care');
  });

  test('PUT /api/insurance/:id - updates terms and covered_conditions', async () => {
    const created = await request(app).post('/api/insurance').send({
      name: 'Term Life',
      type: 'term_life',
      premium_amount: 500,
      terms: 'Initial terms',
      covered_conditions: ['Death benefit'],
    });
    const res = await request(app).put(`/api/insurance/${created.body.id}`).send({
      terms: 'Updated terms with critical illness rider',
      covered_conditions: ['Death benefit', 'Critical illness'],
    });
    expect(res.status).toBe(200);
    expect(res.body.terms).toBe('Updated terms with critical illness rider');
    expect(res.body.covered_conditions).toContain('Critical illness');
  });

  test('GET /api/insurance - returns covered_conditions as array', async () => {
    await request(app).post('/api/insurance').send({
      name: 'Dental Cover',
      type: 'dental',
      covered_conditions: ['Checkup', 'Extraction'],
    });
    const res = await request(app).get('/api/insurance');
    expect(res.status).toBe(200);
    const plan = res.body.find((p) => p.name === 'Dental Cover');
    expect(Array.isArray(plan.covered_conditions)).toBe(true);
    expect(plan.covered_conditions).toContain('Checkup');
  });

  test('GET /api/insurance/:id - returns covered_conditions as array for plans without the field', async () => {
    // Create without covered_conditions to test fallback
    const created = await request(app).post('/api/insurance').send({ name: 'Basic Plan', type: 'other' });
    const res = await request(app).get(`/api/insurance/${created.body.id}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.covered_conditions)).toBe(true);
    expect(res.body.covered_conditions).toEqual([]);
  });

  test('POST /api/insurance/query - returns 503 when AI is not enabled', async () => {
    const savedKey = process.env.AI_API_KEY;
    const savedOpenAiKey = process.env.OPENAI_API_KEY;
    delete process.env.AI_API_KEY;
    delete process.env.OPENAI_API_KEY;

    const res = await request(app).post('/api/insurance/query').send({ question: 'I was hospitalised. Which plan applies?' });
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/AI is not enabled/i);

    if (savedKey !== undefined) process.env.AI_API_KEY = savedKey;
    if (savedOpenAiKey !== undefined) process.env.OPENAI_API_KEY = savedOpenAiKey;
  });

  test('POST /api/insurance/query - returns 400 when question is missing', async () => {
    process.env.AI_API_KEY = 'test-key';
    const res = await request(app).post('/api/insurance/query').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/question is required/i);
    delete process.env.AI_API_KEY;
  });

  test('GET /api/insurance/analysis - returns 503 when AI is not enabled', async () => {
    const savedKey = process.env.AI_API_KEY;
    const savedOpenAiKey = process.env.OPENAI_API_KEY;
    delete process.env.AI_API_KEY;
    delete process.env.OPENAI_API_KEY;

    const res = await request(app).get('/api/insurance/analysis');
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/AI is not enabled/i);

    if (savedKey !== undefined) process.env.AI_API_KEY = savedKey;
    if (savedOpenAiKey !== undefined) process.env.OPENAI_API_KEY = savedOpenAiKey;
  });

  test('GET /api/insurance/analysis - returns empty analysis when no plans exist', async () => {
    // Need AI key set but we mock the fetch so it never actually calls out
    process.env.AI_API_KEY = 'test-key';

    // With no plans the route short-circuits before calling AI
    const res = await request(app).get('/api/insurance/analysis');
    expect(res.status).toBe(200);
    expect(res.body.overlaps).toEqual([]);
    expect(Array.isArray(res.body.gaps)).toBe(true);
    expect(res.body.suggestions).toEqual([]);

    delete process.env.AI_API_KEY;
  });

  test('POST /api/insurance/query - returns empty answer when no plans exist', async () => {
    process.env.AI_API_KEY = 'test-key';

    const res = await request(app).post('/api/insurance/query').send({ question: 'Which plan covers surgery?' });
    expect(res.status).toBe(200);
    expect(res.body.applicable_plans).toEqual([]);
    expect(typeof res.body.answer).toBe('string');

    delete process.env.AI_API_KEY;
  });

  test('GET /api/insurance/analysis - uses mocked AI response when plans exist', async () => {
    process.env.AI_API_KEY = 'test-key';

    await request(app).post('/api/insurance').send({
      name: 'Health A', type: 'health', premium_amount: 1000,
      covered_conditions: ['Hospitalisation'],
    });
    await request(app).post('/api/insurance').send({
      name: 'Health B', type: 'health', premium_amount: 1200,
      covered_conditions: ['Hospitalisation', 'Critical illness'],
    });

    // Mock fetch so the AI call returns a deterministic response
    const mockAiResponse = {
      overlaps: ['Health A and Health B both cover Hospitalisation.'],
      gaps: ['No disability insurance detected.'],
      suggestions: ['Consider dropping Health A since Health B provides a superset of coverage.'],
    };

    const originalFetch = global.fetch;
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify(mockAiResponse) } }],
      }),
    });

    const res = await request(app).get('/api/insurance/analysis');

    global.fetch = originalFetch;
    delete process.env.AI_API_KEY;

    expect(res.status).toBe(200);
    expect(res.body.overlaps).toEqual(mockAiResponse.overlaps);
    expect(res.body.gaps).toEqual(mockAiResponse.gaps);
    expect(res.body.suggestions).toEqual(mockAiResponse.suggestions);
  });
});

// ─── Precious Metals API ──────────────────────────────────────────────────────

describe('Precious Metals API', () => {
  test('GET /api/metals - returns empty array initially', async () => {
    const res = await request(app).get('/api/metals');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  test('POST /api/metals - creates a gold holding', async () => {
    const res = await request(app).post('/api/metals').send({
      name: '24K Gold Coin',
      metal_type: 'gold',
      metal_form: 'physical',
      purity: '24k',
      quantity_grams: 10,
      acquisition_cost: 600,
    });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('24K Gold Coin');
    expect(res.body.metal_type).toBe('gold');
    expect(res.body.metal_form).toBe('physical');
    expect(res.body.purity).toBe('24k');
    expect(res.body.quantity_grams).toBe(10);
    expect(res.body.id).toBeDefined();
  });

  test('POST /api/metals - rejects missing name', async () => {
    const res = await request(app).post('/api/metals').send({ metal_type: 'gold', quantity_grams: 5 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/name/i);
  });

  test('POST /api/metals - rejects invalid metal_type', async () => {
    const res = await request(app).post('/api/metals').send({ name: 'X', metal_type: 'copper' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/metal_type/i);
  });

  test('POST /api/metals - rejects invalid metal_form', async () => {
    const res = await request(app).post('/api/metals').send({ name: 'X', metal_form: 'imaginary' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/metal_form/i);
  });

  test('POST /api/metals - calculates current_value from price and purity', async () => {
    // 10g × 22k (22/24 purity) × $60/g = $550
    const res = await request(app).post('/api/metals').send({
      name: '22K Bangle',
      metal_type: 'gold',
      purity: '22k',
      quantity_grams: 10,
      current_price_gram: 60,
    });
    expect(res.status).toBe(201);
    const expected = 10 * (22 / 24) * 60;
    expect(res.body.current_value).toBeCloseTo(expected, 2);
  });

  test('POST /api/metals - calculates current_value with fineness purity', async () => {
    // 100g × 999/1000 purity × $1/g = ~99.9
    const res = await request(app).post('/api/metals').send({
      name: 'Silver Bar',
      metal_type: 'silver',
      purity: '999',
      quantity_grams: 100,
      current_price_gram: 1,
    });
    expect(res.status).toBe(201);
    expect(res.body.current_value).toBeCloseTo(99.9, 1);
  });

  test('GET /api/metals/:id - returns single holding', async () => {
    const created = await request(app).post('/api/metals').send({ name: 'Solo Gold', metal_type: 'gold', quantity_grams: 5 });
    const res = await request(app).get(`/api/metals/${created.body.id}`);
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Solo Gold');
  });

  test('GET /api/metals/:id - 404 for unknown id', async () => {
    const res = await request(app).get('/api/metals/9999');
    expect(res.status).toBe(404);
  });

  test('PUT /api/metals/:id - updates quantity and recalculates value', async () => {
    const created = await request(app).post('/api/metals').send({
      name: 'Update Gold',
      metal_type: 'gold',
      purity: '24k',
      quantity_grams: 5,
      current_price_gram: 60,
    });
    const res = await request(app).put(`/api/metals/${created.body.id}`).send({ quantity_grams: 10 });
    expect(res.status).toBe(200);
    expect(res.body.quantity_grams).toBe(10);
    expect(res.body.current_value).toBeCloseTo(600, 1);
  });

  test('DELETE /api/metals/:id - deletes a holding', async () => {
    const created = await request(app).post('/api/metals').send({ name: 'Del Gold', metal_type: 'gold', quantity_grams: 1 });
    await request(app).delete(`/api/metals/${created.body.id}`);
    const res = await request(app).get(`/api/metals/${created.body.id}`);
    expect(res.status).toBe(404);
  });

  test('GET /api/metals - metalsTotal included in networth calculation', async () => {
    // Add a gold holding with known price
    await request(app).post('/api/metals').send({
      name: 'NW Gold',
      metal_type: 'gold',
      quantity_grams: 10,
      current_price_gram: 100,
    });
    const res = await request(app).get('/api/networth');
    expect(res.status).toBe(200);
    expect(res.body.metalsTotal).toBeGreaterThan(0);
    expect(res.body.totalAssets).toBeGreaterThanOrEqual(res.body.metalsTotal);
  });

  test('POST /api/metals auto-records initial value in value_history', async () => {
    const created = await request(app).post('/api/metals').send({
      name: 'VH Metal',
      metal_type: 'gold',
      quantity_grams: 5,
      current_price_gram: 60,
    });
    const res = await request(app).get(`/api/value-history?entity_type=metal&entity_id=${created.body.id}`);
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThanOrEqual(1);
    expect(res.body[0].value).toBeCloseTo(300, 1);
  });

  test('GET /api/metals/spot-prices - returns 502 when MetalPriceAPI key is not configured', async () => {
    const res = await request(app).get('/api/metals/spot-prices');
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/MetalPriceAPI key is not configured/i);
  });

  test('POST /api/metals/refresh-prices - updates all metal values with mocked prices', async () => {
    await request(app).patch('/api/settings').send({ metalPriceApiKey: 'test-key-123' });

    const created = await request(app).post('/api/metals').send({
      name: 'Refresh Gold',
      metal_type: 'gold',
      purity: '24k',
      quantity_grams: 10,
    });

    const originalFetch = global.fetch;
    // MetalPriceAPI: rates.XAU = 1/62000 → price_per_gram = 62000/31.1035 ≈ 1993 USD/g
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        base: 'USD',
        rates: { XAU: 1 / 62000, XAG: 1 / 800, XPT: 1 / 30000, XPD: 1 / 40000 },
      }),
    });

    const res = await request(app).post('/api/metals/refresh-prices');
    global.fetch = originalFetch;

    expect(res.status).toBe(200);
    expect(res.body.updated).toBeGreaterThanOrEqual(1);

    // Verify the value was updated
    const metal = await request(app).get(`/api/metals/${created.body.id}`);
    expect(metal.body.current_value).toBeGreaterThan(0);
    expect(metal.body.last_price_update).not.toBeNull();

    expect(res.body.currency).toBe('USD');
    expect(res.body.unit).toBe('USD_per_gram');

    // Clean up
    await request(app).patch('/api/settings').send({ metalPriceApiKey: '' });
  });

  test('POST /api/metals/refresh-prices - converts to user defaultCurrency (INR) via MetalPriceAPI base currency', async () => {
    // Set user currency to INR and API key in settings
    await request(app).patch('/api/settings').send({ defaultCurrency: 'INR', metalPriceApiKey: 'test-key-inr' });

    const created = await request(app).post('/api/metals').send({
      name: 'INR Gold',
      metal_type: 'gold',
      purity: '24k',
      quantity_grams: 10,
    });

    const originalFetch = global.fetch;
    // MetalPriceAPI with base=INR:
    // rates.XAU = 1 / (3110.35 USD/troy-oz × 84 INR/USD) = 1/261269.4
    // price_per_gram = 1 / (rates.XAU × 31.1035) = 261269.4 / 31.1035 = 8400 INR/g
    global.fetch = jest.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        success: true,
        base: 'INR',
        rates: {
          XAU: 1 / (3110.35 * 84),
          XAG: 1 / (30 * 84),
          XPT: 1 / (900 * 84),
          XPD: 1 / (1000 * 84),
        },
      }),
    });

    const res = await request(app).post('/api/metals/refresh-prices');
    global.fetch = originalFetch;

    expect(res.status).toBe(200);
    expect(res.body.currency).toBe('INR');
    expect(res.body.unit).toBe('INR_per_gram');

    // gold: 1 / (rates.XAU × 31.1035) = (3110.35 × 84) / 31.1035 = 8400 INR/g
    // value: 10g × 1.0 (24k) × 8400 = 84000
    expect(res.body.prices.gold).toBeCloseTo(8400, 0);
    const metal = await request(app).get(`/api/metals/${created.body.id}`);
    expect(metal.body.current_value).toBeCloseTo(84000, 0);

    // Clean up
    await request(app).patch('/api/settings').send({ metalPriceApiKey: '' });
  });

  test('GET /api/metals/spot-prices - returns currency from user settings', async () => {
    // Reset settings to USD for this test's fresh DB
    const res = await request(app).get('/api/metals/spot-prices');
    // No defaultCurrency in fresh DB → should succeed or fail with 502 (no real network in test)
    // Just ensure it doesn't 500 (internal server error)
    expect([200, 502]).toContain(res.status);
    if (res.status === 200) {
      expect(res.body.currency).toBeDefined();
      expect(res.body.unit).toMatch(/_per_gram$/);
    }
  });

  test('POST /api/metals/refresh-prices - uses MetalPriceAPI when metalPriceApiKey is set in settings', async () => {
    // Store the API key in settings
    await request(app).patch('/api/settings').send({ metalPriceApiKey: 'test-key-123' });

    const created = await request(app).post('/api/metals').send({
      name: 'MetalPriceAPI Gold',
      metal_type: 'gold',
      purity: '24k',
      quantity_grams: 10,
    });

    const originalFetch = global.fetch;
    // MetalPriceAPI with base=USD returns rates.XAU = 1/3110.35 (troy oz per USD)
    // price_per_gram = 1 / (rates.XAU × 31.1035) = 3110.35 / 31.1035 = 100 USD/g
    global.fetch = jest.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        success: true,
        base: 'USD',
        rates: {
          XAU: 1 / 3110.35,
          XAG: 1 / 31.1035,
          XPT: 1 / 1000,
          XPD: 1 / 1200,
        },
      }),
    });

    const res = await request(app).post('/api/metals/refresh-prices');
    global.fetch = originalFetch;

    expect(res.status).toBe(200);
    expect(res.body.currency).toBe('USD');
    // gold: 1 / (1/3110.35 × 31.1035) = 100 USD/gram
    expect(res.body.prices.gold).toBeCloseTo(100, 0);
    const metal = await request(app).get(`/api/metals/${created.body.id}`);
    // 10g × 1.0 (24k) × 100 = 1000
    expect(metal.body.current_value).toBeCloseTo(1000, 0);

    // Clean up
    await request(app).patch('/api/settings').send({ metalPriceApiKey: '' });
  });
});
