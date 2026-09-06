/**
 * InMemoryNfcTransport implements NfcTransport (§6b): holds zero-or-one "tag
 * in field" at a time, exercising the same NdefWireRecord codec path a real
 * device would. Also implements the lifecycle simulation hooks (§12e):
 * simulateLaunchTag, simulateBackground/simulateForeground.
 */
import {createDOMException} from '../lib/dom-exception';
import type {NdefWireRecord} from '../lib/ndef-wire';
import type {
  LaunchTagActivation,
  NfcTransport,
  NfcTransportEventMap,
  NfcTransportEventType,
  Subscription,
} from '../transport';
import {type SimulatedTag, SlowTag} from './simulated-tag';

export type HardwareStatus = 'enabled' | 'disabled' | 'not-supported';

export interface InMemoryNfcTransportOptions {
  tapDelayMs?: number;
  autoEnabled?: boolean;
  requireExplicitTap?: boolean;
}

/** Handle returned by addTag() for fault injection and lifecycle control (§6b). */
export class TagHandle {
  private readonly transport: InMemoryNfcTransport;
  readonly tag: SimulatedTag;
  private removed = false;
  private failNextWriteFlag = false;

  constructor(transport: InMemoryNfcTransport, tag: SimulatedTag) {
    this.transport = transport;
    this.tag = tag;
  }

  /** Explicitly triggers tagDiscovered (only meaningful when requireExplicitTap is set). */
  tap(): void {
    if (this.removed) return;
    this.transport._tap(this);
  }

  /** Simulates the tag leaving the field. */
  remove(): void {
    if (this.removed) return;
    this.removed = true;
    this.transport._remove(this);
  }

  /** The next write against this tag rejects with NetworkError (WPT simulateDataTransferFails, §5f). */
  failNextWrite(): void {
    this.failNextWriteFlag = true;
  }

  /** @internal */
  _consumeFailNextWrite(): boolean {
    if (this.failNextWriteFlag) {
      this.failNextWriteFlag = false;
      return true;
    }
    return false;
  }

  /** Emits operationEnded{reason} for whichever operation is currently servicing this tag. */
  emitOperationError(reason: 'error' | 'timeout', message?: string): void {
    this.transport._emitOperationErrorForTag(this, reason, message);
  }

  isRemoved(): boolean {
    return this.removed;
  }

  /** Resolves once this tag has been scanned/discovered at least once. */
  whenScanned(): Promise<void> {
    return this.transport._whenScanned(this);
  }
}

interface PendingScan {
  operationId: string;
}

interface PendingExclusive {
  kind: 'write' | 'makeReadOnly';
  operationId: string;
  records?: NdefWireRecord[];
  overwrite?: boolean;
  resolve: () => void;
  reject: (err: unknown) => void;
}

export class InMemoryNfcTransport implements NfcTransport {
  private hardwareStatus: HardwareStatus;
  private readonly tapDelayMs: number;
  private readonly requireExplicitTap: boolean;

  private tags: TagHandle[] = [];
  private pendingScan: PendingScan | null = null;
  private pendingExclusive: PendingExclusive | null = null;
  private readonly scannedResolvers = new Map<TagHandle, Array<() => void>>();
  private readonly scannedTags = new Set<TagHandle>();
  private pendingExclusiveTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly discoveryTimers = new Set<ReturnType<typeof setTimeout>>();

  private readonly listeners: {
    [K in NfcTransportEventType]: Array<(ev: NfcTransportEventMap[K]) => void>;
  } = {
    tagDiscovered: [],
    operationEnded: [],
    stateChanged: [],
    appStateChanged: [],
    launchTagReceived: [],
  };

  private readonly launchTagQueue: LaunchTagActivation[] = [];
  private nextActivationSeq = 0;

  constructor(options: InMemoryNfcTransportOptions = {}) {
    this.hardwareStatus =
      options.autoEnabled === false ? 'disabled' : 'enabled';
    this.tapDelayMs = options.tapDelayMs ?? 0;
    this.requireExplicitTap = options.requireExplicitTap ?? false;
  }

  // --- tag management --------------------------------------------------------

  addTag(tag: SimulatedTag): TagHandle {
    const handle = new TagHandle(this, tag);
    this.tags.push(handle);
    if (!this.requireExplicitTap) {
      this._tap(handle);
    }
    // requireExplicitTap only gates scan-side discovery (tap() is the
    // explicit trigger for tagDiscovered) — a pending write/makeReadOnly
    // should still be serviced as soon as a tag is physically present,
    // exactly as it would be on real hardware presenting a tag mid-write.
    this.tryServiceExclusive();
    return handle;
  }

  setHardwareStatus(status: HardwareStatus): void {
    const wasEnabled = this.hardwareStatus === 'enabled';
    this.hardwareStatus = status;
    const isEnabled = status === 'enabled';
    if (wasEnabled !== isEnabled) {
      this.emit('stateChanged', {enabled: isEnabled});
    }
  }

