/**
 * localApi.js
 *
 * Exposes the same `api` interface as api.js, but all data operations are
 * backed by the on-device SQLite database via @capacitor-community/sqlite
 * and AI settings are stored in @capacitor/preferences.
 *
 * Used exclusively on Android (Capacitor native).  On web the REST api.js
 * is used instead — see apiAdapter.js.
 */

import * as accountsSvc from '../db/accountsService';
import * as assetsSvc   from '../db/assetsService';
import * as liabSvc     from '../db/liabilitiesService';
import * as insSvc      from '../db/insuranceService';
import * as sipSvc      from '../db/sipService';
import * as nwSvc       from '../db/networthService';
import * as vhSvc       from '../db/valueHistoryService';
import * as settingsSvc from '../db/settingsService';
import * as importSvc   from '../db/importService';
import * as exportSvc   from '../db/exportService';
import { getAiSettings, isAiEnabled, saveAiSettings } from './aiSettings';
import { parseStatement } from './statementParser';

export const api = {
  // ─── Accounts ───────────────────────────────────────────────────────────────
  getAccounts: () => accountsSvc.getAccounts(),
  createAccount: (data) => accountsSvc.createAccount(data),
  updateAccount: (id, data) => accountsSvc.updateAccount(id, data),
  deleteAccount: (id) => accountsSvc.deleteAccount(id),
  getHoldings: (id) => accountsSvc.getHoldings(id),
  createHolding: (id, data) => accountsSvc.createHolding(id, data),

  // ─── Assets ─────────────────────────────────────────────────────────────────
  getAssets: () => assetsSvc.getAssets(),
  createAsset: (data) => assetsSvc.createAsset(data),
  updateAsset: (id, data) => assetsSvc.updateAsset(id, data),
  deleteAsset: (id) => assetsSvc.deleteAsset(id),

  // ─── Liabilities ────────────────────────────────────────────────────────────
  getLiabilities: () => liabSvc.getLiabilities(),
  createLiability: (data) => liabSvc.createLiability(data),
  updateLiability: (id, data) => liabSvc.updateLiability(id, data),
  deleteLiability: (id) => liabSvc.deleteLiability(id),

  // ─── Insurance ──────────────────────────────────────────────────────────────
  getInsurance: () => insSvc.getInsurance(),
  createInsurance: (data) => insSvc.createInsurance(data),
  updateInsurance: (id, data) => insSvc.updateInsurance(id, data),
  deleteInsurance: (id) => insSvc.deleteInsurance(id),
  createAssetFromInsurance: (id) => insSvc.createAssetFromInsurance(id),

  queryInsuranceCoverage: async (question) => {
    if (!question || !question.trim()) throw new Error('question is required');
    const aiConfig = await getAiSettings();
    if (!aiConfig.apiKey) throw new Error('AI is not enabled. Configure an AI API key in Settings to use coverage queries.');
    const plans = await insSvc.getInsurance();
    if (plans.length === 0) return { answer: 'No insurance plans have been added yet.', applicable_plans: [] };
    const { apiKey, apiUrl = 'https://api.openai.com/v1', model = 'gpt-4o-mini' } = aiConfig;
    const systemPrompt = `You are an insurance advisor. You will be given a list of insurance plans (in JSON) with their policy details and coverage terms. Answer the user's question about which plan(s) would apply to their situation.\n\nReturn ONLY a JSON object in this exact format – no markdown fences, no prose:\n{\n  "answer": "<concise explanation of which plans apply and why, in 2-4 sentences>",\n  "applicable_plans": [\n    { "id": <plan id as integer>, "name": "<plan name>", "reason": "<why this plan applies>", "priority": <1 = primary, 2 = secondary, etc.> }\n  ]\n}\n\nIf no plans apply, return an empty applicable_plans array and explain why in the answer field.\nOrder applicable_plans by priority (most relevant first).`;
    const userMessage = `INSURANCE PORTFOLIO:\n${JSON.stringify(plans, null, 2)}\n\nQUESTION: ${question.trim()}`;
    const response = await fetch(`${apiUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userMessage }], temperature: 0, max_tokens: 2048 }),
    });
    if (!response.ok) { const err = await response.text().catch(() => ''); throw new Error(`AI API error ${response.status}: ${err}`); }
    const data = await response.json();
    const content = data.choices?.[0]?.message?.content?.trim();
    if (!content) throw new Error('AI returned empty response');
    const cleaned = content.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
    const result = JSON.parse(cleaned);
    return { answer: result.answer || '', applicable_plans: Array.isArray(result.applicable_plans) ? result.applicable_plans : [] };
  },

  analyzeInsuranceCoverage: async () => {
    const aiConfig = await getAiSettings();
    if (!aiConfig.apiKey) throw new Error('AI is not enabled. Configure an AI API key in Settings to use coverage analysis.');
    const plans = await insSvc.getInsurance();
    if (plans.length === 0) return { overlaps: [], gaps: ['No insurance plans have been added yet.'], suggestions: [] };
    const { apiKey, apiUrl = 'https://api.openai.com/v1', model = 'gpt-4o-mini' } = aiConfig;
    const systemPrompt = `You are an insurance portfolio analyst. You will be given a list of insurance plans (in JSON) with their details and coverage terms. Analyze this portfolio for:\n1. Overlaps – two or more plans that cover the same risk/condition.\n2. Gaps – common risks that are not covered by any plan.\n3. Optimization suggestions – concrete recommendations to reduce premiums, eliminate redundant coverage, or fill gaps.\n\nReturn ONLY a JSON object in this exact format – no markdown fences, no prose:\n{\n  "overlaps": [ "<string describing each overlap>" ],\n  "gaps": [ "<string describing each coverage gap>" ],\n  "suggestions": [ "<string describing each actionable suggestion>" ]\n}\n\nBe specific: reference actual plan names when describing overlaps and suggestions.`;
    const userMessage = `Analyze this insurance portfolio:\n${JSON.stringify(plans, null, 2)}`;
    const response = await fetch(`${apiUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userMessage }], temperature: 0, max_tokens: 2048 }),
    });
    if (!response.ok) { const err = await response.text().catch(() => ''); throw new Error(`AI API error ${response.status}: ${err}`); }
    const data = await response.json();
    const content = data.choices?.[0]?.message?.content?.trim();
    if (!content) throw new Error('AI returned empty response');
    const cleaned = content.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
    const result = JSON.parse(cleaned);
    return { overlaps: Array.isArray(result.overlaps) ? result.overlaps : [], gaps: Array.isArray(result.gaps) ? result.gaps : [], suggestions: Array.isArray(result.suggestions) ? result.suggestions : [] };
  },

  // ─── Settings ───────────────────────────────────────────────────────────────
  getSettings: () => settingsSvc.getSettings(),
  updateSettings: (data) => settingsSvc.updateSettings(data),

  // ─── Config (mirrors GET /api/config) ────────────────────────────────────
  getConfig: async () => {
    const [settings, aiEnabled] = await Promise.all([
      settingsSvc.getSettings(),
      isAiEnabled(),
    ]);
    return { aiEnabled, defaultCurrency: settings.defaultCurrency || null };
  },

  // ─── AI Settings (Android-only helpers used by SettingsPage) ─────────────
  getAiSettings: () => getAiSettings(),
  saveAiSettings: (data) => saveAiSettings(data),

  // ─── Net Worth ───────────────────────────────────────────────────────────
  getNetWorth: () => nwSvc.getNetWorth(),
  getSnapshots: () => nwSvc.getSnapshots(),
  createSnapshot: (data) => nwSvc.createSnapshot(data),

  // ─── Value History ───────────────────────────────────────────────────────
  getValueHistory: (entityType, entityId) => vhSvc.getValueHistory(entityType, entityId),
  getValueGrowth: (entityType, entityId) => vhSvc.getValueGrowth(entityType, entityId),
  recordValue: (data) => vhSvc.recordValue(data),

  // ─── SIP Installments ────────────────────────────────────────────────────
  getSipInstallments: (params = {}) => sipSvc.getSipInstallments(params),
  getSipSummary: () => sipSvc.getSipSummary(),
  createSipInstallment: (data) => sipSvc.createSipInstallment(data),
  updateSipInstallment: (id, data) => sipSvc.updateSipInstallment(id, data),
  deleteSipInstallment: (id) => sipSvc.deleteSipInstallment(id),

  // ─── Import ───────────────────────────────────────────────────────────────
  importJson: (importType, records) => importSvc.importRecords(importType, records),

  importCsv: (importType, file) => importSvc.importCsv(importType, file),

  previewCsv: async (importType, file) => {
    const aiConfig = await getAiSettings();
    const options = aiConfig.apiKey ? aiConfig : {};
    return importSvc.previewCsv(importType, file, options);
  },

  checkDuplicates: (importType, records) => importSvc.checkDuplicates(importType, records),

  previewPdf: async (file, password) => {
    const aiConfig = await getAiSettings();
    const options = aiConfig.apiKey ? aiConfig : {};
    return importSvc.previewPdf(file, password, options);
  },

  importPdf: async (file, password, importType, previewedRecords) => {
    const aiConfig = await getAiSettings();
    const options = aiConfig.apiKey ? aiConfig : {};
    return importSvc.importPdf(file, password, importType, previewedRecords, options);
  },

  parseText: async (text, importType) => {
    const aiConfig = await getAiSettings();
    const options = aiConfig.apiKey ? aiConfig : {};
    const { defaultCurrency } = await settingsSvc.getSettings().then((cfg) => {
      const raw = cfg.defaultCurrency;
      return { defaultCurrency: raw ? raw.replace(/^"|"$/g, '') : null };
    }).catch(() => ({ defaultCurrency: null }));
    return parseStatement(text, { ...options, defaultCurrency });
  },

  // Export / import full data
  exportData: () => exportSvc.exportAllData(),
  importFullData: (payload) => exportSvc.importAllData(payload),
};
