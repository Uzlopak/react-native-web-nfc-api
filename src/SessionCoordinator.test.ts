/**
 * SessionCoordinator.test.ts (§6b, §12e): unit tests against a hand-written
 * fake NfcTransport (not InMemoryNfcTransport, per the plan's step 4). This
 * file also covers the lifecycle additions (§12e/§12f) — extending, not
 * duplicating, this suite per the plan's instruction.
 */
import {createDOMException} from './lib/dom-exception';
import type {NdefWireRecord} from './lib/ndef-wire';
import {
  newReaderId,
  type ReaderCallbacks,
  type ReadingDelivery,
  SessionCoordinator,
} from './SessionCoordinator';
import type {
  AppStateChangedEvent,
  LaunchTagActivation,
  NfcTransport,
  NfcTransportEventMap,
  NfcTransportEventType,
  Subscription,
} from './transport';

function wireRecord(text = 'hello'): NdefWireRecord {
  return {tnf: 1, type: btoa('T'), id: '', payload: btoa(text)};
}

/** A minimal, fully controllable fake NfcTransport (§6b step-4 requirement). */
class FakeTransport implements NfcTransport {
  supported = true;
  enabled = true;
  beginScanCalls: string[] = [];
  cancelCalls: string[] = [];
  beginWriteCalls: Array<{
    operationId: string;
    records: NdefWireRecord[];
    overwrite: boolean;
  }> = [];
  beginMakeReadOnlyCalls: string[] = [];
  pendingLaunchTags: LaunchTagActivation[] = [];

  private listeners: {
    [K in NfcTransportEventType]: Array<(ev: NfcTransportEventMap[K]) => void>;
  } = {
    tagDiscovered: [],
    operationEnded: [],
    stateChanged: [],
    appStateChanged: [],
    launchTagReceived: [],
  };

  /** Control knobs for beginScan/beginWrite/beginMakeReadOnly outcomes. */
  beginScanImpl: (operationId: string) => Promise<void> = async () => {};
  beginWriteImpl: (
    operationId: string,
    records: NdefWireRecord[],
    overwrite: boolean,
  ) => Promise<void> = async () => {};
  beginMakeReadOnlyImpl: (operationId: string) => Promise<void> =
    async () => {};

  async isSupported(): Promise<boolean> {
    return this.supported;
  }

  async isEnabled(): Promise<boolean> {
    return this.enabled;
  }

  async beginScan(
    operationId: string,
    _opts: {alertMessage?: string},
  ): Promise<void> {
    this.beginScanCalls.push(operationId);
    return this.beginScanImpl(operationId);
  }

  async beginWrite(
    operationId: string,
    records: NdefWireRecord[],
    opts: {overwrite: boolean},
  ): Promise<void> {
    this.beginWriteCalls.push({
      operationId,
      records,
      overwrite: opts.overwrite,
    });
    return this.beginWriteImpl(operationId, records, opts.overwrite);
  }

  async beginMakeReadOnly(
    operationId: string,
    _opts: {alertMessage?: string},
  ): Promise<void> {
    this.beginMakeReadOnlyCalls.push(operationId);
    return this.beginMakeReadOnlyImpl(operationId);
  }

  async cancelOperation(operationId: string): Promise<void> {
    this.cancelCalls.push(operationId);
    this.emit('operationEnded', {operationId, reason: 'cancelled'});
  }

  async consumePendingLaunchTag(): Promise<LaunchTagActivation | null> {
    return this.pendingLaunchTags.shift() ?? null;
  }

  addEventListener<T extends NfcTransportEventType>(
    type: T,
    cb: (ev: NfcTransportEventMap[T]) => void,
  ): Subscription {
    this.listeners[type].push(cb);
    return {
      remove: () => {
        const arr = this.listeners[type];
        const idx = arr.indexOf(cb);
        if (idx >= 0) arr.splice(idx, 1);
      },
    };
  }

  emit<T extends NfcTransportEventType>(
    type: T,
    ev: NfcTransportEventMap[T],
  ): void {
    for (const cb of [...this.listeners[type]]) cb(ev);
  }
}

function makeReaderCallbacks(): ReaderCallbacks & {
  readings: ReadingDelivery[];
  errors: unknown[];
} {
  const readings: ReadingDelivery[] = [];
  const errors: unknown[] = [];
  return {
    readings,
    errors,
    onReading: d => readings.push(d),
    onScanError: e => errors.push(e),
  };
}

async function flush(times = 3): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
    await Promise.resolve();
  }
}

