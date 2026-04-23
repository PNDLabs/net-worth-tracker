import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.pndlabs.networthtracker',
  appName: 'NetWorth Tracker',
  webDir: 'dist',
  android: {
    minSdkVersion: 22,
    targetSdkVersion: 34,
  },
  plugins: {
    CapacitorSQLite: {
      iosDatabaseLocation: 'Library/CapacitorDatabase',
      iosIsEncryption: false,
      iosKeychainPrefix: 'networth',
      androidIsEncryption: false,
    },
  },
};

export default config;
