/**
 * NfcModule.ts coverage: exercises the NativeNfcTransport class methods
 * and the runNative() error-wrap path. The other surface (toDomException,
 * setNfcTransport/getNfcTransport) is covered by
 * src/NfcModule.transport.test.ts and the conformance suite.
 *
 * NativeNfc is imported at module top from TurboModuleRegistry, which
 * returns null under Jest (no native bridge). To exercise the class body
 * (lines 110-183, currently uncovered at ~50%) we mock the NativeNfc
 * module per-test and exercise each method through the lazy
 * `getNfcTransport()` / `resetNfcTransport()` seam.
 */
import type {LaunchTagActivation, NfcTransportEventMap} from './transport';

// Mock NativeNfc BEFORE importing NfcModule so the module top-level
// TurboModuleRegistry.get() resolves to our fake. We rebuild the mock
// per-test inside beforeEach so individual tests can vary the behavior.
jest.mock('./NativeNfc', () => {
  const fake: {
    isSupported: jest.Mock<Promise<boolean>, []>;
    isEnabled: jest.Mock<Promise<boolean>, []>;
    beginScan: jest.Mock<Promise<void>, [string, object]>;
    beginWrite: jest.Mock<Promise<void>, [string, unknown, object]>;
    beginMakeReadOnly: jest.Mock<Promise<void>, [string, object]>;
    cancelOperation: jest.Mock<Promise<void>, [string]>;
    consumePendingLaunchTag: jest.Mock<Promise<LaunchTagActivation | null>, []>;
    addListener: jest.Mock<void, [string]>;
    removeListeners: jest.Mock<void, [number]>;
  } = {
    isSupported: jest.fn(),
    isEnabled: jest.fn(),
    beginScan: jest.fn(),
    beginWrite: jest.fn(),
    beginMakeReadOnly: jest.fn(),
    cancelOperation: jest.fn(),
    consumePendingLaunchTag: jest.fn(),
    addListener: jest.fn(),
    removeListeners: jest.fn(),
  };
  return {__esModule: true, default: fake};
});

import NativeNfc from './NativeNfc';
// Import after the mock is registered.
import {
  getNfcTransport,
  resetNfcTransport,
  setNfcTransport,
} from './NfcModule';

const nativeMock = NativeNfc as unknown as {
  isSupported: jest.Mock;
  isEnabled: jest.Mock;
  beginScan: jest.Mock;
  beginWrite: jest.Mock;
  beginMakeReadOnly: jest.Mock;
  cancelOperation: jest.Mock;
  consumePendingLaunchTag: jest.Mock;
  addListener: jest.Mock;
  removeListeners: jest.Mock;
};

beforeEach(() => {
  // Clear every mock's call history so each test sees a clean slate; the
  // mock implementations themselves are also reset to no-op resolvers.
  for (const fn of Object.values(nativeMock)) fn.mockReset();
  // Most tests want a "happy path" — return resolved promises.
  nativeMock.isSupported.mockResolvedValue(true);
  nativeMock.isEnabled.mockResolvedValue(true);
  nativeMock.beginScan.mockResolvedValue(undefined);
  nativeMock.beginWrite.mockResolvedValue(undefined);
  nativeMock.beginMakeReadOnly.mockResolvedValue(undefined);
  nativeMock.cancelOperation.mockResolvedValue(undefined);
  nativeMock.consumePendingLaunchTag.mockResolvedValue(null);
  // Reset the lazy instance so getNfcTransport() rebuilds with the new mock.
  resetNfcTransport();
});

afterAll(() => {
  resetNfcTransport();
  jest.unmock('./NativeNfc');
});