describe('SessionCoordinator: scan broadcast (§6b)', () => {
  test('two readers both scanning both get tagDiscovered/reading events', async () => {
    const transport = new FakeTransport();
    const coordinator = new SessionCoordinator(transport);
    const readerA = makeReaderCallbacks();
    const readerB = makeReaderCallbacks();

    coordinator.addScanSubscriber('A', readerA);
    await flush();
    coordinator.addScanSubscriber('B', readerB);
    await flush();

    const opId = transport.beginScanCalls[0];
    transport.emit('tagDiscovered', {
      operationId: opId,
      serialNumber: 's1',
      records: [wireRecord()],
    });

    expect(readerA.readings).toHaveLength(1);
    expect(readerB.readings).toHaveLength(1);
    expect(readerA.readings[0].serialNumber).toBe('s1');
  });

  test('stopping one reader does not stop the other', async () => {
    const transport = new FakeTransport();
    const coordinator = new SessionCoordinator(transport);
    const readerA = makeReaderCallbacks();
    const readerB = makeReaderCallbacks();

    coordinator.addScanSubscriber('A', readerA);
    await flush();
    coordinator.addScanSubscriber('B', readerB);
    await flush();

    coordinator.removeScanSubscriber('A');
    await flush();

    expect(transport.cancelCalls).toHaveLength(0); // B still scanning; scan must not stop
    const opId = transport.beginScanCalls[0];
    transport.emit('tagDiscovered', {
      operationId: opId,
      serialNumber: 's2',
      records: [wireRecord()],
    });
    expect(readerA.readings).toHaveLength(0);
    expect(readerB.readings).toHaveLength(1);
  });

  test('removeScanSubscriber on a reader not currently subscribed is a no-op', () => {
    const transport = new FakeTransport();
    const coordinator = new SessionCoordinator(transport);
    expect(() => coordinator.removeScanSubscriber('never-added')).not.toThrow();
    expect(transport.beginScanCalls).toHaveLength(0);
  });

  test('a same-reader scan() while already scanning throws InvalidStateError synchronously', async () => {
    const transport = new FakeTransport();
    const coordinator = new SessionCoordinator(transport);
    const readerA = makeReaderCallbacks();
    coordinator.addScanSubscriber('A', readerA);
    await flush();
    expect(() => coordinator.addScanSubscriber('A', readerA)).toThrow(
      expect.objectContaining({name: 'InvalidStateError'}),
    );
  });
});

