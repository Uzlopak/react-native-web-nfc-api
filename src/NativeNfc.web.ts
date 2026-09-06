/**
 * Web stub (§1, §4): on web, TurboModuleRegistry is never touched at all —
 * this file replaces NativeNfc.ts via RN's platform-extension resolution.
 * The managed strategy on web (mode: 'managed') never reaches this module;
 * it only talks to NfcTransport (satisfied by InMemoryNfcTransport or
 * nothing). Passthrough mode also never touches this module.
 */
export default null;
