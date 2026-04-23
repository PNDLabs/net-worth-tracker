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
import { extractPdfText } from './pdfService';
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

  previewPdf: async (file, password) => {
    const aiConfig = await getAiSettings();
    const options = aiConfig.apiKey ? aiConfig : {};
    const buf = await file.arrayBuffer();
    const text = await extractPdfText(buf, password);
    if (!text.trim()) throw new Error('Could not extract text from PDF. The file may be scanned/image-only.');
    return parseStatement(text, options);
  },

  importPdf: async (file, password, importType, previewedRecords) => {
    const aiConfig = await getAiSettings();
    const options = aiConfig.apiKey ? aiConfig : {};
    return importSvc.importPdf(file, password, importType, previewedRecords, options);
  },

  parseText: async (text, importType) => {
    const aiConfig = await getAiSettings();
    const options = aiConfig.apiKey ? aiConfig : {};
    return parseStatement(text, options);
  },
};
