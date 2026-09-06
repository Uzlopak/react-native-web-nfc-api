/**
 * NDEFReader/NDEFMessage/NDEFRecord/NDEFReadingEvent (§2), with a
 * PassthroughStrategy (real browser NDEFReader, web default) and a
 * ManagedStrategy (SessionCoordinator + NfcTransport, native always, web
 * opt-in via mode:'managed') chosen once at construction time (§4).
 */
import {type AbortSignalLike, isAbortSignal} from './lib/abort-signal';
import {createDOMException} from './lib/dom-exception';
import {Event, EventTarget} from './lib/event-target';
import type {NdefWireRecord} from './lib/ndef-wire';
import type {NDEFMessageSource} from './lib/web-record';
import {coerceMessageSource} from './lib/web-record';
import {decodeRecord, type WebRecordFields} from './lib/well-known-records';
import {getNfcTransport} from './NfcModule';
import {
  newReaderId,
  type ReaderId,
  type ReadingDelivery,
  SessionCoordinator,
} from './SessionCoordinator';
import type {NfcTransport} from './transport';

// --- Public class shapes (§2) ----------------------------------------------

export interface NDEFRecordInit {
  recordType: string;
  mediaType?: string;
  id?: string;
  data?: string | BufferSource | NDEFMessageInit;
  encoding?: string;
  lang?: string;
}

export interface NDEFMessageInit {
  records: NDEFRecordInit[];
}

export class NDEFRecord {
  readonly recordType: string;
  readonly mediaType?: string;
  readonly id?: string;
  readonly data?: DataView;
  readonly encoding?: string;
  readonly lang?: string;
  toRecords?: () => NDEFRecord[];

  constructor(init: NDEFRecordInit) {
    const wire = coerceMessageSource({
      records: [init],
    } satisfies NDEFMessageInit)[0];
    const fields = decodeRecord(wire);
    this.recordType = fields.recordType;
    this.mediaType = fields.mediaType;
    this.id = fields.id;
    this.data = toDataView(fields.data);
    this.encoding = fields.encoding;
    this.lang = fields.lang;
    if (fields.toRecordsWire) {
      const nested = fields.toRecordsWire.map(w => buildRecordFromWire(w));
      this.toRecords = () => nested;
    }
  }
}

