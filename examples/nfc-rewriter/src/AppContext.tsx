/**
 * Port of the vendored app's AppContext.js — a small React context wrapping
 * the saved-record list persisted via Utils/Storage.ts. Simplified to a
 * function component + useState (the original's class-based Actions-mutation
 * pattern doesn't translate well to TypeScript without extra ceremony that
 * adds nothing here).
 */
import React from 'react';
import {createStorage, type SavedRecord} from './Utils/Storage';

const recordListHandler = createStorage('nfc-rewriter:recordList');

interface AppContextValue {
  storageCache: SavedRecord[];
  setStorage: (data: SavedRecord[]) => Promise<void>;
  initStorage: () => Promise<void>;
}

const Context = React.createContext<AppContextValue | null>(null);

function AppProvider({children}: {children: React.ReactNode}) {
  const [storageCache, setStorageCache] = React.useState<SavedRecord[]>([]);

  const initStorage = React.useCallback(async () => {
    setStorageCache(await recordListHandler.get(true));
  }, []);

  const setStorage = React.useCallback(async (data: SavedRecord[]) => {
    await recordListHandler.set(data);
    setStorageCache(await recordListHandler.get(true));
  }, []);

  React.useEffect(() => {
    initStorage();
  }, [initStorage]);

  const value = React.useMemo(
    () => ({storageCache, setStorage, initStorage}),
    [storageCache, setStorage, initStorage],
  );

  return <Context.Provider value={value}>{children}</Context.Provider>;
}

function useAppContext(): AppContextValue {
  const ctx = React.useContext(Context);
  if (!ctx) {
    throw new Error('useAppContext() must be used within <AppProvider>');
  }
  return ctx;
}

export {AppProvider, useAppContext};