describe('SessionCoordinator: write/makeReadOnly replacement (§5a/§5d/§6b)', () => {
  test('a second write() while one is in flight replaces it: first rejects AbortError, second proceeds', async () => {
    const transport = new FakeTransport();
    const coordinator = new SessionCoordinator(transport);

    let resolveFirst: (() => void) | undefined;
    transport.beginWriteImpl = async () => {
      if (transport.beginWriteCalls.length === 1) {
        await new Promise<void>(resolve => {
          resolveFirst = resolve;
        });
      }
    };

    const firstPromise = coordinator.beginExclusiveOperation('write', opId =>
      transport.beginWrite(opId, [], {overwrite: true}),
    );
    await flush();

    const secondPromise = coordinator.beginExclusiveOperation('write', opId =>
      transport.beginWrite(opId, [], {overwrite: true}),
    );

    await expect(firstPromise).rejects.toMatchObject({name: 'AbortError'});
    resolveFirst?.();
    await expect(secondPromise).resolves.toBeUndefined();
    expect(transport.beginWriteCalls).toHaveLength(2);
    expect(transport.beginWriteCalls[0].operationId).not.toBe(
      transport.beginWriteCalls[1].operationId,
    );
  });

  test('replacement propagates cancelOperation() to the transport (regression: finding #2)', async () => {
    // Before the fix, replaceActiveOperation() only rejected the JS-side
    // abort promise; the prior native operation kept running, so on real
    // hardware a stale write could still land on the tag after the caller
    // treated it as aborted. The fix now propagates cancelOperation() to
    // the transport for the prior operationId.
    const transport = new FakeTransport();
    const coordinator = new SessionCoordinator(transport);

    // Both writes hang until we resolve them, so we can assert cancel was
    // called for the FIRST one and not the second.
    let resolveSecond: (() => void) | undefined;
    transport.beginWriteImpl = () =>
      new Promise<void>(resolve => {
        resolveSecond = resolve;
      });

    const firstPromise = coordinator.beginExclusiveOperation('write', opId =>
      transport.beginWrite(opId, [], {overwrite: true}),
    );
    await flush();
    const firstOpId = transport.beginWriteCalls[0].operationId;

    const secondPromise = coordinator.beginExclusiveOperation('write', opId =>
      transport.beginWrite(opId, [], {overwrite: true}),
    );
    await flush();

    await expect(firstPromise).rejects.toMatchObject({name: 'AbortError'});
    // The transport must have been told to cancel the FIRST operationId
    // (not the second — that one is still in flight).
    expect(transport.cancelCalls).toContain(firstOpId);
    expect(transport.cancelCalls).not.toContain(
      transport.beginWriteCalls[1].operationId,
    );
    // Settle the dangling second promise so jest doesn't warn about leaks.
    resolveSecond?.();
    await expect(secondPromise).resolves.toBeUndefined();
  });

  test('replacement propagates cancelOperation() for makeReadOnly too (regression: finding #2)', async () => {
    const transport = new FakeTransport();
    const coordinator = new SessionCoordinator(transport);
    let resolveSecond: (() => void) | undefined;
    transport.beginMakeReadOnlyImpl = () =>
      new Promise<void>(resolve => {
        resolveSecond = resolve;
      });

    const firstPromise = coordinator.beginExclusiveOperation(
      'makeReadOnly',
      opId => transport.beginMakeReadOnly(opId, {}),
    );
    await flush();
    const firstOpId = transport.beginMakeReadOnlyCalls[0];

    const secondPromise = coordinator.beginExclusiveOperation(
      'makeReadOnly',
      opId => transport.beginMakeReadOnly(opId, {}),
    );
    await flush();

    await expect(firstPromise).rejects.toMatchObject({name: 'AbortError'});
    expect(transport.cancelCalls).toContain(firstOpId);
    resolveSecond?.();
    await expect(secondPromise).resolves.toBeUndefined();
  });

  test('replacement never rejects with InvalidStateError (§5d correction)', async () => {
    const transport = new FakeTransport();
    const coordinator = new SessionCoordinator(transport);
    const first = coordinator.beginExclusiveOperation(
      'write',
      opId =>
        new Promise<void>(() => {
          // never resolves on its own; only replacement settles it
          void transport.beginWrite(opId, [], {overwrite: true});
        }),
    );
    await flush();
    void coordinator.beginExclusiveOperation('write', opId =>
      transport.beginWrite(opId, [], {overwrite: true}),
    );
    await expect(first).rejects.not.toMatchObject({name: 'InvalidStateError'});
    await expect(first).rejects.toMatchObject({name: 'AbortError'});
  });

  test('a write() drives shouldScan to false and back to true with a fresh operationId', async () => {
    const transport = new FakeTransport();
    const coordinator = new SessionCoordinator(transport);
    const readerA = makeReaderCallbacks();
    coordinator.addScanSubscriber('A', readerA);
    await flush();
    const scanIdBeforeWrite = transport.beginScanCalls[0];
    expect(coordinator.debugState().scanOperationId).toBe(scanIdBeforeWrite);

    let resolveWrite: (() => void) | undefined;
    const writePromise = coordinator.beginExclusiveOperation(
      'write',
      async () => {
        await new Promise<void>(resolve => {
          resolveWrite = resolve;
        });
      },
    );
    await flush();

    expect(coordinator.debugState().shouldScan).toBe(false);
    expect(coordinator.debugState().scanOperationId).toBeNull();
    expect(transport.cancelCalls).toContain(scanIdBeforeWrite);

    resolveWrite?.();
    await writePromise;
    await flush();

    expect(coordinator.debugState().shouldScan).toBe(true);
    const scanIdAfterWrite =
      transport.beginScanCalls[transport.beginScanCalls.length - 1];
    expect(scanIdAfterWrite).not.toBe(scanIdBeforeWrite);
  });

  test('makeReadOnly() participates in the same exclusive-operation replacement rule', async () => {
    const transport = new FakeTransport();
    const coordinator = new SessionCoordinator(transport);
    let resolveFirst: (() => void) | undefined;
    transport.beginMakeReadOnlyImpl = async () => {
      await new Promise<void>(resolve => {
        resolveFirst = resolve;
      });
    };
    const first = coordinator.beginExclusiveOperation('makeReadOnly', opId =>
      transport.beginMakeReadOnly(opId, {}),
    );
    await flush();
    const second = coordinator.beginExclusiveOperation('makeReadOnly', opId =>
      transport.beginMakeReadOnly(opId, {}),
    );
    await expect(first).rejects.toMatchObject({name: 'AbortError'});
    resolveFirst?.();
    await expect(second).resolves.toBeUndefined();
  });
});