  // --- NfcTransport ------------------------------------------------------------

  async isSupported(): Promise<boolean> {
    return this.hardwareStatus !== 'not-supported';
  }

  async isEnabled(): Promise<boolean> {
    return this.hardwareStatus === 'enabled';
  }

  async beginScan(operationId: string): Promise<void> {
    if (this.hardwareStatus === 'not-supported') {
      throw createDOMException(
        'NotSupportedError',
        'no NFC hardware in this simulated environment',
      );
    }
    if (this.hardwareStatus === 'disabled') {
      throw createDOMException('NotReadableError', 'NFC is disabled');
    }
    this.pendingScan = {operationId};
    // If a tag is already present and not requiring explicit tap, deliver
    // immediately (after any configured delay) as a real device would for a
    // tag already in the field when scanning starts.
    const presentTag = this.tags.find(h => !h.isRemoved());
    if (presentTag && !this.requireExplicitTap) {
      this.scheduleDiscovery(presentTag, operationId);
    }
  }

  async beginWrite(
    operationId: string,
    records: NdefWireRecord[],
    opts: {overwrite: boolean},
  ): Promise<void> {
    if (this.hardwareStatus === 'not-supported') {
      throw createDOMException(
        'NotSupportedError',
        'no NFC hardware in this simulated environment',
      );
    }
    if (this.hardwareStatus === 'disabled') {
      throw createDOMException('NotReadableError', 'NFC is disabled');
    }
    return new Promise<void>((resolve, reject) => {
      this.pendingExclusive = {
        kind: 'write',
        operationId,
        records,
        overwrite: opts.overwrite,
        resolve,
        reject,
      };
      this.tryServiceExclusive();
    });
  }

  async beginMakeReadOnly(operationId: string): Promise<void> {
    if (this.hardwareStatus === 'not-supported') {
      throw createDOMException(
        'NotSupportedError',
        'no NFC hardware in this simulated environment',
      );
    }
    if (this.hardwareStatus === 'disabled') {
      throw createDOMException('NotReadableError', 'NFC is disabled');
    }
    return new Promise<void>((resolve, reject) => {
      this.pendingExclusive = {
        kind: 'makeReadOnly',
        operationId,
        resolve,
        reject,
      };
      this.tryServiceExclusive();
    });
  }

  async cancelOperation(operationId: string): Promise<void> {
    if (this.pendingScan?.operationId === operationId) {
      this.pendingScan = null;
      for (const timer of this.discoveryTimers) clearTimeout(timer);
      this.discoveryTimers.clear();
      this.emit('operationEnded', {operationId, reason: 'cancelled'});
      return;
    }
    if (this.pendingExclusive?.operationId === operationId) {
      const pending = this.pendingExclusive;
      this.pendingExclusive = null;
      if (this.pendingExclusiveTimer !== null) {
        clearTimeout(this.pendingExclusiveTimer);
        this.pendingExclusiveTimer = null;
      }
      pending.reject(createDOMException('AbortError', 'operation cancelled'));
      this.emit('operationEnded', {operationId, reason: 'cancelled'});
      return;
    }
    // Unknown/already-finished operationId: cancelOperation is idempotent (§3).
    this.emit('operationEnded', {operationId, reason: 'cancelled'});
  }

