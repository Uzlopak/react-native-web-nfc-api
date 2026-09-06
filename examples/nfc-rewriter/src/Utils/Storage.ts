/**
 * Port of the vendored app's Utils/Storage.js. The original uses
 * @react-native-async-storage/async-storage; to keep this example's
 * dependency surface minimal (and runnable identically on web, where that
 * native module needs its own web shim), this port uses a tiny in-memory
 * store on native/web alike, backed by `localStorage` on web when available.
 * Saved records are demo/example data, not something this port needs to
 * persist reliably across app reinstalls — see README.md.
 */
import {Platform} from 'react-native';

export interface SavedRecord {
  name: string;
  payload: {
    ndefType: 'TEXT' | 'URI' | 'WIFI_SIMPLE' | 'VCARD';
    value: unknown;
  };
}

function createStorage(key: string) {
  let cache: SavedRecord[] | null = null;

  function readBacking(): SavedRecord[] {
    if (Platform.OS === 'web' && typeof localStorage !== 'undefined') {
      try {
        const raw = localStorage.getItem(key);
        return raw ? JSON.parse(raw) : [];
      } catch {
        return [];
      }
    }
    return cache ?? [];
  }

  function writeBacking(data: SavedRecord[]) {
    if (Platform.OS === 'web' && typeof localStorage !== 'undefined') {
      try {
        localStorage.setItem(key, JSON.stringify(data));
      } catch {
        // ignore quota/availability errors — demo storage only
      }
    }
    cache = data;
  }

  async function get(force = false): Promise<SavedRecord[]> {
    if (cache === null || force) {
      cache = readBacking();
    }
    return cache;
  }

  async function set(data: SavedRecord[]): Promise<void> {
    writeBacking(data);
  }

  return {get, set};
}

export {createStorage};