describe('SessionCoordinator: stale-event invariant (§5a) — dedicated case', () => {
  test('internal cancellation of scan A is swallowed, and a subsequent scan C keeps delivering to the same reader', async () => {
    const transport = new FakeTransport();
    const coordinator = new SessionCoordinator(transport);
    const readerA = makeReaderCallbacks();

    coordinator.addScanSubscriber('A', readerA);
    await flush();
    const scanA = transport.beginScanCalls[0];

    let resolveWrite: (() => void) | undefined;
    const writePromise = coordinator.beginExclusiveOperation(
      'write',
      async () => {
        await new Promise<void>(resolve => {
          resolveWrite = resolve;
        });
      },
    );
    await flush();

    // Reconciliation should have added scanA to internallyCancelledScans and
    // called cancelOperation(scanA); FakeTransport.cancelOperation already
    // emits operationEnded{cancelled} synchronously above via cancelCalls.
    expect(transport.cancelCalls).toContain(scanA);
    expect(readerA.errors).toHaveLength(0); // swallowed: no readingerror/abort-visible event

    resolveWrite?.();
    await writePromise;
    await flush();

    // A late/stale tagDiscovered for the now-superseded scanA must be dropped.
    transport.emit('tagDiscovered', {
      operationId: scanA,
      serialNumber: 'stale',
      records: [wireRecord()],
    });
    expect(readerA.readings).toHaveLength(0);

    const scanC = transport.beginScanCalls[transport.beginScanCalls.length - 1];
    expect(scanC).not.toBe(scanA);
    transport.emit('tagDiscovered', {
      operationId: scanC,
      serialNumber: 'fresh',
      records: [wireRecord()],
    });
    expect(readerA.readings).toHaveLength(1);
    expect(readerA.readings[0].serialNumber).toBe('fresh');
  });

  test('a stale tagDiscovered(A) after scan B started (independent of any write) is dropped, not broadcast to B', async () => {
    const transport = new FakeTransport();
    const coordinator = new SessionCoordinator(transport);
    const readerA = makeReaderCallbacks();
    coordinator.addScanSubscriber('A', readerA);
    await flush();
    const scanA = transport.beginScanCalls[0];

    // Simulate scan A being superseded by removing/re-adding the subscriber,
    // which reconciliation turns into cancel(A) + a fresh beginScan (B).
    coordinator.removeScanSubscriber('A');
    await flush();
    coordinator.addScanSubscriber('A', readerA);
    await flush();
    const scanB = transport.beginScanCalls[transport.beginScanCalls.length - 1];
    expect(scanB).not.toBe(scanA);

    transport.emit('tagDiscovered', {
      operationId: scanA,
      serialNumber: 'late-A',
      records: [wireRecord()],
    });
    expect(readerA.readings).toHaveLength(0);

    transport.emit('tagDiscovered', {
      operationId: scanB,
      serialNumber: 'on-B',
      records: [wireRecord()],
    });
    expect(readerA.readings).toHaveLength(1);
    expect(readerA.readings[0].serialNumber).toBe('on-B');
  });

  test('an operationEnded for a completely unrelated/unknown operationId is dropped without side effects', async () => {
    const transport = new FakeTransport();
    const coordinator = new SessionCoordinator(transport);
    const readerA = makeReaderCallbacks();
    coordinator.addScanSubscriber('A', readerA);
    await flush();
    transport.emit('operationEnded', {
      operationId: 'totally-unknown-id',
      reason: 'error',
    });
    expect(readerA.errors).toHaveLength(0);
  });

  test('a scan that ends on its own (native error) surfaces as a scan error, not swallowed', async () => {
    const transport = new FakeTransport();
    const coordinator = new SessionCoordinator(transport);
    const readerA = makeReaderCallbacks();
    coordinator.addScanSubscriber('A', readerA);
    await flush();
    const scanA = transport.beginScanCalls[0];
    transport.emit('operationEnded', {
      operationId: scanA,
      reason: 'error',
      message: 'radio died',
    });
    expect(readerA.errors).toHaveLength(1);
    expect((readerA.errors[0] as {name: string}).name).toBe('NotReadableError');
  });

  test('a scan that times out on its own maps to NotAllowedError (no message)', async () => {
    const transport = new FakeTransport();
    const coordinator = new SessionCoordinator(transport);
    const readerA = makeReaderCallbacks();
    coordinator.addScanSubscriber('A', readerA);
    await flush();
    const scanA = transport.beginScanCalls[0];
    transport.emit('operationEnded', {operationId: scanA, reason: 'timeout'});
    expect((readerA.errors[0] as {name: string}).name).toBe('NotAllowedError');
  });

  test('a scan timeout with an explicit message uses it verbatim', async () => {
    const transport = new FakeTransport();
    const coordinator = new SessionCoordinator(transport);
    const readerA = makeReaderCallbacks();
    coordinator.addScanSubscriber('A', readerA);
    await flush();
    const scanA = transport.beginScanCalls[0];
    transport.emit('operationEnded', {
      operationId: scanA,
      reason: 'timeout',
      message: 'no tag presented',
    });
    expect((readerA.errors[0] as {message: string}).message).toBe(
      'no tag presented',
    );
  });

  test('a scan error with no message uses the default message', async () => {
    const transport = new FakeTransport();
    const coordinator = new SessionCoordinator(transport);
    const readerA = makeReaderCallbacks();
    coordinator.addScanSubscriber('A', readerA);
    await flush();
    const scanA = transport.beginScanCalls[0];
    transport.emit('operationEnded', {operationId: scanA, reason: 'error'});
    expect((readerA.errors[0] as {message: string}).message).toBe(
      'operation ended with an error',
    );
  });

  test('a scan ending with reason "cancelled" that the coordinator did not itself track is not surfaced as an error', async () => {
    const transport = new FakeTransport();
    const coordinator = new SessionCoordinator(transport);
    const readerA = makeReaderCallbacks();
    coordinator.addScanSubscriber('A', readerA);
    await flush();
    const scanA = transport.beginScanCalls[0];
    // Not in internallyCancelledScans (coordinator didn't initiate this),
    // but still reason:'cancelled' — should clear scanOperationId, not error.
    transport.emit('operationEnded', {operationId: scanA, reason: 'cancelled'});
    expect(readerA.errors).toHaveLength(0);
    expect(coordinator.debugState().scanOperationId).toBeNull();
  });

  test('operationEnded matching the CURRENTLY ACTIVE exclusive operationId is a no-op at the coordinator level', async () => {
    const transport = new FakeTransport();
    const coordinator = new SessionCoordinator(transport);
    let capturedOpId = '';
    let resolveWrite: (() => void) | undefined;
    const writePromise = coordinator.beginExclusiveOperation(
      'write',
      async opId => {
        capturedOpId = opId;
        await new Promise<void>(resolve => {
          resolveWrite = resolve;
        });
      },
    );
    await flush();
    // While still active: an operationEnded success arriving early (e.g.
    // native's own confirmation) must not throw and must not clear/replace
    // anything the run() promise itself owns.
    expect(() =>
      transport.emit('operationEnded', {
        operationId: capturedOpId,
        reason: 'success',
      }),
    ).not.toThrow();
    resolveWrite?.();
    await writePromise;

    // After it's cleared, the same event is now stale and also a no-op.
    expect(() =>
      transport.emit('operationEnded', {
        operationId: capturedOpId,
        reason: 'success',
      }),
    ).not.toThrow();
  });
});

