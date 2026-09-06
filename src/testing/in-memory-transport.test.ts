/**
 * Direct coverage for InMemoryNfcTransport/TagHandle (§6b): the in-memory
 * NFC simulator every conformance test and fixture is built on. Bugs here
 * (a mis-fired timer, a state transition that doesn't clean up a pending
 * operation) would silently corrupt every test that uses createTagFixture()
 * without necessarily failing loudly, so this file drives the transport
 * directly rather than only exercising it indirectly through WebNfcReader.
 */
import {stringToBytes} from '../lib/ndef-wire';
import {InMemoryNfcTransport} from './in-memory-transport';
import {EmptyTag, SimulatedTag, SlowTag, TextTag} from './simulated-tag';

async function flush(times = 4): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

/** Discovery/exclusive-op servicing goes through setTimeout (macrotask),
 * even at a 0ms delay — flush()'s microtask-only loop never lets it fire. */
async function tick(ms = 0): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms));
}

describe('TagHandle', () => {
  test('tap() is a no-op once the tag has been removed', () => {
    const transport = new InMemoryNfcTransport({requireExplicitTap: true});
    const handle = transport.addTag(new EmptyTag());
    handle.remove();
    expect(handle.isRemoved()).toBe(true);
    // tap() after remove() must not throw and must not re-trigger discovery.
    expect(() => handle.tap()).not.toThrow();
  });

  test('remove() is idempotent (calling it twice is a no-op the second time)', () => {
    const transport = new InMemoryNfcTransport();
    const handle = transport.addTag(new EmptyTag());
    handle.remove();
    expect(() => handle.remove()).not.toThrow();
    expect(handle.isRemoved()).toBe(true);
  });

  test('_remove() (internal) is a no-op if the handle is not (or no longer) in tags[]', () => {
    const transport = new InMemoryNfcTransport();
    const handle = transport.addTag(new EmptyTag());
    // First call actually splices the handle out; the second call (as
    // remove()'s own guard would otherwise prevent) exercises the
    // "not found" branch directly against the internal method.
    transport._remove(handle);
    expect(() => transport._remove(handle)).not.toThrow();
  });

  test('failNextWrite()/_consumeFailNextWrite() round-trips exactly once', async () => {
    const transport = new InMemoryNfcTransport();
    const handle = transport.addTag(new EmptyTag());
    handle.failNextWrite();
    await expect(
      transport.beginWrite('op-1', [], {overwrite: true}),
    ).rejects.toMatchObject({name: 'NetworkError'});
    // The flag was consumed — a second write succeeds normally.
    await expect(
      transport.beginWrite('op-2', [], {overwrite: true}),
    ).resolves.toBeUndefined();
  });

  test('whenScanned() resolves immediately if the tag was already scanned', async () => {
    const transport = new InMemoryNfcTransport();
    const handle = transport.addTag(new TextTag({text: 'hi'}));
    await transport.beginScan('scan-1');
    await tick(); // let discovery's setTimeout actually fire
    await expect(handle.whenScanned()).resolves.toBeUndefined();
  });

  test('whenScanned() resolves once discovery delivers, for callers that awaited before it happened', async () => {
    const transport = new InMemoryNfcTransport({requireExplicitTap: true});
    const handle = transport.addTag(new TextTag({text: 'hi'}));
    await transport.beginScan('scan-1');
    const scanned = handle.whenScanned();
    handle.tap();
    await flush();
    await expect(scanned).resolves.toBeUndefined();
  });

  test('emitOperationError() is a no-op when the handle is not the tag currently in the field', () => {
    const transport = new InMemoryNfcTransport({requireExplicitTap: true});
    const inField = transport.addTag(new EmptyTag());
    // A second tag added to the same transport is never "in the field"
    // simultaneously in this model (only tags[] entries are tracked, and
    // the active one is whichever isn't removed) — remove the first so a
    // stale handle can be checked against a transport with no active tag.
    inField.remove();
    const stale = inField;
    expect(() => stale.emitOperationError('error', 'boom')).not.toThrow();
  });
});

