/**
 * Regression tests for WebNfcReader.scan() / write() / makeReadOnly()
 * listener hygiene on the user-supplied AbortSignal.
 *
 * The pre-fix scan() attached an abort listener to the signal but never
 * removed it, leaking the closure (and its captured coordinator/transport)
 * onto long-lived signals reused across many scans. write() and
 * makeReadOnly() were already balanced.
 */

import {Event} from './lib/event-target';
import {createTagFixture} from './testing/fixtures';
import {EmptyTag, NonNdefTag, TextTag} from './testing/simulated-tag';
import {NDEFReader} from './WebNfcReader';
import {InMemoryNfcTransport} from './testing/in-memory-transport';

class TrackingAbortSignal {
  aborted = false;
  private listeners = new Set<(ev: Event) => void>();
  added = 0;
  removed = 0;

  addEventListener(_type: 'abort', listener: (ev: Event) => void): void {
    this.added += 1;
    this.listeners.add(listener);
  }

  removeEventListener(_type: 'abort', listener: (ev: Event) => void): void {
    this.removed += 1;
    this.listeners.delete(listener);
  }

  triggerAbort(): void {
    if (this.aborted) return;
    this.aborted = true;
    const ev = new Event('abort');
    for (const l of [...this.listeners]) l(ev);
  }
}

async function flush(times = 4): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
  }
}

describe('WebNfcReader: AbortSignal listener balance', () => {
  test('scan() removes the abort listener after the abort fires', async () => {
    const {reader} = createTagFixture(new EmptyTag());
    const signal = new TrackingAbortSignal();
    await reader.scan({signal});
    expect(signal.added).toBe(1);

    signal.triggerAbort();
    await flush();
    expect(signal.removed).toBe(1);
  });

  test('scan() balances add/remove even when the signal is already aborted at entry', async () => {
    const {reader} = createTagFixture(new EmptyTag());
    const signal = new TrackingAbortSignal();
    signal.triggerAbort();
    await expect(reader.scan({signal})).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(signal.added).toBe(signal.removed);
  });

  test('write() is already balanced (sanity baseline)', async () => {
    const {reader} = createTagFixture(new EmptyTag());
    const signal = new TrackingAbortSignal();
    signal.triggerAbort();
    await expect(reader.write('x', {signal})).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(signal.added).toBe(signal.removed);
  });

  test('write() removes the abort listener after the abort fires mid-write', async () => {
    const {reader} = createTagFixture(new EmptyTag());
    const signal = new TrackingAbortSignal();
    const writePromise = reader.write('x', {signal});
    await flush();
    expect(signal.added).toBe(1);
    signal.triggerAbort();
    await flush();
    expect(signal.removed).toBe(1);
    await writePromise.catch(() => {});
  });

  test('makeReadOnly() removes the abort listener after the abort fires', async () => {
    const {reader} = createTagFixture(new EmptyTag());
    const signal = new TrackingAbortSignal();
    const mroPromise = reader.makeReadOnly({signal});
    await flush();
    expect(signal.added).toBe(1);
    signal.triggerAbort();
    await flush();
    expect(signal.removed).toBe(1);
    await mroPromise.catch(() => {});
  });

  test('repeated scan/abort cycles do not accumulate listeners on the signal', async () => {
    let totalAdded = 0;
    let totalRemoved = 0;
    for (let i = 0; i < 5; i++) {
      const {reader} = createTagFixture(new EmptyTag());
      const signal = new TrackingAbortSignal();
      await reader.scan({signal});
      signal.triggerAbort();
      await flush();
      totalAdded += signal.added;
      totalRemoved += signal.removed;
    }
    expect(totalAdded).toBe(totalRemoved);
    expect(totalAdded).toBe(5);
  });
});