describe('SessionCoordinator: reconcile() beginScan failure path', () => {
  test('a beginScan() rejection clears scanOperationId and broadcasts a scan error', async () => {
    const transport = new FakeTransport();
    transport.beginScanImpl = async () => {
      throw createDOMException('NotReadableError', 'radio off');
    };
    const coordinator = new SessionCoordinator(transport);
    const readerA = makeReaderCallbacks();
    coordinator.addScanSubscriber('A', readerA);
    await flush();
    expect(readerA.errors).toHaveLength(1);
    expect(coordinator.debugState().scanOperationId).toBeNull();
  });

  test('a beginScan() rejection with a plain Error is wrapped as NotReadableError', async () => {
    const transport = new FakeTransport();
    transport.beginScanImpl = async () => {
      throw new Error('boom');
    };
    const coordinator = new SessionCoordinator(transport);
    const readerA = makeReaderCallbacks();
    coordinator.addScanSubscriber('A', readerA);
    await flush();
    expect((readerA.errors[0] as {name: string}).name).toBe('NotReadableError');
  });

  test('a beginScan() rejection with a non-Error value is stringified into the DOMException message', async () => {
    const transport = new FakeTransport();
    transport.beginScanImpl = async () => {
      throw 'plain string failure';
    };
    const coordinator = new SessionCoordinator(transport);
    const readerA = makeReaderCallbacks();
    coordinator.addScanSubscriber('A', readerA);
    await flush();
    expect((readerA.errors[0] as {name: string; message: string}).message).toBe(
      'plain string failure',
    );
  });

  test('a stale beginScan() rejection (scanOperationId already moved on) does not clear the newer id', async () => {
    const transport = new FakeTransport();
    let rejectFirst: ((err: unknown) => void) | undefined;
    let call = 0;
    transport.beginScanImpl = async () => {
      call += 1;
      if (call === 1) {
        await new Promise<void>((_resolve, reject) => {
          rejectFirst = reject;
        });
      }
    };
    const coordinator = new SessionCoordinator(transport);
    const readerA = makeReaderCallbacks();
    coordinator.addScanSubscriber('A', readerA);
    await flush();
    const firstScanId = transport.beginScanCalls[0];

    // Force reconciliation to move on to a new scanOperationId without the
    // first beginScan() having settled yet (simulated by removing then
    // re-adding the same subscriber, which triggers cancel+restart).
    coordinator.removeScanSubscriber('A');
    await flush();
    coordinator.addScanSubscriber('A', readerA);
    await flush();
    const secondScanId =
      transport.beginScanCalls[transport.beginScanCalls.length - 1];
    expect(secondScanId).not.toBe(firstScanId);

    // Now the stale first beginScan() call rejects — must not null out the
    // coordinator's current (second) scanOperationId.
    rejectFirst?.(new Error('late failure'));
    await flush();
    expect(coordinator.debugState().scanOperationId).toBe(secondScanId);
  });
});

