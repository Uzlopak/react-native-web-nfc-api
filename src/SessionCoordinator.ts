/**
 * SessionCoordinator (§5a): multiplexes NDEFReader instances onto the one
 * physical native operation. Pure JS, no react-native imports, tested
 * against any NfcTransport (fake or InMemoryNfcTransport).
 *
 * Owns:
 *  - scanSubscribers: readers with an active scan()
 *  - scanOperationId: the native operationId of the current scan, if any
 *  - activeOperation: the current write/makeReadOnly, if any
 *  - appForeground: whether the app currently holds the foreground (§12d)
 *  - internallyCancelledScans: scanOperationIds cancelled by the coordinator
 *    itself, awaiting their operationEnded (swallowed, never surfaced)
 *
 * shouldScan is *derived*, not tracked, precisely because it depends on two
 * independent conditions (an exclusive operation, and app foreground state)
 * that can each flip independently and even overlap (§5a, §12d).
 */
import {createDOMException, DOMException} from './lib/dom-exception';
import type {NdefWireRecord} from './lib/ndef-wire';
import type {
  AppStateChangedEvent,
  LaunchTagActivation,
  NfcTransport,
  OperationEndedEvent,
  StateChangedEvent,
  Subscription,
  TagDiscoveredEvent,
} from './transport';

export type ReaderId = string;

let nextOperationSeq = 0;
function newOperationId(): string {
  nextOperationSeq += 1;
  return `op-${nextOperationSeq}-${Date.now().toString(36)}`;
}

let nextReaderSeq = 0;
export function newReaderId(): ReaderId {
  nextReaderSeq += 1;
  return `reader-${nextReaderSeq}`;
}

export interface ReadingDelivery {
  operationId: string;
  serialNumber: string;
  records: NdefWireRecord[];
}

/** Callbacks a reader registers with the coordinator for its subscription lifetime. */
export interface ReaderCallbacks {
  onReading: (delivery: ReadingDelivery) => void;
  /** A scan-level error not tied to a specific tag (e.g. hardware disabled mid-scan). */
  onScanError: (error: DOMException) => void;
}

interface ActiveOperation {
  kind: 'write' | 'makeReadOnly';
  operationId: string;
  abort: (reason: unknown) => void;
}

const MAX_CONSUMED_ACTIVATION_IDS = 64;

export class SessionCoordinator {
  private readonly transport: NfcTransport;
  private readonly scanSubscribers = new Map<ReaderId, ReaderCallbacks>();
  private scanOperationId: string | null = null;
  private activeOperation: ActiveOperation | null = null;
  private appForeground = true;
  private readonly internallyCancelledScans = new Set<string>();
  private readonly consumedActivationIds: string[] = [];
  private readonly consumedActivationIdSet = new Set<string>();
  private pendingActivations: LaunchTagActivation[] = [];
  private readonly subscriptions: Subscription[] = [];
  private started = false;
  private drainingLaunchTags: Promise<void> | null = null;

  constructor(transport: NfcTransport) {
    this.transport = transport;
    this.subscriptions.push(
      transport.addEventListener('tagDiscovered', ev =>
        this.handleTagDiscovered(ev),
      ),
      transport.addEventListener('operationEnded', ev =>
        this.handleOperationEnded(ev),
      ),
      transport.addEventListener('stateChanged', ev =>
        this.handleStateChanged(ev),
      ),
      transport.addEventListener('appStateChanged', ev =>
        this.handleAppStateChanged(ev),
      ),
      transport.addEventListener('launchTagReceived', () => {
        void this.drainLaunchTags();
      }),
    );
  }