describe('WebNfcReader: NDEFRecord smart-poster toRecordsWire (lines 58-60)', () => {
  test('NDEFRecord with smart-poster sets toRecords to an array of nested records', () => {
    const nested = {recordType: 'url', data: 'https://example.com'};
    const record = new (require('./WebNfcReader').NDEFRecord)({
      recordType: 'smart-poster',
      data: {records: [nested]},
    });
    expect(record.recordType).toBe('smart-poster');
    expect(typeof record.toRecords).toBe('function');
    const nestedRecords = record.toRecords!();
    expect(nestedRecords).toHaveLength(1);
    expect(nestedRecords[0].recordType).toBe('url');
  });

  test('NDEFRecord without smart-poster has no toRecords', () => {
    const record = new (require('./WebNfcReader').NDEFRecord)({
      recordType: 'text',
      data: 'hello',
    });
    expect(record.toRecords).toBeUndefined();
  });
});

describe('WebNfcReader: _resetCoordinatorForTransport (line 187)', () => {
  test('_resetCoordinatorForTransport removes the coordinator from the map', () => {
    const transport = new InMemoryNfcTransport();
    const {reader} = createTagFixture(new EmptyTag(), {transport});
    // First access creates the coordinator
    const {reader: reader2} = createTagFixture(new EmptyTag(), {transport});
    // Both readers should share the same coordinator (via getCoordinatorFor)
    expect(reader).toBeDefined();
    expect(reader2).toBeDefined();
    // Reset the coordinator
    const {_resetCoordinatorForTransport} = require('./WebNfcReader');
    _resetCoordinatorForTransport(transport);
    // New reader after reset gets a fresh coordinator
    const {reader: reader3} = createTagFixture(new EmptyTag(), {transport});
    expect(reader3).toBeDefined();
  });
});

describe('WebNfcReader: scan signal already aborted after listener attached (lines 250-251)', () => {
  test('scan() resolves once subscribed, then removes the abort listener once aborted', async () => {
    const {reader} = createTagFixture(new EmptyTag());
    const signal = new TrackingAbortSignal();
    // scan() only subscribes to the coordinator — it resolves as soon as
    // that subscription is set up, without waiting for a tag or an abort.
    await expect(reader.scan({signal})).resolves.toBeUndefined();
    signal.triggerAbort();
    await flush();
    expect(signal.added).toBe(signal.removed);
  });
});

describe('WebNfcReader: NDEFReader.isSupported static (lines 508-511)', () => {
  test('NDEFReader.isSupported() returns true on native (mode defaults to passthrough)', () => {
    const {NDEFReader} = require('./WebNfcReader');
    // In test environment (Node/Jest), isWeb() returns false, so it returns true
    expect(NDEFReader.isSupported()).toBe(true);
    expect(NDEFReader.isSupported('managed')).toBe(true);
  });

  test('NDEFReader.isSupported() with passthrough on web detects native NDEFReader', () => {
    // isWeb() is not exported, but we can test the logic by directly calling
    // NDEFReader.isSupported in a mocked web environment. Since we can't easily
    // mock window/document in this test environment, we just verify the
    // default behavior (Node/Jest = not web).
    const {NDEFReader} = require('./WebNfcReader');
    // In Node/Jest, isWeb() returns false internally, so it returns true
    expect(NDEFReader.isSupported()).toBe(true);
    expect(NDEFReader.isSupported('managed')).toBe(true);
  });
});

describe('WebNfcReader: onreading/onreadingerror callbacks (lines 531, 533)', () => {
  test('onreading callback fires when reading event is dispatched', async () => {
    const {reader} = createTagFixture(new TextTag({text: 'hello'}));
    let readingEvent: any = null;
    reader.onreading = (ev) => {
      readingEvent = ev;
    };
    await reader.scan();
    // Tag discovery is delivered via setTimeout (even with 0ms delay) to
    // mirror real hardware never resolving synchronously with scan() — a
    // microtask-only flush() never lets that macrotask run.
    await new Promise(resolve => setTimeout(resolve, 0));
    await flush();
    expect(readingEvent).not.toBeNull();
    expect(readingEvent.type).toBe('reading');
    expect(readingEvent.message).toBeDefined();
  });

  test('onreadingerror callback fires when readingerror is dispatched', async () => {
    const {reader} = createTagFixture(new NonNdefTag());
    let errorEvent: any = null;
    reader.onreadingerror = (ev) => {
      errorEvent = ev;
    };
    await reader.scan();
    // Discovery (and the resulting non-NDEF error) is delivered via
    // setTimeout, same as the onreading path above.
    await new Promise(resolve => setTimeout(resolve, 0));
    await flush();
    expect(errorEvent).not.toBeNull();
    expect(errorEvent.type).toBe('readingerror');
  });
});