describe('SessionCoordinator: appForeground toggling and overlap with write/makeReadOnly (§12d/§12f)', () => {
  function emitAppState(
    transport: FakeTransport,
    state: 'foreground' | 'background',
  ) {
    const ev: AppStateChangedEvent = {state};
    transport.emit('appStateChanged', ev);
  }

  test('scan active -> app backgrounds -> shouldScan false, scanSubscribers unchanged, no error surfaced', async () => {
    const transport = new FakeTransport();
    const coordinator = new SessionCoordinator(transport);
    const readerA = makeReaderCallbacks();
    coordinator.addScanSubscriber('A', readerA);
    await flush();
    const scanId = transport.beginScanCalls[0];

    emitAppState(transport, 'background');
    await flush();

    expect(coordinator.debugState().appForeground).toBe(false);
    expect(coordinator.debugState().shouldScan).toBe(false);
    expect(coordinator.debugState().scanOperationId).toBeNull();
    expect(transport.cancelCalls).toContain(scanId);
    expect(readerA.errors).toHaveLength(0);
    expect(coordinator.isScanning('A')).toBe(true); // still subscribed
  });

  test('app foregrounds again with subscribers remaining -> scan restarts with a new operationId', async () => {
    const transport = new FakeTransport();
    const coordinator = new SessionCoordinator(transport);
    const readerA = makeReaderCallbacks();
    coordinator.addScanSubscriber('A', readerA);
    await flush();
    const scanId = transport.beginScanCalls[0];

    emitAppState(transport, 'background');
    await flush();
    emitAppState(transport, 'foreground');
    await flush();

    expect(coordinator.debugState().shouldScan).toBe(true);
    const newScanId =
      transport.beginScanCalls[transport.beginScanCalls.length - 1];
    expect(newScanId).not.toBe(scanId);
  });

  test('redundant appStateChanged events (same state twice) are no-ops', async () => {
    const transport = new FakeTransport();
    const coordinator = new SessionCoordinator(transport);
    const readerA = makeReaderCallbacks();
    coordinator.addScanSubscriber('A', readerA);
    await flush();
    const callsBefore = transport.beginScanCalls.length;
    emitAppState(transport, 'foreground'); // already foreground
    await flush();
    expect(transport.beginScanCalls.length).toBe(callsBefore);
  });

  test('scan aborted (subscriber removed) while backgrounded: shouldScan stays false regardless of appForeground, no resume on foreground', async () => {
    const transport = new FakeTransport();
    const coordinator = new SessionCoordinator(transport);
    const readerA = makeReaderCallbacks();
    coordinator.addScanSubscriber('A', readerA);
    await flush();
    emitAppState(transport, 'background');
    await flush();
    coordinator.removeScanSubscriber('A');
    await flush();
    emitAppState(transport, 'foreground');
    await flush();
    expect(coordinator.debugState().shouldScan).toBe(false);
    expect(coordinator.debugState().scanOperationId).toBeNull();
  });

  test('backgrounding while a write is in flight: shouldScan requires BOTH activeOperation null AND foreground', async () => {
    const transport = new FakeTransport();
    const coordinator = new SessionCoordinator(transport);
    const readerA = makeReaderCallbacks();
    coordinator.addScanSubscriber('A', readerA);
    await flush();

    let resolveWrite: (() => void) | undefined;
    const writePromise = coordinator.beginExclusiveOperation(
      'write',
      async () => {
        await new Promise<void>(resolve => {
          resolveWrite = resolve;
        });
      },
    );
    await flush();
    expect(coordinator.debugState().shouldScan).toBe(false); // write active

    emitAppState(transport, 'background');
    await flush();
    expect(coordinator.debugState().shouldScan).toBe(false); // both false now

    emitAppState(transport, 'foreground');
    await flush();
    expect(coordinator.debugState().shouldScan).toBe(false); // write still active

    resolveWrite?.();
    await writePromise;
    await flush();
    expect(coordinator.debugState().shouldScan).toBe(true); // both clear now
  });

  test('foregrounding while a write started during backgrounding: shouldScan does not depend on ordering', async () => {
    const transport = new FakeTransport();
    const coordinator = new SessionCoordinator(transport);
    const readerA = makeReaderCallbacks();
    coordinator.addScanSubscriber('A', readerA);
    await flush();

    emitAppState(transport, 'background');
    await flush();

    let resolveWrite: (() => void) | undefined;
    const writePromise = coordinator.beginExclusiveOperation(
      'write',
      async () => {
        await new Promise<void>(resolve => {
          resolveWrite = resolve;
        });
      },
    );
    await flush();
    expect(coordinator.debugState().shouldScan).toBe(false);

    emitAppState(transport, 'foreground');
    await flush();
    expect(coordinator.debugState().shouldScan).toBe(false); // write still in flight

    resolveWrite?.();
    await writePromise;
    await flush();
    expect(coordinator.debugState().shouldScan).toBe(true);
  });

  test('debugging invariant: scanOperationId !== null iff shouldScan, after settling (§5a)', async () => {
    const transport = new FakeTransport();
    const coordinator = new SessionCoordinator(transport);
    const readerA = makeReaderCallbacks();
    coordinator.addScanSubscriber('A', readerA);
    await flush();
    const state = coordinator.debugState();
    expect(state.shouldScan).toBe(state.scanOperationId !== null);
  });
});