  /** Call once at startup to drain any cold-launch activation (§12c). */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.drainLaunchTags();
  }

  dispose(): void {
    for (const sub of this.subscriptions) sub.remove();
    this.subscriptions.length = 0;
  }

  // --- derived state -------------------------------------------------------

  private shouldScan(): boolean {
    return (
      this.scanSubscribers.size > 0 &&
      this.activeOperation === null &&
      this.appForeground
    );
  }

  /** Exposed for tests asserting the debugging invariant (§5a). */
  debugState(): {
    shouldScan: boolean;
    scanOperationId: string | null;
    activeOperation: {kind: string; operationId: string} | null;
    appForeground: boolean;
    scanSubscriberCount: number;
    internallyCancelledScanCount: number;
  } {
    return {
      shouldScan: this.shouldScan(),
      scanOperationId: this.scanOperationId,
      activeOperation: this.activeOperation
        ? {
            kind: this.activeOperation.kind,
            operationId: this.activeOperation.operationId,
          }
        : null,
      appForeground: this.appForeground,
      scanSubscriberCount: this.scanSubscribers.size,
      internallyCancelledScanCount: this.internallyCancelledScans.size,
    };
  }

  // --- scan() ----------------------------------------------------------------

  /**
   * Registers a reader as a scan subscriber. Throws synchronously with
   * InvalidStateError if this exact reader is already scanning (§5a) — this
   * is a per-reader check the caller (WebNfcReader) must have already
   * performed before calling here in the normal flow, but SessionCoordinator
   * enforces it too so it can never be bypassed by calling the coordinator
   * directly.
   */
  addScanSubscriber(readerId: ReaderId, callbacks: ReaderCallbacks): void {
    if (this.scanSubscribers.has(readerId)) {
      throw createDOMException(
        'InvalidStateError',
        'this reader already has an active scan()',
      );
    }
    this.scanSubscribers.set(readerId, callbacks);
    this.reconcile();
    this.deliverPendingActivationsIfAny();
  }

  /** Removes a reader from scanSubscribers (e.g. its AbortSignal fired). */
  removeScanSubscriber(readerId: ReaderId): void {
    if (!this.scanSubscribers.has(readerId)) return;
    this.scanSubscribers.delete(readerId);
    this.reconcile();
  }

  isScanning(readerId: ReaderId): boolean {
    return this.scanSubscribers.has(readerId);
  }

  // --- write() / makeReadOnly() -----------------------------------------------

  /**
   * Starts a write or makeReadOnly operation, replacing any currently active
   * one (§5a/§5d — replace, never InvalidStateError). Returns a promise that
   * resolves/rejects with the *new* operation's outcome; the previous
   * operation (if any) is rejected with AbortError as a side effect before
   * this returns.
   */
  async beginExclusiveOperation(
    kind: 'write' | 'makeReadOnly',
    run: (operationId: string) => Promise<void>,
  ): Promise<void> {
    this.replaceActiveOperation();

    const operationId = newOperationId();
    let controllerAbort!: (reason: unknown) => void;
    const abortPromise = new Promise<never>((_resolve, reject) => {
      controllerAbort = reject;
    });
    // Prevent an unhandled-rejection warning for the internal race promise —
    // whichever of run()/abortPromise settles second is ignored, but both
    // are always awaited by the same Promise.race below.
    abortPromise.catch(() => {});

    this.activeOperation = {kind, operationId, abort: controllerAbort};
    this.reconcile();

    try {
      await Promise.race([run(operationId), abortPromise]);
    } finally {
      if (this.activeOperation?.operationId === operationId) {
        this.activeOperation = null;
        this.reconcile();
      }
    }
  }

  /** Rejects any in-flight write/makeReadOnly with AbortError (replacement). */
  private replaceActiveOperation(): void {
    if (this.activeOperation) {
      const previousOperationId = this.activeOperation.operationId;
      this.activeOperation.abort(
        createDOMException(
          'AbortError',
          'replaced by a new write()/makeReadOnly() call',
        ),
      );
      // Propagate cancellation all the way down (§5c) — only rejecting the
      // JS-side abort promise leaves the prior native operation running, so
      // a stale write/makeReadOnly can still land on the tag (between
      // ndef.connect() and ndef.writeNdefMessage()) after the caller has
      // already treated it as aborted. Mirrors the call shape in
      // cancelOperationExternally() above.
      void this.transport.cancelOperation(previousOperationId);
    }
  }

  /** Cancels whichever operation (scan or exclusive) owns this operationId, from a caller's AbortSignal. */
  cancelOperationExternally(operationId: string): void {
    if (this.activeOperation?.operationId === operationId) {
      this.activeOperation.abort(
        createDOMException('AbortError', 'operation aborted by caller'),
      );
      // Tell the transport too — per §5c, cancellation must propagate all
      // the way down so a real (or in-memory) transport actually stops
      // doing work, not just so the JS-side promise settles.
      void this.transport.cancelOperation(operationId);
      return;
    }
    // Scan cancellation via a reader's own signal is handled by the reader
    // calling removeScanSubscriber(); this method exists for symmetry with
    // exclusive operations where WebNfcReader doesn't own operationId
    // bookkeeping directly.
  }

  // --- reconciliation ----------------------------------------------------------

  /**
   * Single synchronous reconciliation pass (§5a). Must not await anything
   * before mutating scanOperationId — see the race note in the plan: two
   * reconciliation passes triggered back-to-back must not both start a scan.
   */
  private reconcile(): void {
    const should = this.shouldScan();
    if (should && this.scanOperationId === null) {
      const id = newOperationId();
      this.scanOperationId = id;
      this.transport.beginScan(id, {}).catch((error: unknown) => {
        if (this.scanOperationId === id) {
          this.scanOperationId = null;
        }
        this.broadcastScanError(toDomException(error));
      });
    } else if (!should && this.scanOperationId !== null) {
      const id = this.scanOperationId;
      this.internallyCancelledScans.add(id);
      this.scanOperationId = null;
      void this.transport.cancelOperation(id);
    }
  }

  private broadcastScanError(error: DOMException): void {
    for (const callbacks of this.scanSubscribers.values()) {
      callbacks.onScanError(error);
    }
  }

  // --- transport event handlers --------------------------------------------

  private handleTagDiscovered(ev: TagDiscoveredEvent): void {
    // Stale-event invariant (§5a): only accept a tagDiscovered for the
    // *current* scanOperationId. Anything else (a late event for a
    // superseded scan) is dropped without side effects.
    if (ev.operationId !== this.scanOperationId) return;
    const delivery: ReadingDelivery = {
      operationId: ev.operationId,
      serialNumber: ev.serialNumber,
      records: ev.records,
    };
    for (const callbacks of this.scanSubscribers.values()) {
      callbacks.onReading(delivery);
    }
  }

  private handleOperationEnded(ev: OperationEndedEvent): void {
    // Stale-event invariant (§5a): drop anything not matching current state
    // and not an internally-tracked cancellation.
    const isCurrentScan = ev.operationId === this.scanOperationId;
    const isCurrentExclusive =
      ev.operationId === this.activeOperation?.operationId;
    const isInternallyCancelled = this.internallyCancelledScans.has(
      ev.operationId,
    );

    if (isInternallyCancelled) {
      // Swallow: this is native's belated acknowledgement of a cancellation
      // the coordinator itself already initiated (write-suspension,
      // backgrounding, or the last-subscriber's own abort already having
      // resolved that reader's promise synchronously in WebNfcReader.ts).
      // No second error path is ever produced from this.
      this.internallyCancelledScans.delete(ev.operationId);
      return;
    }

    if (isCurrentScan) {
      // A scan ended on its own (native-side error/timeout/hardware event),
      // not because the coordinator suspended it.
      this.scanOperationId = null;
      if (ev.reason !== 'success' && ev.reason !== 'cancelled') {
        this.broadcastScanError(mapOperationEndedReasonToError(ev));
      }
      return;
    }

    if (isCurrentExclusive) {
      // beginWrite/beginMakeReadOnly's own promise already carries this
      // outcome (§3's promise-resolution semantics) — nothing further to do
      // here besides letting beginExclusiveOperation's run() promise settle,
      // which happens via the transport call itself, not this event.
      return;
    }

    // Stale — not current scan, not current exclusive op, not a tracked
    // internal cancellation. Drop it.
  }

  private handleStateChanged(_ev: StateChangedEvent): void {
    // No coordinator state currently derives from stateChanged directly;
    // WebNfcReader/NfcModule consumers may query isEnabled() themselves.
    // Reserved per §3 for future use (e.g. surfacing NotReadableError to
    // active subscribers) — kept as a no-op placeholder rather than
    // speculative behavior not covered by the behavioral matrix (§6e).
  }

  private handleAppStateChanged(ev: AppStateChangedEvent): void {
    const foreground = ev.state === 'foreground';
    if (foreground === this.appForeground) return;
    this.appForeground = foreground;
    this.reconcile();
  }

  // --- launch-tag delivery (§12c) -------------------------------------------

  /** Drain-until-empty per §12c's pseudocode, deduplicated by activationId. */
  async drainLaunchTags(): Promise<void> {
    if (this.drainingLaunchTags) {
      await this.drainingLaunchTags;
      return;
    }
    const run = (async () => {
      for (;;) {
        const activation = await this.transport.consumePendingLaunchTag();
        if (!activation) break;
        if (this.consumedActivationIdSet.has(activation.activationId)) continue;
        this.markActivationConsumed(activation.activationId);
        this.deliverOrQueueActivation(activation);
      }
    })();
    this.drainingLaunchTags = run;
    try {
      await run;
    } finally {
      this.drainingLaunchTags = null;
    }
  }

  private markActivationConsumed(activationId: string): void {
    this.consumedActivationIdSet.add(activationId);
    this.consumedActivationIds.push(activationId);
    if (this.consumedActivationIds.length > MAX_CONSUMED_ACTIVATION_IDS) {
      // length > cap (>= 1) after the push above, so shift() always returns
      // a real id here.
      const evicted = this.consumedActivationIds.shift() as string;
      this.consumedActivationIdSet.delete(evicted);
    }
  }

  private deliverOrQueueActivation(activation: LaunchTagActivation): void {
    if (this.scanSubscribers.size === 0) {
      this.pendingActivations.push(activation);
      return;
    }
    this.deliverActivation(activation);
  }

  private deliverActivation(activation: LaunchTagActivation): void {
    const delivery: ReadingDelivery = {
      operationId: `launch-${activation.activationId}`,
      serialNumber: activation.serialNumber ?? '',
      records: activation.records,
    };
    for (const callbacks of this.scanSubscribers.values()) {
      callbacks.onReading(delivery);
    }
  }

  private deliverPendingActivationsIfAny(): void {
    if (this.pendingActivations.length === 0) return;
    const pending = this.pendingActivations;
    this.pendingActivations = [];
    for (const activation of pending) {
      this.deliverActivation(activation);
    }
  }
}

function toDomException(error: unknown): DOMException {
  if (error instanceof DOMException) return error;
  return createDOMException(
    'NotReadableError',
    error instanceof Error ? error.message : String(error),
  );
}

function mapOperationEndedReasonToError(ev: OperationEndedEvent): DOMException {
  if (ev.reason === 'timeout') {
    return createDOMException(
      'NotAllowedError',
      ev.message ?? 'operation timed out',
    );
  }
  return createDOMException(
    'NotReadableError',
    ev.message ?? 'operation ended with an error',
  );
}
