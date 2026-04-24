/**
 * insuranceService.js – local SQLite CRUD for insurance plans.
 * Mirrors backend/src/routes/insurance.js.
 */

import { query, run } from './dbService';

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
  terms, covered_conditions, insured_name,
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
        terms, covered_conditions, insured_name)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    ]
  );
  const rows = await query('SELECT * FROM insurance_plans WHERE id = ?', [lastId]);
  return hydratePlan(rows[0]);
}

export async function updateInsurance(id, {
  name, provider, type, policy_number,
  premium_amount, premium_frequency, coverage_amount,
  start_date, end_date, renewal_date, notes,
  terms, covered_conditions, insured_name,
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
  };
  if (!updated.name) throw new Error('name is required');

  await run(
    `UPDATE insurance_plans
     SET name=?, provider=?, type=?, policy_number=?, premium_amount=?,
         premium_frequency=?, coverage_amount=?, start_date=?, end_date=?,
         renewal_date=?, notes=?, terms=?, covered_conditions=?, insured_name=?,
         updated_at=datetime('now')
     WHERE id=?`,
    [
      updated.name, updated.provider, updated.type, updated.policy_number,
      updated.premium_amount, updated.premium_frequency, updated.coverage_amount,
      updated.start_date, updated.end_date, updated.renewal_date, updated.notes,
      updated.terms, updated.covered_conditions, updated.insured_name,
      id,
    ]
  );
  const rows = await query('SELECT * FROM insurance_plans WHERE id = ?', [id]);
  return hydratePlan(rows[0]);
}

export async function deleteInsurance(id) {
  await getInsurancePlan(id);
  await run('DELETE FROM insurance_plans WHERE id = ?', [id]);
  return { message: 'Insurance plan deleted' };
}