describe('SessionCoordinator: launch-tag delivery (§12c/§12e/§12f)', () => {
  function activation(
    id: string,
    records: NdefWireRecord[] = [wireRecord()],
  ): LaunchTagActivation {
    return {activationId: id, serialNumber: `sn-${id}`, records};
  }

  test('cold launch with a queued activation, then scan(): delivered as one reading event, consumed exactly once', async () => {
    const transport = new FakeTransport();
    transport.pendingLaunchTags.push(activation('act-1'));
    const coordinator = new SessionCoordinator(transport);
    await coordinator.start();

    const readerA = makeReaderCallbacks();
    coordinator.addScanSubscriber('A', readerA);
    await flush();

    expect(readerA.readings).toHaveLength(1);
    expect(readerA.readings[0].serialNumber).toBe('sn-act-1');
  });

  test('normal launch (no tag): consumePendingLaunchTag resolves null; no synthetic reading event', async () => {
    const transport = new FakeTransport();
    const coordinator = new SessionCoordinator(transport);
    await coordinator.start();
    const readerA = makeReaderCallbacks();
    coordinator.addScanSubscriber('A', readerA);
    await flush();
    expect(readerA.readings).toHaveLength(0);
  });

  test('warm resume: a second, independent activation delivered via launchTagReceived while a reader is already scanning', async () => {
    const transport = new FakeTransport();
    const coordinator = new SessionCoordinator(transport);
    await coordinator.start();
    const readerA = makeReaderCallbacks();
    coordinator.addScanSubscriber('A', readerA);
    await flush();

    transport.pendingLaunchTags.push(activation('act-2'));
    transport.emit('launchTagReceived', {activationId: 'act-2'});
    await flush();

    expect(readerA.readings).toHaveLength(1);
    expect(readerA.readings[0].serialNumber).toBe('sn-act-2');
  });

  test('an already-consumed activation is not delivered again; a different, later activation is unaffected', async () => {
    const transport = new FakeTransport();
    transport.pendingLaunchTags.push(activation('act-3'));
    const coordinator = new SessionCoordinator(transport);
    await coordinator.start();

    const readerA = makeReaderCallbacks();
    coordinator.addScanSubscriber('A', readerA);
    await flush();
    expect(readerA.readings).toHaveLength(1);

    // Simulate a duplicate delivery notification for the SAME activation id
    // (native re-emits, or a duplicate drain call) — must not re-fire.
    transport.pendingLaunchTags.push(activation('act-3'));
    transport.emit('launchTagReceived', {activationId: 'act-3'});
    await flush();
    expect(readerA.readings).toHaveLength(1); // unchanged

    // A later, genuinely different activation is unaffected.
    transport.pendingLaunchTags.push(activation('act-4'));
    transport.emit('launchTagReceived', {activationId: 'act-4'});
    await flush();
    expect(readerA.readings).toHaveLength(2);
    expect(readerA.readings[1].serialNumber).toBe('sn-act-4');
  });

  test('consumedActivationIds is bounded: the oldest id is evicted past the cap, allowing (implausible) re-delivery', async () => {
    const transport = new FakeTransport();
    const coordinator = new SessionCoordinator(transport);
    await coordinator.start();
    const readerA = makeReaderCallbacks();
    coordinator.addScanSubscriber('A', readerA);
    await flush();

    // Push 65 distinct activations (cap is 64) — the very first id should
    // eventually be evicted from the dedup set.
    for (let i = 0; i < 65; i++) {
      transport.pendingLaunchTags.push(activation(`bulk-${i}`));
      transport.emit('launchTagReceived', {activationId: `bulk-${i}`});
      await flush();
    }
    expect(readerA.readings).toHaveLength(65);

    // Re-deliver the very first activationId — since it was evicted from the
    // bounded dedup set, the coordinator (correctly, per the plan's stated
    // bound) treats it as new and delivers it again.
    transport.pendingLaunchTags.push(activation('bulk-0'));
    transport.emit('launchTagReceived', {activationId: 'bulk-0'});
    await flush();
    expect(readerA.readings).toHaveLength(66);
  });

  test('deduplication holds under concurrent/duplicate drain calls (dedicated case, §12c)', async () => {
    const transport = new FakeTransport();
    transport.pendingLaunchTags.push(activation('dup-1'));
    const coordinator = new SessionCoordinator(transport);
    const readerA = makeReaderCallbacks();
    coordinator.addScanSubscriber('A', readerA);

    // Fire two concurrent drains (mirrors startup + a rapid launchTagReceived
    // arriving at nearly the same time).
    await Promise.all([
      coordinator.drainLaunchTags(),
      coordinator.drainLaunchTags(),
    ]);
    await flush();

    expect(readerA.readings).toHaveLength(1);
  });

  test('activation held when no scanSubscribers exist yet, delivered to the next reader that scans', async () => {
    const transport = new FakeTransport();
    transport.pendingLaunchTags.push(activation('held-1'));
    const coordinator = new SessionCoordinator(transport);
    await coordinator.start();
    await flush();

    const readerA = makeReaderCallbacks();
    coordinator.addScanSubscriber('A', readerA);
    await flush();
    expect(readerA.readings).toHaveLength(1);
  });

  test('an activation with no serialNumber delivers with an empty-string serialNumber', async () => {
    const transport = new FakeTransport();
    transport.pendingLaunchTags.push({
      activationId: 'no-sn',
      records: [wireRecord()],
    });
    const coordinator = new SessionCoordinator(transport);
    await coordinator.start();
    const readerA = makeReaderCallbacks();
    coordinator.addScanSubscriber('A', readerA);
    await flush();
    expect(readerA.readings[0].serialNumber).toBe('');
  });

  test('active scan + foreground tag tap is unrelated to the launch-activation queue', async () => {
    const transport = new FakeTransport();
    const coordinator = new SessionCoordinator(transport);
    await coordinator.start();
    const readerA = makeReaderCallbacks();
    coordinator.addScanSubscriber('A', readerA);
    await flush();
    const scanId = transport.beginScanCalls[0];
    transport.emit('tagDiscovered', {
      operationId: scanId,
      serialNumber: 'live-tap',
      records: [wireRecord()],
    });
    expect(readerA.readings).toHaveLength(1);
    expect(readerA.readings[0].serialNumber).toBe('live-tap');
  });
});