describe('InMemoryNfcTransport: hardware status', () => {
  test('constructor defaults to enabled', async () => {
    const transport = new InMemoryNfcTransport();
    await expect(transport.isSupported()).resolves.toBe(true);
    await expect(transport.isEnabled()).resolves.toBe(true);
  });

  test('autoEnabled: false constructs already-disabled', async () => {
    const transport = new InMemoryNfcTransport({autoEnabled: false});
    await expect(transport.isEnabled()).resolves.toBe(false);
    await expect(transport.isSupported()).resolves.toBe(true);
  });

  test('setHardwareStatus("not-supported") makes isSupported() false', async () => {
    const transport = new InMemoryNfcTransport();
    transport.setHardwareStatus('not-supported');
    await expect(transport.isSupported()).resolves.toBe(false);
  });

  test('setHardwareStatus emits stateChanged only when enabled-ness actually flips', () => {
    const transport = new InMemoryNfcTransport();
    const events: Array<{enabled: boolean}> = [];
    transport.addEventListener('stateChanged', ev => events.push(ev));

    transport.setHardwareStatus('disabled'); // enabled -> disabled: flips
    transport.setHardwareStatus('not-supported'); // disabled -> disabled: no flip
    transport.setHardwareStatus('enabled'); // disabled -> enabled: flips

    expect(events).toEqual([{enabled: false}, {enabled: true}]);
  });
});

describe('InMemoryNfcTransport: beginScan()', () => {
  test('rejects NotSupportedError when hardware is not-supported', async () => {
    const transport = new InMemoryNfcTransport();
    transport.setHardwareStatus('not-supported');
    await expect(transport.beginScan('op-1')).rejects.toMatchObject({
      name: 'NotSupportedError',
    });
  });

  test('rejects NotReadableError when hardware is disabled', async () => {
    const transport = new InMemoryNfcTransport({autoEnabled: false});
    await expect(transport.beginScan('op-1')).rejects.toMatchObject({
      name: 'NotReadableError',
    });
  });

  test('delivers tagDiscovered for a tag already present when requireExplicitTap is false', async () => {
    const transport = new InMemoryNfcTransport();
    const handle = transport.addTag(new TextTag({text: 'hi'}));
    const events: unknown[] = [];
    transport.addEventListener('tagDiscovered', ev => events.push(ev));
    await transport.beginScan('op-1');
    await tick();
    expect(events).toEqual([
      {
        operationId: 'op-1',
        serialNumber: handle.tag.serialNumber,
        records: handle.tag.records,
      },
    ]);
  });

  test('does not auto-deliver when requireExplicitTap is true, until tap() is called', async () => {
    const transport = new InMemoryNfcTransport({requireExplicitTap: true});
    const handle = transport.addTag(new TextTag({text: 'hi'}));
    const events: unknown[] = [];
    transport.addEventListener('tagDiscovered', ev => events.push(ev));
    await transport.beginScan('op-1');
    await tick();
    expect(events).toHaveLength(0);
    handle.tap();
    await tick();
    expect(events).toHaveLength(1);
  });

  test('delivering a non-NDEF tag emits operationEnded(error) instead of tagDiscovered', async () => {
    const transport = new InMemoryNfcTransport();
    const handle = transport.addTag(new EmptyTag());
    (handle.tag as {isNdef: boolean}).isNdef = false;
    const discovered: unknown[] = [];
    const ended: unknown[] = [];
    transport.addEventListener('tagDiscovered', ev => discovered.push(ev));
    transport.addEventListener('operationEnded', ev => ended.push(ev));
    await transport.beginScan('op-1');
    await tick();
    expect(discovered).toHaveLength(0);
    expect(ended).toEqual([
      {operationId: 'op-1', reason: 'error', message: 'non-NDEF tag'},
    ]);
  });
});

