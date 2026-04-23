/**
 * aiSettings.js
 *
 * Reads and writes AI API settings (key, URL, model) using
 * @capacitor/preferences for secure on-device key-value storage.
 *
 * These helpers are used by the SettingsPage and the importService
 * to obtain the AI key for statementParser calls on Android.
 */

import { Preferences } from '@capacitor/preferences';

const KEYS = {
  apiKey: 'ai_api_key',
  apiUrl: 'ai_api_url',
  model: 'ai_model',
};

const DEFAULTS = {
  apiUrl: 'https://api.openai.com/v1',
  model: 'gpt-4o-mini',
};

export async function getAiSettings() {
  const [{ value: apiKey }, { value: apiUrl }, { value: model }] = await Promise.all([
    Preferences.get({ key: KEYS.apiKey }),
    Preferences.get({ key: KEYS.apiUrl }),
    Preferences.get({ key: KEYS.model }),
  ]);
  return {
    apiKey: apiKey ?? '',
    apiUrl: apiUrl ?? DEFAULTS.apiUrl,
    model: model ?? DEFAULTS.model,
  };
}

export async function saveAiSettings({ apiKey, apiUrl, model }) {
  await Promise.all([
    apiKey !== undefined ? Preferences.set({ key: KEYS.apiKey, value: apiKey }) : Promise.resolve(),
    apiUrl !== undefined ? Preferences.set({ key: KEYS.apiUrl, value: apiUrl }) : Promise.resolve(),
    model  !== undefined ? Preferences.set({ key: KEYS.model,  value: model  }) : Promise.resolve(),
  ]);
}

export async function clearAiSettings() {
  await Promise.all(Object.values(KEYS).map((k) => Preferences.remove({ key: k })));
}

/** Returns true when an AI API key is saved on the device. */
export async function isAiEnabled() {
  const { value } = await Preferences.get({ key: KEYS.apiKey });
  return !!(value && value.trim());
}