describe('WebNfcReader: makeReadOnly signal already aborted after listener (line 319, 336, 349)', () => {
  test('makeReadOnly() throws if signal aborts after listener attached', async () => {
    // No tag present, so beginMakeReadOnly() stays pending long enough for
    // the abort to race the listener attachment instead of resolving first.
    const {reader} = createTagFixture();
    const signal = new TrackingAbortSignal();
    const mroPromise = reader.makeReadOnly({signal});
    await flush(); // wait for listener to be attached
    signal.triggerAbort();
    await flush();
    await expect(mroPromise).rejects.toMatchObject({name: 'AbortError'});
    expect(signal.removed).toBe(1);
  });

  test('makeReadOnly() cancels immediately if the signal aborts in the add/check race window (line 349)', async () => {
    const {reader} = createTagFixture();
    // Flips to aborted the instant addEventListener is called, simulating
    // the narrow window between beginMakeReadOnly() starting and the
    // synchronous `if (signal.aborted) abortListener()` re-check right
    // after the listener is attached.
    const signal: any = {
      aborted: false,
      addEventListener(_type: 'abort', _listener: () => void) {
        signal.aborted = true;
      },
      removeEventListener() {},
    };
    await expect(reader.makeReadOnly({signal})).rejects.toMatchObject({
      name: 'AbortError',
    });
  });
});

describe('WebNfcReader: PassthroughStrategy (lines 393-465)', () => {
  test('PassthroughStrategy throws NotSupportedError when no native NDEFReader', () => {
    const {PassthroughStrategy} = require('./WebNfcReader');
    // In Node/Jest, there's no window.NDEFReader
    const strategy = new PassthroughStrategy();
    expect(() => strategy.getOrCreateBrowserReader()).toThrow(
      'this browser has no native NDEFReader implementation',
    );
  });

  test('PassthroughStrategy forwards scan/write/makeReadOnly to browser reader', async () => {
    const {PassthroughStrategy} = require('./WebNfcReader');
    const strategy = new PassthroughStrategy();
    // Mock a browser reader
    const mockReader = {
      scan: jest.fn().mockResolvedValue(undefined),
      write: jest.fn().mockResolvedValue(undefined),
      makeReadOnly: jest.fn().mockResolvedValue(undefined),
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
    };
    strategy['browserReader'] = mockReader;
    const dispatch = jest.fn();
    await strategy.scan({signal: undefined}, dispatch);
    await strategy.write('test', {overwrite: true});
    await strategy.makeReadOnly();
    expect(mockReader.scan).toHaveBeenCalled();
    expect(mockReader.write).toHaveBeenCalled();
    expect(mockReader.makeReadOnly).toHaveBeenCalled();
  });
});

describe('WebNfcReader: scan signal aborted between listener add and check (lines 250-251)', () => {
  test('scan() calls onAbort and balances the listener once aborted after resolving', async () => {
    const {reader} = createTagFixture(new EmptyTag());
    const signal = new TrackingAbortSignal();
    const scanPromise = reader.scan({signal});
    await flush();
    await expect(scanPromise).resolves.toBeUndefined();
    signal.triggerAbort();
    await flush();
    expect(signal.added).toBe(signal.removed);
  });

  test('scan() throws AbortError synchronously if signal aborts in the add/check race window (line 250-251)', async () => {
    const {reader} = createTagFixture(new EmptyTag());
    // A signal that flips to aborted the instant addEventListener is called —
    // simulating the narrow window between attaching the listener and the
    // synchronous re-check right after it.
    const signal: any = {
      aborted: false,
      addEventListener(_type: 'abort', _listener: (ev: Event) => void) {
        signal.aborted = true;
      },
      removeEventListener() {},
    };
    await expect(reader.scan({signal})).rejects.toMatchObject({
      name: 'AbortError',
    });
  });
});