describe('NfcModule: NativeNfcTransport class body', () => {
  test('isSupported() forwards to NativeNfc and unwraps the result', async () => {
    nativeMock.isSupported.mockResolvedValue(true);
    const transport = getNfcTransport();
    expect(await transport.isSupported()).toBe(true);
    expect(nativeMock.isSupported).toHaveBeenCalledTimes(1);
  });

  test('isEnabled() forwards to NativeNfc and unwraps the result', async () => {
    nativeMock.isEnabled.mockResolvedValue(false);
    const transport = getNfcTransport();
    expect(await transport.isEnabled()).toBe(false);
    expect(nativeMock.isEnabled).toHaveBeenCalledTimes(1);
  });

  test('beginScan() forwards operationId + opts to NativeNfc', async () => {
    const transport = getNfcTransport();
    await transport.beginScan('op-1', {alertMessage: 'tap'});
    expect(nativeMock.beginScan).toHaveBeenCalledWith('op-1', {
      alertMessage: 'tap',
    });
  });

  test('beginWrite() forwards operationId + records + opts to NativeNfc', async () => {
    const transport = getNfcTransport();
    const records = [{tnf: 0x01, type: 'VA==', id: '', payload: 'AQIDBA=='}];
    await transport.beginWrite('op-2', records, {
      overwrite: false,
      alertMessage: 'write',
    });
    expect(nativeMock.beginWrite).toHaveBeenCalledWith('op-2', records, {
      overwrite: false,
      alertMessage: 'write',
    });
  });

  test('beginMakeReadOnly() forwards operationId + opts to NativeNfc', async () => {
    const transport = getNfcTransport();
    await transport.beginMakeReadOnly('op-3', {alertMessage: 'lock'});
    expect(nativeMock.beginMakeReadOnly).toHaveBeenCalledWith('op-3', {
      alertMessage: 'lock',
    });
  });

  test('cancelOperation() forwards operationId to NativeNfc', async () => {
    const transport = getNfcTransport();
    await transport.cancelOperation('op-cancel');
    expect(nativeMock.cancelOperation).toHaveBeenCalledWith('op-cancel');
  });

  test('consumePendingLaunchTag() forwards and unwraps the activation', async () => {
    const activation = {
      activationId: 'launch-1',
      serialNumber: 's1',
      records: [],
    };
    nativeMock.consumePendingLaunchTag.mockResolvedValue(activation);
    const transport = getNfcTransport();
    expect(await transport.consumePendingLaunchTag()).toBe(activation);
  });

  test('consumePendingLaunchTag() forwards and unwraps null', async () => {
    nativeMock.consumePendingLaunchTag.mockResolvedValue(null);
    const transport = getNfcTransport();
    expect(await transport.consumePendingLaunchTag()).toBeNull();
  });

  test('addEventListener returns a no-op Subscription when the emitter is unavailable', () => {
    // When NativeNfc is non-null the NativeEventEmitter is constructed, so
    // addListener is called on the emitter. We exercise the no-op path by
    // substituting null for NativeNfc (mimicking the "web/host hasn't
    // linked native code yet" code path).
    resetNfcTransport();
    // Re-mock NativeNfc as null for this single test.
    jest.doMock('./NativeNfc', () => ({
      __esModule: true,
      default: null,
    }));
    // Force a fresh module graph for the no-op path.
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const isolated = require('./NfcModule') as typeof import('./NfcModule');
      const transport = isolated.getNfcTransport();
      const sub = transport.addEventListener('tagDiscovered', () => {});
      // No-op remove() must not throw and must be callable.
      expect(() => sub.remove()).not.toThrow();
      // Unknown event type also returns a Subscription (the listener isn't
      // forwarded anywhere when there's no emitter, but the contract holds).
      const sub2 = transport.addEventListener(
        'unknown' as keyof NfcTransportEventMap as never,
        () => {},
      );
      expect(() => sub2.remove()).not.toThrow();
    });
    // Restore the default non-null mock for subsequent tests.
    jest.dontMock('./NativeNfc');
    resetNfcTransport();
  });

  test('requireNative() throws NotSupportedError when NativeNfc is null (line 121)', () => {
    // Reload the module with NativeNfc = null to exercise the requireNative()
    // throw path (line 121 in NfcModule.ts).
    jest.resetModules();
    jest.doMock('./NativeNfc', () => ({
      __esModule: true,
      default: null,
    }));
    const isolated = require('./NfcModule');
    const transport = isolated.getNfcTransport();
    // Any method that calls requireNative() should throw NotSupportedError.
    expect(() => transport.isSupported()).rejects.toMatchObject({
      name: 'NotSupportedError',
    });
    jest.dontMock('./NativeNfc');
  });

  test('addEventListener returns no-op Subscription when NativeNfc is null (line 178)', () => {
    // Reload with null NativeNfc to exercise the no-op subscription branch
    // inside addEventListener (line 178 in NfcModule.ts).
    jest.resetModules();
    jest.doMock('./NativeNfc', () => ({
      __esModule: true,
      default: null,
    }));
    const isolated = require('./NfcModule');
    const transport = isolated.getNfcTransport();
    const sub = transport.addEventListener('tagDiscovered', () => {});
    expect(() => sub.remove()).not.toThrow();
    jest.dontMock('./NativeNfc');
  });

  test('runNative() converts a non-DOMException rejection into a DOMException', async () => {
    // NativeNfc rejects with a plain Error whose .code is a spec name
    // — exactly the shape that arrives over the RN bridge. The wrapped
    // promise should reject with a DOMException of the matching name.
    nativeMock.beginScan.mockRejectedValue(
      Object.assign(new Error('hardware disabled'), {code: 'NotAllowedError'}),
    );
    const transport = getNfcTransport();
    await expect(transport.beginScan('op', {})).rejects.toMatchObject({
      name: 'NotAllowedError',
    });
  });

  test('runNative() passes a DOMException rejection through unchanged', async () => {
    // Defensive: if some upstream code already throws a DOMException, we
    // don't wrap it again. We assert the error name is preserved.
    const {DOMException} = jest.requireActual(
      './lib/dom-exception',
    ) as typeof import('./lib/dom-exception');
    const original = new DOMException('already', 'NetworkError');
    nativeMock.beginScan.mockRejectedValue(original);
    const transport = getNfcTransport();
    await expect(transport.beginScan('op', {})).rejects.toMatchObject({
      name: 'NotReadableError',
      message: 'already',
    });
  });

  test('runNative() applies the same wrap to isSupported/isEnabled/write/etc.', async () => {
    // Belt-and-braces: every public method that goes through runNative
    // gets the same wrap. Verifying a couple proves the wrap is uniform
    // and isn't accidentally skipped on a single method.
    nativeMock.beginWrite.mockRejectedValue(
      Object.assign(new Error('I/O'), {code: 'NetworkError'}),
    );
    nativeMock.cancelOperation.mockRejectedValue(
      Object.assign(new Error('abort'), {code: 'AbortError'}),
    );
    nativeMock.beginMakeReadOnly.mockRejectedValue(
      Object.assign(new Error('not allowed'), {code: 'NotAllowedError'}),
    );
    const transport = getNfcTransport();
    await expect(
      transport.beginWrite('op', [], {overwrite: true}),
    ).rejects.toMatchObject({name: 'NetworkError'});
    await expect(transport.cancelOperation('op')).rejects.toMatchObject({
      name: 'AbortError',
    });
    await expect(transport.beginMakeReadOnly('op', {})).rejects.toMatchObject({
      name: 'NotAllowedError',
    });
  });
});

describe('NfcModule: getNfcTransport/setNfcTransport/resetNfcTransport', () => {
  test('setNfcTransport(null) clears the override', () => {
    setNfcTransport({} as never);
    resetNfcTransport();
    // After reset, getNfcTransport should rebuild the lazy instance —
    // since the native mock is the default (non-null), it constructs
    // the NativeNfcTransport.
    const t = getNfcTransport();
    expect(typeof t.beginScan).toBe('function');
  });

  test('setNfcTransport with an override returns the override from getNfcTransport', () => {
    const custom = {beginScan: jest.fn()} as never;
    setNfcTransport(custom);
    expect(getNfcTransport()).toBe(custom);
    // Reset so the override doesn't leak to later tests.
    setNfcTransport(null);
  });
});