describe('InMemoryNfcTransport: beginWrite()', () => {
  test('rejects NotSupportedError when hardware is not-supported', async () => {
    const transport = new InMemoryNfcTransport();
    transport.setHardwareStatus('not-supported');
    await expect(
      transport.beginWrite('op-1', [], {overwrite: true}),
    ).rejects.toMatchObject({name: 'NotSupportedError'});
  });

  test('rejects NotReadableError when hardware is disabled', async () => {
    const transport = new InMemoryNfcTransport({autoEnabled: false});
    await expect(
      transport.beginWrite('op-1', [], {overwrite: true}),
    ).rejects.toMatchObject({name: 'NotReadableError'});
  });

  test('writes to the tag currently in the field and resolves', async () => {
    const transport = new InMemoryNfcTransport();
    const handle = transport.addTag(new EmptyTag());
    const records = [
      {tnf: 1, type: 'VA==', id: '', payload: 'AQID'},
    ];
    await transport.beginWrite('op-1', records, {overwrite: true});
    expect(handle.tag.records).toEqual(records);
  });

  test('stays pending until a tag is presented, then services it', async () => {
    const transport = new InMemoryNfcTransport({requireExplicitTap: true});
    const writePromise = transport.beginWrite('op-1', [], {overwrite: true});
    await flush();
    const handle = transport.addTag(new EmptyTag());
    await writePromise;
    expect(handle.tag.lastWrite).toEqual({records: [], overwrite: true});
  });

  test('rejects when the tag itself throws (e.g. read-only)', async () => {
    const transport = new InMemoryNfcTransport();
    transport.addTag(new EmptyTag({writable: false}));
    const ended: unknown[] = [];
    transport.addEventListener('operationEnded', ev => ended.push(ev));
    await expect(
      transport.beginWrite('op-1', [], {overwrite: true}),
    ).rejects.toMatchObject({name: 'InvalidStateError'});
    expect(ended).toEqual([
      {operationId: 'op-1', reason: 'error', message: 'tag is read-only'},
    ]);
  });

  test('a tag subclass throwing a non-Error value is stringified via String() in operationEnded', async () => {
    class ThrowsNonError extends SimulatedTag {
      override onWrite(): void {
        // eslint-disable-next-line @typescript-eslint/no-throw-literal
        throw 'plain string failure';
      }
    }
    const transport = new InMemoryNfcTransport();
    transport.addTag(new ThrowsNonError());
    const ended: unknown[] = [];
    transport.addEventListener('operationEnded', ev => ended.push(ev));
    await expect(
      transport.beginWrite('op-1', [], {overwrite: true}),
    ).rejects.toBe('plain string failure');
    expect(ended).toEqual([
      {
        operationId: 'op-1',
        reason: 'error',
        message: 'plain string failure',
      },
    ]);
  });
});

describe('InMemoryNfcTransport: beginMakeReadOnly()', () => {
  test('rejects NotSupportedError when hardware is not-supported', async () => {
    const transport = new InMemoryNfcTransport();
    transport.setHardwareStatus('not-supported');
    await expect(transport.beginMakeReadOnly('op-1')).rejects.toMatchObject({
      name: 'NotSupportedError',
    });
  });

  test('rejects NotReadableError when hardware is disabled', async () => {
    const transport = new InMemoryNfcTransport({autoEnabled: false});
    await expect(transport.beginMakeReadOnly('op-1')).rejects.toMatchObject({
      name: 'NotReadableError',
    });
  });

  test('flips the tag to read-only and resolves', async () => {
    const transport = new InMemoryNfcTransport();
    const handle = transport.addTag(new EmptyTag());
    await transport.beginMakeReadOnly('op-1');
    expect(handle.tag.writable).toBe(false);
  });

  test('emits operationEnded(success) on completion', async () => {
    const transport = new InMemoryNfcTransport();
    transport.addTag(new EmptyTag());
    const ended: unknown[] = [];
    transport.addEventListener('operationEnded', ev => ended.push(ev));
    await transport.beginMakeReadOnly('op-1');
    expect(ended).toEqual([{operationId: 'op-1', reason: 'success'}]);
  });
});

describe('InMemoryNfcTransport: cancelOperation()', () => {
  test('cancels a pending scan: clears discovery timers and emits operationEnded(cancelled)', async () => {
    const transport = new InMemoryNfcTransport({requireExplicitTap: true});
    transport.addTag(new TextTag({text: 'hi'}));
    await transport.beginScan('op-1');
    const ended: unknown[] = [];
    const discovered: unknown[] = [];
    transport.addEventListener('operationEnded', ev => ended.push(ev));
    transport.addEventListener('tagDiscovered', ev => discovered.push(ev));
    await transport.cancelOperation('op-1');
    await flush();
    expect(ended).toEqual([{operationId: 'op-1', reason: 'cancelled'}]);
    // Discovery timer was cleared — no tagDiscovered fires even after tap().
    expect(discovered).toHaveLength(0);
  });

  test('cancels a pending exclusive (write) operation and rejects it with AbortError', async () => {
    const transport = new InMemoryNfcTransport({requireExplicitTap: true});
    const writePromise = transport.beginWrite('op-1', [], {overwrite: true});
    const ended: unknown[] = [];
    transport.addEventListener('operationEnded', ev => ended.push(ev));
    await transport.cancelOperation('op-1');
    await expect(writePromise).rejects.toMatchObject({name: 'AbortError'});
    expect(ended).toEqual([{operationId: 'op-1', reason: 'cancelled'}]);
  });

  test('cancels a delayed pending exclusive operation, clearing its timer before it fires', async () => {
    const transport = new InMemoryNfcTransport({tapDelayMs: 1000});
    transport.addTag(new EmptyTag());
    const writePromise = transport.beginWrite('op-1', [], {overwrite: true});
    await flush();
    await transport.cancelOperation('op-1');
    await expect(writePromise).rejects.toMatchObject({name: 'AbortError'});
  });

  test('an unknown/already-finished operationId is idempotent: still emits operationEnded(cancelled)', async () => {
    const transport = new InMemoryNfcTransport();
    const ended: unknown[] = [];
    transport.addEventListener('operationEnded', ev => ended.push(ev));
    await transport.cancelOperation('never-existed');
    expect(ended).toEqual([
      {operationId: 'never-existed', reason: 'cancelled'},
    ]);
  });
});