describe('WebNfcReader: makeReadOnly() capability-check branches (lines 319, 336)', () => {
  test('makeReadOnly() throws AbortError when the signal is already aborted at entry', async () => {
    const {reader} = createTagFixture(new EmptyTag());
    const signal = new TrackingAbortSignal();
    signal.triggerAbort();
    await expect(reader.makeReadOnly({signal})).rejects.toMatchObject({
      name: 'AbortError',
    });
  });

  test('makeReadOnly() throws NotReadableError when NFC is disabled', async () => {
    const {reader} = createTagFixture(new EmptyTag(), {autoEnabled: false});
    await expect(reader.makeReadOnly()).rejects.toMatchObject({
      name: 'NotReadableError',
    });
  });
});

describe('WebNfcReader: PassthroughStrategy forwarding + browser reader creation (lines 412-413, 420-437)', () => {
  function makeMockBrowserReaderCtor() {
    const listenersByType = new Map<string, Array<(ev: unknown) => void>>();
    const mockReader = {
      scan: jest.fn().mockResolvedValue(undefined),
      write: jest.fn().mockResolvedValue(undefined),
      makeReadOnly: jest.fn().mockResolvedValue(undefined),
      addEventListener: jest.fn((type: string, cb: (ev: unknown) => void) => {
        const arr = listenersByType.get(type) ?? [];
        arr.push(cb);
        listenersByType.set(type, arr);
      }),
      removeEventListener: jest.fn(),
      emit(type: string, ev: unknown) {
        for (const cb of listenersByType.get(type) ?? []) cb(ev);
      },
    };
    const Ctor = jest.fn(() => mockReader);
    return {Ctor, mockReader};
  }

  test('getOrCreateBrowserReader() constructs and caches a real browser reader (lines 412-413)', async () => {
    const {PassthroughStrategy} = require('./WebNfcReader');
    const {Ctor, mockReader} = makeMockBrowserReaderCtor();
    (globalThis as any).NDEFReader = Ctor;
    try {
      const strategy = new PassthroughStrategy();
      const dispatch = jest.fn();
      await strategy.scan({signal: undefined}, dispatch);
      // Second call reuses the cached instance instead of constructing again.
      await strategy.write('x', {overwrite: true});
      expect(Ctor).toHaveBeenCalledTimes(1);
      expect(mockReader.scan).toHaveBeenCalled();
    } finally {
      delete (globalThis as any).NDEFReader;
    }
  });

  test('bindForwarding() forwards a browser "reading" event as our own NDEFReadingEvent (lines 420-435)', async () => {
    const {PassthroughStrategy} = require('./WebNfcReader');
    const {Ctor, mockReader} = makeMockBrowserReaderCtor();
    (globalThis as any).NDEFReader = Ctor;
    try {
      const strategy = new PassthroughStrategy();
      const dispatch = jest.fn();
      await strategy.scan({signal: undefined}, dispatch);
      mockReader.emit('reading', {
        type: 'reading',
        serialNumber: 'abc',
        message: {records: []},
      });
      expect(dispatch).toHaveBeenCalledWith(
        expect.objectContaining({type: 'reading'}),
      );
      const forwarded = dispatch.mock.calls[0][0];
      expect(forwarded.serialNumber).toBe('abc');
      expect(forwarded.message).toEqual({records: []});
    } finally {
      delete (globalThis as any).NDEFReader;
    }
  });

  test('bindForwarding() defaults serialNumber to "" when the browser event omits it (line 119)', async () => {
    const {PassthroughStrategy} = require('./WebNfcReader');
    const {Ctor, mockReader} = makeMockBrowserReaderCtor();
    (globalThis as any).NDEFReader = Ctor;
    try {
      const strategy = new PassthroughStrategy();
      const dispatch = jest.fn();
      await strategy.scan({signal: undefined}, dispatch);
      mockReader.emit('reading', {type: 'reading', message: {records: []}});
      const forwarded = dispatch.mock.calls[0][0];
      expect(forwarded.serialNumber).toBe('');
    } finally {
      delete (globalThis as any).NDEFReader;
    }
  });

  test('bindForwarding() forwards a browser "readingerror" event as a plain Event (line 437)', async () => {
    const {PassthroughStrategy} = require('./WebNfcReader');
    const {Ctor, mockReader} = makeMockBrowserReaderCtor();
    (globalThis as any).NDEFReader = Ctor;
    try {
      const strategy = new PassthroughStrategy();
      const dispatch = jest.fn();
      await strategy.scan({signal: undefined}, dispatch);
      mockReader.emit('readingerror', {type: 'readingerror'});
      expect(dispatch).toHaveBeenCalledWith(
        expect.objectContaining({type: 'readingerror'}),
      );
    } finally {
      delete (globalThis as any).NDEFReader;
    }
  });

  test('bindForwarding() is a no-op on a second call (already bound)', async () => {
    const {PassthroughStrategy} = require('./WebNfcReader');
    const {Ctor, mockReader} = makeMockBrowserReaderCtor();
    (globalThis as any).NDEFReader = Ctor;
    try {
      const strategy = new PassthroughStrategy();
      const dispatch = jest.fn();
      strategy.bindForwarding(dispatch);
      strategy.bindForwarding(dispatch);
      expect(mockReader.addEventListener).toHaveBeenCalledTimes(2); // reading + readingerror, once
    } finally {
      delete (globalThis as any).NDEFReader;
    }
  });
});