describe('SessionCoordinator: dispose', () => {
  test('dispose() removes all transport subscriptions', () => {
    const transport = new FakeTransport();
    const coordinator = new SessionCoordinator(transport);
    coordinator.dispose();
    // After dispose, emitting should not throw and listeners are gone.
    expect(() =>
      transport.emit('appStateChanged', {state: 'background'}),
    ).not.toThrow();
  });

  test('start() is idempotent (second call is a no-op)', async () => {
    const transport = new FakeTransport();
    const coordinator = new SessionCoordinator(transport);
    await coordinator.start();
    await coordinator.start();
    expect(transport.pendingLaunchTags).toHaveLength(0);
  });
});

describe('SessionCoordinator: cancelOperationExternally', () => {
  test('cancels the current exclusive operation via AbortError', async () => {
    const transport = new FakeTransport();
    const coordinator = new SessionCoordinator(transport);
    let capturedOpId = '';
    const promise = coordinator.beginExclusiveOperation('write', async opId => {
      capturedOpId = opId;
      await new Promise<void>(() => {});
    });
    await flush();
    coordinator.cancelOperationExternally(capturedOpId);
    await expect(promise).rejects.toMatchObject({name: 'AbortError'});
  });

  test('cancelling an operationId that is not the current exclusive operation is a no-op', () => {
    const transport = new FakeTransport();
    const coordinator = new SessionCoordinator(transport);
    expect(() =>
      coordinator.cancelOperationExternally('not-active'),
    ).not.toThrow();
  });
});

describe('newReaderId', () => {
  test('generates distinct ids on successive calls', () => {
    const a = newReaderId();
    const b = newReaderId();
    expect(a).not.toBe(b);
  });
});

describe('SessionCoordinator: hardware disabled/unsupported surfaces via reconcile (integration-ish)', () => {
  test('stateChanged event does not throw (reserved no-op placeholder)', () => {
    const transport = new FakeTransport();
    new SessionCoordinator(transport);
    expect(() =>
      transport.emit('stateChanged', {enabled: false}),
    ).not.toThrow();
  });
});