  async consumePendingLaunchTag(): Promise<LaunchTagActivation | null> {
    return this.launchTagQueue.shift() ?? null;
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

  // --- lifecycle simulation (§12e) --------------------------------------------

  simulateLaunchTag(
    records: NdefWireRecord[],
    opts: {serialNumber?: string} = {},
  ): void {
    this.nextActivationSeq += 1;
    const activation: LaunchTagActivation = {
      activationId: `launch-${this.nextActivationSeq}`,
      serialNumber: opts.serialNumber,
      records,
    };
    this.launchTagQueue.push(activation);
    this.emit('launchTagReceived', {activationId: activation.activationId});
  }

  simulateBackground(): void {
    this.emit('appStateChanged', {state: 'background'});
  }

  simulateForeground(): void {
    this.emit('appStateChanged', {state: 'foreground'});
  }

  // --- internals used by TagHandle ---------------------------------------------

  /** @internal */
  _tap(handle: TagHandle): void {
    if (!this.pendingScan) return;
    this.scheduleDiscovery(handle, this.pendingScan.operationId);
    this.tryServiceExclusive();
  }

  /** @internal */
  _remove(handle: TagHandle): void {
    const idx = this.tags.indexOf(handle);
    if (idx >= 0) this.tags.splice(idx, 1);
  }

  /**
   * Emits operationEnded{reason} for whichever operation is currently
   * servicing `handle`'s tag — a no-op if `handle` isn't the tag actually
   * occupying the field right now, since there is nothing for it to fail.
   * @internal
   */
  _emitOperationErrorForTag(
    handle: TagHandle,
    reason: 'error' | 'timeout',
    message?: string,
  ): void {
    const activeHandle = this.tags.find(h => !h.isRemoved());
    if (activeHandle !== handle) return;

    if (this.pendingExclusive) {
      const pending = this.pendingExclusive;
      this.pendingExclusive = null;
      // Unlike cancelOperation(), a pendingExclusive reachable here always
      // has an active handle (activeHandle === handle, checked above) —
      // tryServiceExclusive() runs synchronously whenever a handle exists,
      // so a delay:0 op is serviced (and pendingExclusiveTimer never set)
      // before this method could ever observe it still pending; only the
      // delayed (SlowTag/tapDelayMs) case reaches here, always with a live
      // timer to clear.
      clearTimeout(this.pendingExclusiveTimer!);
      this.pendingExclusiveTimer = null;
      pending.reject(
        createDOMException(
          reason === 'timeout' ? 'NotAllowedError' : 'NetworkError',
          message,
        ),
      );
      this.emit('operationEnded', {
        operationId: pending.operationId,
        reason,
        message,
      });
      return;
    }
    if (this.pendingScan) {
      const operationId = this.pendingScan.operationId;
      this.pendingScan = null;
      for (const timer of this.discoveryTimers) clearTimeout(timer);
      this.discoveryTimers.clear();
      this.emit('operationEnded', {operationId, reason, message});
    }
  }

  /** @internal */
  _whenScanned(handle: TagHandle): Promise<void> {
    if (this.scannedTags.has(handle)) return Promise.resolve();
    return new Promise<void>(resolve => {
      const arr = this.scannedResolvers.get(handle) ?? [];
      arr.push(resolve);
      this.scannedResolvers.set(handle, arr);
    });
  }

  private scheduleDiscovery(handle: TagHandle, operationId: string): void {
    const deliver = () => {
      this.discoveryTimers.delete(timer);
      if (!this.pendingScan || this.pendingScan.operationId !== operationId)
        return;
      if (handle.isRemoved()) return;
      this.scannedTags.add(handle);
      const resolvers = this.scannedResolvers.get(handle);
      if (resolvers) {
        for (const resolve of resolvers) resolve();
        this.scannedResolvers.delete(handle);
      }
      if (!handle.tag.isNdef) {
        this.emit('operationEnded', {
          operationId,
          reason: 'error',
          message: 'non-NDEF tag',
        });
        return;
      }
      this.emit('tagDiscovered', {
        operationId,
        serialNumber: handle.tag.serialNumber,
        records: handle.tag.records,
      });
    };
    // Always deliver asynchronously (a macrotask at minimum), even with no
    // configured delay: real hardware discovery is never synchronous with
    // beginScan()'s own resolution, and callers (including NfcClient,
    // testing/client.ts) legitimately attach their 'reading' listener only
    // after `await transport.beginScan(...)` / `await reader.scan()`
    // resolves — a synchronous delivery would fire before such a listener
    // is ever attached.
    const delay =
      handle.tag instanceof SlowTag ? handle.tag.delayMs : this.tapDelayMs;
    const timer = setTimeout(deliver, delay);
    this.discoveryTimers.add(timer);
  }

  private tryServiceExclusive(): void {
    if (!this.pendingExclusive) return;
    const handle = this.tags.find(h => !h.isRemoved());
    if (!handle) return; // wait for a tag to be presented

    const pending = this.pendingExclusive;
    const doService = () => {
      this.pendingExclusiveTimer = null;
      if (this.pendingExclusive !== pending) return; // superseded/cancelled meanwhile
      this.pendingExclusive = null;
      try {
        if (handle._consumeFailNextWrite()) {
          throw createDOMException(
            'NetworkError',
            'simulated data transfer failure',
          );
        }
        if (pending.kind === 'write') {
          // records/overwrite are always set on a 'write'-kind pending op —
          // beginWrite() below is the only place that constructs one, and
          // it always supplies both — so these are never actually undefined
          // here; the `!` just satisfies the shared PendingExclusive type,
          // which leaves both optional to accommodate the 'makeReadOnly'
          // variant that never sets (or reads) them.
          handle.tag.onWrite(pending.records!, pending.overwrite!);
        } else {
          handle.tag.onMakeReadOnly();
        }
        pending.resolve();
        this.emit('operationEnded', {
          operationId: pending.operationId,
          reason: 'success',
        });
      } catch (err) {
        pending.reject(err);
        this.emit('operationEnded', {
          operationId: pending.operationId,
          reason: 'error',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    };
    const delay =
      handle.tag instanceof SlowTag ? handle.tag.delayMs : this.tapDelayMs;
    if (delay > 0) {
      this.pendingExclusiveTimer = setTimeout(doService, delay);
    } else {
      doService();
    }
  }

  private emit<T extends NfcTransportEventType>(
    type: T,
    ev: NfcTransportEventMap[T],
  ): void {
    for (const cb of [...this.listeners[type]]) cb(ev);
  }
}
