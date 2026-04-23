/**
 * apiAdapter.js
 *
 * Unified API layer that routes calls to either:
 *   - the REST backend (web / Docker deployment), or
 *   - the on-device SQLite service layer (Android native via Capacitor).
 *
 * Pages import `api` from this module instead of directly from `./api`.
 * The switch is transparent: both implementations share the same interface.
 */

import { Capacitor } from '@capacitor/core';
import { api as restApi, apiFetch } from './api';
import { api as localApi } from './localApi';

const isNative = typeof Capacitor !== 'undefined' && Capacitor.isNativePlatform();

export { apiFetch };

export const api = isNative ? localApi : restApi;