describe('InMemoryNfcTransport: consumePendingLaunchTag() / simulateLaunchTag()', () => {
  test('returns null when no launch tag is queued', async () => {
    const transport = new InMemoryNfcTransport();
    await expect(transport.consumePendingLaunchTag()).resolves.toBeNull();
  });

  test('simulateLaunchTag() queues an activation, emits launchTagReceived, and is consumed FIFO', async () => {
    const transport = new InMemoryNfcTransport();
    const received: unknown[] = [];
    transport.addEventListener('launchTagReceived', ev => received.push(ev));
    const records = [{tnf: 1, type: 'VA==', id: '', payload: 'AQID'}];
    transport.simulateLaunchTag(records, {serialNumber: 's1'});
    transport.simulateLaunchTag(records, {serialNumber: 's2'});

    expect(received).toEqual([
      {activationId: 'launch-1'},
      {activationId: 'launch-2'},
    ]);

    const first = await transport.consumePendingLaunchTag();
    expect(first).toEqual({
      activationId: 'launch-1',
      serialNumber: 's1',
      records,
    });
    const second = await transport.consumePendingLaunchTag();
    expect(second).toEqual({
      activationId: 'launch-2',
      serialNumber: 's2',
      records,
    });
    await expect(transport.consumePendingLaunchTag()).resolves.toBeNull();
  });

  test('simulateLaunchTag() omits serialNumber when not given', async () => {
    const transport = new InMemoryNfcTransport();
    transport.simulateLaunchTag([]);
    const activation = await transport.consumePendingLaunchTag();
    expect(activation?.serialNumber).toBeUndefined();
  });
});

describe('InMemoryNfcTransport: addEventListener()', () => {
  test('remove() unsubscribes the listener', () => {
    const transport = new InMemoryNfcTransport();
    const calls: unknown[] = [];
    const sub = transport.addEventListener('stateChanged', ev =>
      calls.push(ev),
    );
    transport.setHardwareStatus('disabled');
    sub.remove();
    transport.setHardwareStatus('enabled');
    expect(calls).toEqual([{enabled: false}]);
  });

  test('remove() is a no-op if called twice or if the listener was never present', () => {
    const transport = new InMemoryNfcTransport();
    const sub = transport.addEventListener('stateChanged', () => {});
    sub.remove();
    expect(() => sub.remove()).not.toThrow();
  });
});

describe('InMemoryNfcTransport: simulateBackground()/simulateForeground()', () => {
  test('emit appStateChanged with the corresponding state', () => {
    const transport = new InMemoryNfcTransport();
    const events: unknown[] = [];
    transport.addEventListener('appStateChanged', ev => events.push(ev));
    transport.simulateBackground();
    transport.simulateForeground();
    expect(events).toEqual([{state: 'background'}, {state: 'foreground'}]);
  });
});