function toDataView(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** Builds an NDEFRecord directly from a decoded wire record (internal use only). */
function buildRecordFromWire(wire: NdefWireRecord): NDEFRecord {
  const fields = decodeRecord(wire);
  return buildRecordFromFields(fields);
}

function buildRecordFromFields(fields: WebRecordFields): NDEFRecord {
  const record = Object.create(NDEFRecord.prototype) as NDEFRecord;
  (record as {recordType: string}).recordType = fields.recordType;
  (record as {mediaType?: string}).mediaType = fields.mediaType;
  (record as {id?: string}).id = fields.id;
  (record as {data?: DataView}).data = toDataView(fields.data);
  (record as {encoding?: string}).encoding = fields.encoding;
  (record as {lang?: string}).lang = fields.lang;
  if (fields.toRecordsWire) {
    const nested = fields.toRecordsWire.map(w => buildRecordFromWire(w));
    record.toRecords = () => nested;
  }
  return record;
}

export class NDEFMessage {
  readonly records: ReadonlyArray<NDEFRecord>;

  constructor(init: NDEFMessageInit) {
    const wires = coerceMessageSource(init as NDEFMessageSource);
    this.records = wires.map(w => buildRecordFromWire(w));
  }
}

/** Internal: build an NDEFMessage directly from wire records without re-validating. */
function buildMessageFromWire(records: NdefWireRecord[]): NDEFMessage {
  const message = Object.create(NDEFMessage.prototype) as NDEFMessage;
  (message as {records: ReadonlyArray<NDEFRecord>}).records = records.map(w =>
    buildRecordFromWire(w),
  );
  return message;
}

export interface NDEFReadingEventInit {
  serialNumber?: string;
  message: NDEFMessage;
}

export class NDEFReadingEvent extends Event {
  readonly serialNumber: string;
  readonly message: NDEFMessage;

  constructor(type: string, init: NDEFReadingEventInit) {
    super(type);
    this.serialNumber = init.serialNumber ?? '';
    this.message = init.message;
  }
}

export interface NDEFScanOptions {
  signal?: AbortSignalLike;
}

export interface NDEFWriteOptions {
  overwrite?: boolean;
  signal?: AbortSignalLike;
}

export interface NDEFMakeReadOnlyOptions {
  signal?: AbortSignalLike;
}

export interface NDEFReaderOptions {
  /** web only; ignored on native. Default: 'passthrough' (§4). */
  mode?: 'passthrough' | 'managed';
}

// --- Strategy interface ------------------------------------------------------

interface ReaderStrategy {
  scan(
    options: NDEFScanOptions | undefined,
    dispatch: (event: Event) => void,
  ): Promise<void>;
  write(
    message: NDEFMessageSource,
    options: NDEFWriteOptions | undefined,
  ): Promise<void>;
  makeReadOnly(options: NDEFMakeReadOnlyOptions | undefined): Promise<void>;
}

function validateSignal(
  signal: unknown,
): asserts signal is AbortSignalLike | undefined {
  if (signal !== undefined && !isAbortSignal(signal)) {
    throw new TypeError('signal must be an AbortSignal');
  }
}

// --- ManagedStrategy: SessionCoordinator + NfcTransport (§4, §5) -------------

/**
 * One process-wide SessionCoordinator per NfcTransport instance, so multiple
 * managed-mode readers sharing the same (real or injected) transport are
 * correctly multiplexed (§5a), while readers on genuinely distinct
 * transports (e.g. two independent InMemoryNfcTransport instances in
 * separate tests) don't interfere with each other.
 */
const coordinatorsByTransport = new WeakMap<NfcTransport, SessionCoordinator>();

function getCoordinatorFor(transport: NfcTransport): SessionCoordinator {
  let coordinator = coordinatorsByTransport.get(transport);
  if (!coordinator) {
    coordinator = new SessionCoordinator(transport);
    coordinatorsByTransport.set(transport, coordinator);
    void coordinator.start();
  }
  return coordinator;
}

/** Test-only: forget a transport's coordinator so a fresh one is built next time. */
export function _resetCoordinatorForTransport(transport: NfcTransport): void {
  coordinatorsByTransport.delete(transport);
}

class ManagedStrategy implements ReaderStrategy {
  private readonly readerId: ReaderId = newReaderId();
  private readonly transport: NfcTransport;
  private readonly coordinator: SessionCoordinator;

  constructor(transport: NfcTransport) {
    this.transport = transport;
    this.coordinator = getCoordinatorFor(transport);
  }

  async scan(
    options: NDEFScanOptions | undefined,
    dispatch: (event: Event) => void,
  ): Promise<void> {
    validateSignal(options?.signal);
    const signal = options?.signal;

    if (signal?.aborted) {
      throw createDOMException('AbortError', 'signal is already aborted');
    }

    // Run the two capability checks in parallel — each is a TurboModule
    // round-trip and they're independent. Sequential awaiting doubled the
    // latency on every scan/write/makeReadOnly entry point before this fix.
    const [supported, enabled] = await Promise.all([
      this.transport.isSupported(),
      this.transport.isEnabled(),
    ]);
    if (!supported) {
      throw createDOMException(
        'NotSupportedError',
        'NFC is not supported on this device',
      );
    }
    if (!enabled) {
      throw createDOMException('NotReadableError', 'NFC is disabled');
    }

    let removedByAbort = false;
    const onAbort = () => {
      // Remove the listener itself so the closure (and its captured
      // `this.coordinator` / `dispatch` references) is eligible for GC
      // immediately when the user reuses a long-lived AbortSignal across
      // many scans — without this, every scan() call would leak a
      // listener that pins the reader alive until the signal itself is
      // collected. `onAbort` only ever runs as this `signal`'s own 'abort'
      // listener or from the manual re-check right below, both gated on
      // `signal` being truthy, so it's guaranteed non-null here.
      signal!.removeEventListener('abort', onAbort);
      removedByAbort = true;
      this.coordinator.removeScanSubscriber(this.readerId);
      dispatch(makeReadingErrorEvent());
    };

    this.coordinator.addScanSubscriber(this.readerId, {
      onReading: delivery => dispatch(buildReadingEvent(delivery)),
      onScanError: () => dispatch(makeReadingErrorEvent()),
    });

    signal?.addEventListener('abort', onAbort);

    if (signal?.aborted && !removedByAbort) {
      onAbort();
      throw createDOMException('AbortError', 'signal is already aborted');
    }
  }

  async write(
    message: NDEFMessageSource,
    options: NDEFWriteOptions | undefined,
  ): Promise<void> {
    validateSignal(options?.signal);
    const signal = options?.signal;
    if (signal?.aborted) {
      throw createDOMException('AbortError', 'signal is already aborted');
    }

    // Run the two capability checks in parallel — each is a TurboModule
    // round-trip and they're independent. Sequential awaiting doubled the
    // latency on every scan/write/makeReadOnly entry point before this fix.
    const [supported, enabled] = await Promise.all([
      this.transport.isSupported(),
      this.transport.isEnabled(),
    ]);
    if (!supported) {
      throw createDOMException(
        'NotSupportedError',
        'NFC is not supported on this device',
      );
    }
    if (!enabled) {
      throw createDOMException('NotReadableError', 'NFC is disabled');
    }

    const records = coerceMessageSource(message);
    const overwrite = options?.overwrite ?? true;

    await this.coordinator.beginExclusiveOperation(
      'write',
      async operationId => {
        let abortListener: (() => void) | undefined;
        try {
          const runPromise = this.transport.beginWrite(operationId, records, {
            overwrite,
          });
          if (signal) {
            abortListener = () =>
              this.coordinator.cancelOperationExternally(operationId);
            signal.addEventListener('abort', abortListener);
            // The signal may have fired in the window between write()'s
            // upfront synchronous check and this listener being attached
            // (Promise.all(isSupported, isEnabled) is awaited in between) —
            // catch that race here rather than hanging until the transport
            // itself settles.
            if (signal.aborted) abortListener();
          }
          await runPromise;
        } finally {
          if (signal && abortListener)
            signal.removeEventListener('abort', abortListener);
        }
      },
    );
  }

  async makeReadOnly(
    options: NDEFMakeReadOnlyOptions | undefined,
  ): Promise<void> {
    validateSignal(options?.signal);
    const signal = options?.signal;
    if (signal?.aborted) {
      throw createDOMException('AbortError', 'signal is already aborted');
    }

    // Run the two capability checks in parallel — each is a TurboModule
    // round-trip and they're independent. Sequential awaiting doubled the
    // latency on every scan/write/makeReadOnly entry point before this fix.
    const [supported, enabled] = await Promise.all([
      this.transport.isSupported(),
      this.transport.isEnabled(),
    ]);
    if (!supported) {
      throw createDOMException(
        'NotSupportedError',
        'NFC is not supported on this device',
      );
    }
    if (!enabled) {
      throw createDOMException('NotReadableError', 'NFC is disabled');
    }

    await this.coordinator.beginExclusiveOperation(
      'makeReadOnly',
      async operationId => {
        let abortListener: (() => void) | undefined;
        try {
          const runPromise = this.transport.beginMakeReadOnly(operationId, {});
          if (signal) {
            abortListener = () =>
              this.coordinator.cancelOperationExternally(operationId);
            signal.addEventListener('abort', abortListener);
            if (signal.aborted) abortListener();
          }
          await runPromise;
        } finally {
          if (signal && abortListener)
            signal.removeEventListener('abort', abortListener);
        }
      },
    );
  }

  isScanning(): boolean {
    return this.coordinator.isScanning(this.readerId);
  }
}

function buildReadingEvent(delivery: ReadingDelivery): NDEFReadingEvent {
  const message = buildMessageFromWire(delivery.records);
  return new NDEFReadingEvent('reading', {
    serialNumber: delivery.serialNumber,
    message,
  });
}

function makeReadingErrorEvent(): Event {
  return new Event('readingerror');
}

// --- PassthroughStrategy: forwards to a real window.NDEFReader (§4) ---------

interface BrowserNdefReaderLike {
  scan(options?: {signal?: AbortSignalLike}): Promise<void>;
  write(
    message: unknown,
    options?: {overwrite?: boolean; signal?: AbortSignalLike},
  ): Promise<void>;
  makeReadOnly(options?: {signal?: AbortSignalLike}): Promise<void>;
  addEventListener(type: string, listener: (ev: unknown) => void): void;
  removeEventListener(type: string, listener: (ev: unknown) => void): void;
}

function getBrowserNDEFReaderConstructor():
  | (new () => BrowserNdefReaderLike)
  | undefined {
  const globalWithNdef = globalThis as {
    NDEFReader?: new () => BrowserNdefReaderLike;
  };
  return globalWithNdef.NDEFReader;
}

export class PassthroughStrategy implements ReaderStrategy {
  private browserReader: BrowserNdefReaderLike | undefined;
  private forwardedListener: ((ev: unknown) => void) | undefined;

  private getOrCreateBrowserReader(): BrowserNdefReaderLike {
    if (this.browserReader) return this.browserReader;
    const Ctor = getBrowserNDEFReaderConstructor();
    if (!Ctor) {
      throw createDOMException(
        'NotSupportedError',
        'this browser has no native NDEFReader implementation',
      );
    }
    this.browserReader = new Ctor();
    return this.browserReader;
  }

  bindForwarding(dispatch: (event: Event) => void): void {
    if (this.forwardedListener) return;
    const reader = this.getOrCreateBrowserReader();
    this.forwardedListener = (ev: unknown) => {
      const anyEv = ev as {
        type: string;
        serialNumber?: string;
        message?: unknown;
      };
      if (anyEv.type === 'reading') {
        // Forward as our own NDEFReadingEvent wrapping the browser's message
        // 1:1 — we don't re-decode it, since the browser already produced a
        // spec-conformant NDEFMessage.
        const message = anyEv.message as NDEFMessage;
        dispatch(
          new NDEFReadingEvent('reading', {
            serialNumber: anyEv.serialNumber,
            message,
          }),
        );
      } else {
        dispatch(new Event(anyEv.type));
      }
    };
    reader.addEventListener('reading', this.forwardedListener);
    reader.addEventListener('readingerror', this.forwardedListener);
  }

  async scan(
    options: NDEFScanOptions | undefined,
    dispatch: (event: Event) => void,
  ): Promise<void> {
    this.bindForwarding(dispatch);
    const reader = this.getOrCreateBrowserReader();
    return reader.scan(options);
  }

  async write(
    message: NDEFMessageSource,
    options: NDEFWriteOptions | undefined,
  ): Promise<void> {
    const reader = this.getOrCreateBrowserReader();
    return reader.write(message as unknown, options);
  }

  async makeReadOnly(
    options: NDEFMakeReadOnlyOptions | undefined,
  ): Promise<void> {
    const reader = this.getOrCreateBrowserReader();
    return reader.makeReadOnly(options);
  }
}

// --- Platform detection -------------------------------------------------------

function isWeb(): boolean {
  // react-native's Platform module isn't imported here to keep this file
  // importable from plain Node/Jest without an RN preset for the codec/unit
  // tests that don't need it; detect web the same way the rest of the
  // RN-web ecosystem does — no `navigator.product === 'ReactNative'`.
  return typeof window !== 'undefined' && typeof document !== 'undefined';
}

// --- NDEFReader (§2, §4) -----------------------------------------------------

export class NDEFReader extends EventTarget {
  onreading: ((ev: NDEFReadingEvent) => unknown) | null = null;
  onreadingerror: ((ev: Event) => unknown) | null = null;

  private readonly strategy: ReaderStrategy;
  private readonly managedStrategy: ManagedStrategy | undefined;

  /**
   * Non-spec helper (§4): lets app code feature-detect before constructing a
   * reader, e.g. `if (NDEFReader.isSupported?.()) { ... }`. This library
   * always exports a working `NDEFReader` class (unlike an unsupported
   * browser, which simply has no global `NDEFReader` at all), so
   * unsupported-browser detection otherwise only surfaces per-method-call
   * (a rejected promise) rather than at construction time — this static
   * method is a documented, non-invasive way to check upfront instead.
   *
   * - On native (Android/iOS): always `true` — there is always a managed
   *   polyfill to fall back to; whether real hardware is present is a
   *   separate, async question answered by `scan()`/`write()` rejecting.
   * - On web with the default passthrough mode: reflects whether
   *   `window.NDEFReader` (the browser's own implementation) exists.
   * - `mode: 'managed'` is always "supported" in the sense that the
   *   managed polyfill always exists — whether it can do anything useful
   *   depends on whether a transport was installed via `setNfcTransport()`,
   *   which (like native hardware) is an async, per-call concern.
   */
  static isSupported(mode: NDEFReaderOptions['mode'] = 'passthrough'): boolean {
    if (isWeb() && mode !== 'managed') {
      return getBrowserNDEFReaderConstructor() !== undefined;
    }
    return true;
  }

  constructor(options?: NDEFReaderOptions) {
    super();
    const mode = options?.mode ?? 'passthrough';
    if (isWeb() && mode !== 'managed') {
      this.strategy = new PassthroughStrategy();
      this.managedStrategy = undefined;
    } else {
      const transport = getNfcTransport();
      const managed = new ManagedStrategy(transport);
      this.strategy = managed;
      this.managedStrategy = managed;
    }
  }

  private dispatch(event: Event): void {
    this.dispatchEvent(event);
    if (event.type === 'reading' && this.onreading) {
      this.onreading(event as NDEFReadingEvent);
    } else if (event.type === 'readingerror' && this.onreadingerror) {
      this.onreadingerror(event);
    }
  }

  async scan(options?: NDEFScanOptions): Promise<void> {
    validateSignal(options?.signal);
    if (this.managedStrategy?.isScanning()) {
      throw createDOMException(
        'InvalidStateError',
        'this reader already has an active scan()',
      );
    }
    return this.strategy.scan(options, ev => this.dispatch(ev));
  }

  async write(
    message: NDEFMessageSource,
    options?: NDEFWriteOptions,
  ): Promise<void> {
    validateSignal(options?.signal);
    return this.strategy.write(message, options);
  }

  async makeReadOnly(options?: NDEFMakeReadOnlyOptions): Promise<void> {
    validateSignal(options?.signal);
    return this.strategy.makeReadOnly(options);
  }
}