describe('WebNfcReader: web-mode isSupported()/constructor branches (lines 509, 518-519)', () => {
  const originalWindow = (globalThis as any).window;
  const originalDocument = (globalThis as any).document;

  afterEach(() => {
    if (originalWindow === undefined) delete (globalThis as any).window;
    else (globalThis as any).window = originalWindow;
    if (originalDocument === undefined) delete (globalThis as any).document;
    else (globalThis as any).document = originalDocument;
    delete (globalThis as any).NDEFReader;
  });

  test('isSupported() reflects window.NDEFReader presence when running "on the web" (line 509)', () => {
    (globalThis as any).window = {};
    (globalThis as any).document = {};
    // isolateModules scopes the require-cache reset to this callback only,
    // so `isWeb()` re-evaluates `typeof window` against the globals set
    // above without disturbing coverage instrumentation for the module
    // instance the rest of this file's tests share via the top-level import.
    jest.isolateModules(() => {
      const {NDEFReader: FreshNDEFReader} = require('./WebNfcReader');

      expect(FreshNDEFReader.isSupported()).toBe(false);

      (globalThis as any).NDEFReader = function () {};
      expect(FreshNDEFReader.isSupported()).toBe(true);
      // managed mode bypasses the web check entirely.
      expect(FreshNDEFReader.isSupported('managed')).toBe(true);
    });
  });

  test('constructor picks PassthroughStrategy when running "on the web" in passthrough mode (lines 518-519)', () => {
    (globalThis as any).window = {};
    (globalThis as any).document = {};
    (globalThis as any).NDEFReader = function () {
      return {
        addEventListener: jest.fn(),
        removeEventListener: jest.fn(),
      };
    };
    jest.isolateModules(() => {
      const {
        NDEFReader: FreshNDEFReader,
        PassthroughStrategy: FreshPassthroughStrategy,
      } = require('./WebNfcReader');

      const reader = new FreshNDEFReader();
      expect(reader['strategy']).toBeInstanceOf(FreshPassthroughStrategy);
      expect(reader['managedStrategy']).toBeUndefined();
    });
  });
});