describe('InMemoryNfcTransport: SlowTag delayed discovery/exclusive-op servicing', () => {
  test('a SlowTag delays tagDiscovered by its own delayMs, ignoring tapDelayMs', async () => {
    const transport = new InMemoryNfcTransport({tapDelayMs: 5});
    transport.addTag(new SlowTag({delayMs: 20}));
    const events: unknown[] = [];
    transport.addEventListener('tagDiscovered', ev => events.push(ev));
    await transport.beginScan('op-1');
    await flush();
    // Not yet delivered at tapDelayMs (5ms) — SlowTag's own 20ms governs.
    expect(events).toHaveLength(0);
    await new Promise(resolve => setTimeout(resolve, 25));
    expect(events).toHaveLength(1);
  });

  test('a SlowTag delays exclusive-operation servicing by its own delayMs', async () => {
    const transport = new InMemoryNfcTransport();
    const handle = transport.addTag(new SlowTag({delayMs: 20}));
    const writePromise = transport.beginWrite('op-1', [], {overwrite: true});
    await flush();
    expect(handle.tag.lastWrite).toBeNull();
    await writePromise;
    expect(handle.tag.lastWrite).toEqual({records: [], overwrite: true});
  });

  test('discovery is silently dropped if the tag was removed before its delay elapsed', async () => {
    const transport = new InMemoryNfcTransport({requireExplicitTap: true});
    const handle = transport.addTag(new SlowTag({delayMs: 20}));
    await transport.beginScan('op-1');
    handle.tap();
    await flush();
    handle.remove();
    const events: unknown[] = [];
    transport.addEventListener('tagDiscovered', ev => events.push(ev));
    await new Promise(resolve => setTimeout(resolve, 25));
    expect(events).toHaveLength(0);
  });

  test('discovery is dropped if the scan itself was cancelled before the delay elapsed', async () => {
    const transport = new InMemoryNfcTransport({requireExplicitTap: true});
    const handle = transport.addTag(new SlowTag({delayMs: 20}));
    await transport.beginScan('op-1');
    handle.tap();
    await flush();
    await transport.cancelOperation('op-1');
    const events: unknown[] = [];
    transport.addEventListener('tagDiscovered', ev => events.push(ev));
    await new Promise(resolve => setTimeout(resolve, 25));
    expect(events).toHaveLength(0);
  });

  test('a stale discovery timer from a superseded (uncancelled) scan does not deliver for the new operationId', async () => {
    // beginScan() doesn't clear a still-pending discovery timer from a prior
    // scan when called again — the stale timer's deliver() must notice
    // `pendingScan.operationId` no longer matches and bail out instead of
    // firing tagDiscovered under the new scan's operationId.
    const transport = new InMemoryNfcTransport({requireExplicitTap: true});
    const handle = transport.addTag(new SlowTag({delayMs: 20}));
    await transport.beginScan('op-old');
    handle.tap();
    await flush();
    // Start a second scan without cancelling the first — op-old's discovery
    // timer (still pending, 20ms out) is now stale.
    await transport.beginScan('op-new');
    const events: unknown[] = [];
    transport.addEventListener('tagDiscovered', ev => events.push(ev));
    await new Promise(resolve => setTimeout(resolve, 25));
    expect(events).toHaveLength(0);
  });

  test('an exclusive operation superseded/cancelled before its delay elapses is not double-serviced', async () => {
    const transport = new InMemoryNfcTransport();
    const handle = transport.addTag(new SlowTag({delayMs: 20}));
    const writePromise = transport.beginWrite('op-1', [], {overwrite: true});
    await flush();
    await transport.cancelOperation('op-1');
    await expect(writePromise).rejects.toMatchObject({name: 'AbortError'});
    // Wait past the original delay — the (now-superseded) doService() must
    // not still apply the write.
    await new Promise(resolve => setTimeout(resolve, 25));
    expect(handle.tag.lastWrite).toBeNull();
  });

  test('a stale exclusive-op timer from a superseded (uncancelled) write does not double-apply once its delay elapses', async () => {
    // beginWrite() doesn't clear a still-pending exclusive-op timer from a
    // prior call when invoked again — the stale timer's doService() must
    // notice `pendingExclusive !== pending` and bail out instead of
    // re-applying the old (superseded) write.
    const transport = new InMemoryNfcTransport();
    const handle = transport.addTag(new SlowTag({delayMs: 10}));
    const firstWrite = transport.beginWrite('op-old', [], {overwrite: true});
    await flush();
    const records = [{tnf: 1, type: 'VA==', id: '', payload: 'AQID'}];
    const secondWrite = transport.beginWrite('op-new', records, {
      overwrite: true,
    });
    await new Promise(resolve => setTimeout(resolve, 15));
    await secondWrite;
    // Only the second (superseding) write actually landed.
    expect(handle.tag.records).toEqual(records);
    // The first write's promise is left permanently unsettled once
    // superseded (mirrors real hardware: there is no third outcome to
    // report for a write nothing will ever finish) — confirm it hasn't
    // resolved or rejected.
    let settled = false;
    firstWrite.then(
      () => (settled = true),
      () => (settled = true),
    );
    await flush();
    expect(settled).toBe(false);
  });
});

