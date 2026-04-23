import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { api } from './apiAdapter';

const CurrencyContext = createContext('USD');

/**
 * Map browser locale → ISO 4217 currency code.
 * Region subtag takes priority; language code is a broad fallback.
 */
function detectCurrencyFromLocale() {
  const locale = navigator.language || 'en-US';
  const [lang, region] = locale.split('-');

  const regionMap = {
    US: 'USD', GB: 'GBP', CA: 'CAD', AU: 'AUD', NZ: 'NZD',
    JP: 'JPY', CN: 'CNY', KR: 'KRW', IN: 'INR', BR: 'BRL',
    MX: 'MXN', SG: 'SGD', HK: 'HKD', CH: 'CHF', NO: 'NOK',
    SE: 'SEK', DK: 'DKK', PL: 'PLN', CZ: 'CZK', HU: 'HUF',
    RO: 'RON', TR: 'TRY', RU: 'RUB', ZA: 'ZAR', NG: 'NGN',
    EG: 'EGP', AE: 'AED', SA: 'SAR', IL: 'ILS', TH: 'THB',
    ID: 'IDR', MY: 'MYR', PH: 'PHP', VN: 'VND', TW: 'TWD',
    AR: 'ARS', CL: 'CLP', CO: 'COP', PE: 'PEN', PK: 'PKR',
    BD: 'BDT', LK: 'LKR', UA: 'UAH', // Euro zone
    DE: 'EUR', FR: 'EUR', IT: 'EUR', ES: 'EUR', PT: 'EUR',
    NL: 'EUR', BE: 'EUR', AT: 'EUR', GR: 'EUR', FI: 'EUR',
    IE: 'EUR', LU: 'EUR', SK: 'EUR', SI: 'EUR', EE: 'EUR',
    LV: 'EUR', LT: 'EUR', CY: 'EUR', MT: 'EUR',
  };

  if (region && regionMap[region.toUpperCase()]) {
    return regionMap[region.toUpperCase()];
  }

  const langMap = {
    ja: 'JPY', zh: 'CNY', ko: 'KRW', hi: 'INR', pt: 'BRL',
    de: 'EUR', fr: 'EUR', it: 'EUR', es: 'EUR', nl: 'EUR',
    tr: 'TRY', ru: 'RUB', ar: 'AED', th: 'THB', id: 'IDR',
    vi: 'VND', ms: 'MYR', pl: 'PLN', sv: 'SEK', da: 'DKK',
    nb: 'NOK', cs: 'CZK', hu: 'HUF',
  };
  return langMap[lang] || 'USD';
}

export function CurrencyProvider({ children }) {
  const [currency, setCurrencyState] = useState('USD');

  useEffect(() => {
    api.getConfig()
      .then((cfg) => {
        if (cfg.defaultCurrency) {
          setCurrencyState(cfg.defaultCurrency);
        } else {
          // First run: detect from browser locale and save
          const detected = detectCurrencyFromLocale();
          setCurrencyState(detected);
          api.updateSettings({ defaultCurrency: detected }).catch(() => {});
        }
      })
      .catch(() => {
        // Fallback to locale detection if config fails
        setCurrencyState(detectCurrencyFromLocale());
      });
  }, []);

  const setCurrency = useCallback((code) => {
    setCurrencyState(code);
    api.updateSettings({ defaultCurrency: code }).catch(() => {});
  }, []);

  return (
    <CurrencyContext.Provider value={{ currency, setCurrency }}>
      {children}
    </CurrencyContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function useCurrency() {
  return useContext(CurrencyContext);
}
