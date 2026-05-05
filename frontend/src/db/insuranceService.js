/**
 * insuranceService.js – local SQLite CRUD for insurance plans.
 * Mirrors backend/src/routes/insurance.js.
 */

import { query, run, executeSet } from './dbService';

function parseCoveredConditions(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  try { return JSON.parse(raw); } catch (_) { return []; }
}

function hydratePlan(plan) {
  return { ...plan, covered_conditions: parseCoveredConditions(plan.covered_conditions) };
}

export async function getInsurance() {
  const rows = await query('SELECT * FROM insurance_plans ORDER BY name');
  return rows.map(hydratePlan);
}

export async function getInsurancePlan(id) {
  const rows = await query('SELECT * FROM insurance_plans WHERE id = ?', [id]);
  if (!rows.length) throw new Error('Insurance plan not found');
  return hydratePlan(rows[0]);
}

export async function createInsurance({
  name, provider, type = 'other', policy_number,
  premium_amount, premium_frequency = 'monthly', coverage_amount,
  start_date, end_date, renewal_date, notes,
  terms, covered_conditions, insured_name, fund_value,
}) {
  if (!name) throw new Error('name is required');
  const dup = await query(
    `SELECT id FROM insurance_plans WHERE lower(name)=lower(?) AND lower(coalesce(provider,''))=lower(coalesce(?,'')) AND lower(coalesce(insured_name,''))=lower(coalesce(?,''))`,
    [name, provider ?? null, insured_name ?? null]
  );
  if (dup.length) throw Object.assign(new Error('An insurance plan with the same name, provider, and insured name already exists'), { status: 409 });

  const covJson = covered_conditions != null
    ? JSON.stringify(Array.isArray(covered_conditions) ? covered_conditions : [])
    : null;

  const { lastId } = await run(
    `INSERT INTO insurance_plans
       (name, provider, type, policy_number, premium_amount, premium_frequency,
        coverage_amount, start_date, end_date, renewal_date, notes,
        terms, covered_conditions, insured_name, fund_value)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      name, provider ?? null, type, policy_number ?? null,
      premium_amount != null ? Number(premium_amount) : null,
      premium_frequency,
      coverage_amount != null ? Number(coverage_amount) : null,
      start_date ?? null, end_date ?? null, renewal_date ?? null,
      notes ?? null,
      terms ?? null,
      covJson,
      insured_name ?? null,
      fund_value != null ? Number(fund_value) : null,
    ]
  );
  const rows = await query('SELECT * FROM insurance_plans WHERE id = ?', [lastId]);
  return hydratePlan(rows[0]);
}

export async function updateInsurance(id, {
  name, provider, type, policy_number,
  premium_amount, premium_frequency, coverage_amount,
  start_date, end_date, renewal_date, notes,
  terms, covered_conditions, insured_name, fund_value,
}) {
  const existing = await getInsurancePlan(id);
  const updated = {
    name: name !== undefined ? name : existing.name,
    provider: provider !== undefined ? provider : existing.provider,
    type: type !== undefined ? type : existing.type,
    policy_number: policy_number !== undefined ? policy_number : existing.policy_number,
    premium_amount: premium_amount !== undefined ? (premium_amount != null ? Number(premium_amount) : null) : existing.premium_amount,
    premium_frequency: premium_frequency !== undefined ? premium_frequency : existing.premium_frequency,
    coverage_amount: coverage_amount !== undefined ? (coverage_amount != null ? Number(coverage_amount) : null) : existing.coverage_amount,
    start_date: start_date !== undefined ? start_date : existing.start_date,
    end_date: end_date !== undefined ? end_date : existing.end_date,
    renewal_date: renewal_date !== undefined ? renewal_date : existing.renewal_date,
    notes: notes !== undefined ? notes : existing.notes,
    terms: terms !== undefined ? terms : existing.terms,
    covered_conditions: covered_conditions !== undefined
      ? JSON.stringify(Array.isArray(covered_conditions) ? covered_conditions : [])
      : (typeof existing.covered_conditions === 'string'
        ? existing.covered_conditions
        : JSON.stringify(existing.covered_conditions || [])),
    insured_name: insured_name !== undefined ? insured_name : existing.insured_name,
    fund_value: fund_value !== undefined ? (fund_value != null ? Number(fund_value) : null) : existing.fund_value,
  };
  if (!updated.name) throw new Error('name is required');

  const ops = [
    {
      statement: `UPDATE insurance_plans
       SET name=?, provider=?, type=?, policy_number=?, premium_amount=?,
           premium_frequency=?, coverage_amount=?, start_date=?, end_date=?,
           renewal_date=?, notes=?, terms=?, covered_conditions=?, insured_name=?,
           fund_value=?, updated_at=datetime('now')
       WHERE id=?`,
      values: [
        updated.name, updated.provider, updated.type, updated.policy_number,
        updated.premium_amount, updated.premium_frequency, updated.coverage_amount,
        updated.start_date, updated.end_date, updated.renewal_date, updated.notes,
        updated.terms, updated.covered_conditions, updated.insured_name,
        updated.fund_value,
        id,
      ],
    },
  ];

  // Sync linked brokerage account balance when fund_value changes.
  if (fund_value !== undefined && updated.fund_value != null && existing.linked_account_id) {
    const todayStr = new Date().toISOString().slice(0, 10);
    ops.push({
      statement: `UPDATE accounts SET balance=?, updated_at=datetime('now') WHERE id=?`,
      values: [updated.fund_value, existing.linked_account_id],
    });
    ops.push({
      statement: `INSERT INTO value_history (entity_type, entity_id, value, recorded_at, notes) VALUES ('account', ?, ?, ?, 'insurance fund value update')`,
      values: [existing.linked_account_id, updated.fund_value, todayStr],
    });
  }

  await executeSet(ops);
  const rows = await query('SELECT * FROM insurance_plans WHERE id = ?', [id]);
  return hydratePlan(rows[0]);
}

export async function createFundAccountFromInsurance(id) {
  const plan = await getInsurancePlan(id);

  if (plan.fund_value == null || plan.fund_value <= 0) {
    throw new Error('The insurance plan must have a fund_value to create a linked fund account');
  }

  const accountName = `${plan.name} – Fund`;

  const dup = await query(`SELECT * FROM accounts WHERE lower(name)=lower(?)`, [accountName]);
  if (dup.length) {
    throw Object.assign(
      new Error(`A fund account named "${accountName}" already exists`),
      { status: 409, account: dup[0] }
    );
  }

  let currency = 'USD';
  try {
    const { getSettings } = await import('./settingsService');
    const cfg = await getSettings();
    if (cfg.defaultCurrency) currency = String(cfg.defaultCurrency).replace(/^"|"$/g, '') || 'USD';
  } catch (_) {}

  const todayStr = new Date().toISOString().slice(0, 10);
  const { lastId: accountId } = await run(
    `INSERT INTO accounts (name, institution, type, currency, balance) VALUES (?, ?, 'brokerage', ?, ?)`,
    [accountName, plan.provider ?? null, currency, plan.fund_value]
  );

  await run(
    `INSERT INTO value_history (entity_type, entity_id, value, recorded_at, notes) VALUES ('account', ?, ?, ?, 'Initial value from insurance fund')`,
    [accountId, plan.fund_value, todayStr]
  );

  await run(
    `UPDATE insurance_plans SET linked_account_id=?, updated_at=datetime('now') WHERE id=?`,
    [accountId, id]
  );

  const accountRows = await query('SELECT * FROM accounts WHERE id = ?', [accountId]);
  const planRows = await query('SELECT * FROM insurance_plans WHERE id = ?', [id]);
  return { account: accountRows[0], plan: hydratePlan(planRows[0]) };
}


  await getInsurancePlan(id);
  await run('DELETE FROM insurance_plans WHERE id = ?', [id]);
  return { message: 'Insurance plan deleted' };
}

export async function createAssetFromInsurance(id) {
  const plan = await getInsurancePlan(id);

  if (plan.type !== 'auto') {
    throw new Error('Asset creation from IDV is only supported for auto insurance plans');
  }
  if (plan.coverage_amount == null || plan.coverage_amount <= 0) {
    throw new Error('The insurance plan must have a coverage_amount (IDV) to create a vehicle asset');
  }

  const assetName = plan.insured_name && plan.insured_name.trim()
    ? plan.insured_name.trim()
    : plan.name;

  const dup = await query(`SELECT * FROM assets WHERE lower(name)=lower(?)`, [assetName]);
  if (dup.length) {
    throw Object.assign(
      new Error(`A vehicle asset named "${assetName}" already exists`),
      { status: 409, asset: dup[0] }
    );
  }

  const todayStr = new Date().toISOString().slice(0, 10);
  const { lastId: assetId } = await run(
    `INSERT INTO assets (name, category, acquisition_date, current_value, notes) VALUES (?, 'vehicle', ?, ?, ?)`,
    [
      assetName,
      plan.start_date ?? null,
      plan.coverage_amount,
      `Auto-created from insurance policy: ${plan.name} (IDV: ${plan.coverage_amount})`,
    ]
  );

  await run(
    `INSERT INTO value_history (entity_type, entity_id, value, recorded_at, notes)
     VALUES ('asset', ?, ?, ?, 'Initial value from insurance IDV')`,
    [assetId, plan.coverage_amount, todayStr]
  );

  await run(
    `UPDATE insurance_plans SET linked_asset_id=?, updated_at=datetime('now') WHERE id=?`,
    [assetId, id]
  );

  const assetRows = await query('SELECT * FROM assets WHERE id = ?', [assetId]);
  const planRows  = await query('SELECT * FROM insurance_plans WHERE id = ?', [id]);
  return { asset: assetRows[0], plan: hydratePlan(planRows[0]) };
}