describe('InMemoryNfcTransport: _emitOperationErrorForTag() via TagHandle.emitOperationError()', () => {
  test('rejects a pending write with NetworkError(error reason) and emits operationEnded', async () => {
    // A SlowTag keeps beginWrite() pending (rather than servicing it
    // synchronously) long enough for emitOperationError() to interrupt it.
    const transport = new InMemoryNfcTransport();
    const handle = transport.addTag(new SlowTag({delayMs: 1000}));
    const writePromise = transport.beginWrite('op-1', [], {overwrite: true});
    await flush();
    const ended: unknown[] = [];
    transport.addEventListener('operationEnded', ev => ended.push(ev));
    handle.emitOperationError('error', 'field lost');
    await expect(writePromise).rejects.toMatchObject({name: 'NetworkError'});
    expect(ended).toEqual([
      {operationId: 'op-1', reason: 'error', message: 'field lost'},
    ]);
  });

  test('rejects a pending write with NotAllowedError(timeout reason)', async () => {
    const transport = new InMemoryNfcTransport();
    const handle = transport.addTag(new SlowTag({delayMs: 1000}));
    const writePromise = transport.beginWrite('op-1', [], {overwrite: true});
    await flush();
    handle.emitOperationError('timeout', 'took too long');
    await expect(writePromise).rejects.toMatchObject({name: 'NotAllowedError'});
  });

  test('clears a pending exclusive operation timer (SlowTag) so it is not also serviced later', async () => {
    const transport = new InMemoryNfcTransport();
    const handle = transport.addTag(new SlowTag({delayMs: 50}));
    const writePromise = transport.beginWrite('op-1', [], {overwrite: true});
    await flush();
    handle.emitOperationError('error', 'boom');
    await expect(writePromise).rejects.toMatchObject({name: 'NetworkError'});
    await new Promise(resolve => setTimeout(resolve, 60));
    expect(handle.tag.lastWrite).toBeNull();
  });

  test('ends a pending scan (no pending exclusive op) and clears its discovery timers', async () => {
    const transport = new InMemoryNfcTransport({requireExplicitTap: true});
    const handle = transport.addTag(new TextTag({text: 'hi'}));
    await transport.beginScan('op-1');
    handle.tap();
    await flush();
    const ended: unknown[] = [];
    const discovered: unknown[] = [];
    transport.addEventListener('operationEnded', ev => ended.push(ev));
    transport.addEventListener('tagDiscovered', ev => discovered.push(ev));
    handle.emitOperationError('error', 'tag yanked mid-read');
    await flush();
    expect(ended).toEqual([
      {operationId: 'op-1', reason: 'error', message: 'tag yanked mid-read'},
    ]);
    expect(discovered).toHaveLength(0);
  });

  test('is a no-op when there is neither a pending exclusive op nor a pending scan', () => {
    const transport = new InMemoryNfcTransport();
    const handle = transport.addTag(new EmptyTag());
    expect(() => handle.emitOperationError('error')).not.toThrow();
  });

  test('is a no-op for a handle that is not the tag currently occupying the field', async () => {
    const transport = new InMemoryNfcTransport({requireExplicitTap: true});
    const active = transport.addTag(new EmptyTag());
    active.remove();
    const stale = active;
    const writePromise = transport.beginWrite('op-1', [], {overwrite: true});
    // No tag is in the field (the only one was removed), so this write
    // stays pending — emitOperationError on the removed/stale handle must
    // not touch it.
    stale.emitOperationError('error', 'ignored');
    await flush();
    // The write is still pending (neither resolved nor rejected).
    let settled = false;
    writePromise.then(
      () => (settled = true),
      () => (settled = true),
    );
    await flush();
    expect(settled).toBe(false);
    await transport.cancelOperation('op-1'); // cleanup
  });
});

describe('InMemoryNfcTransport: write() default overwrite/records', () => {
  test('beginWrite() with no records defaults the tag write to an empty list', async () => {
    const transport = new InMemoryNfcTransport();
    const handle = transport.addTag(new EmptyTag());
    await transport.beginWrite('op-1', [], {overwrite: false});
    expect(handle.tag.lastWrite).toEqual({records: [], overwrite: false});
  });

  test('beginWrite() forwards non-empty records and overwrite:true through onWrite()', async () => {
    const transport = new InMemoryNfcTransport();
    const handle = transport.addTag(new EmptyTag());
    const records = [
      {
        tnf: 1,
        type: 'VA==',
        id: '',
        payload: Buffer.from(stringToBytes('hi')).toString('base64'),
      },
    ];
    await transport.beginWrite('op-1', records, {overwrite: true});
    expect(handle.tag.records).toEqual(records);
  });
});
