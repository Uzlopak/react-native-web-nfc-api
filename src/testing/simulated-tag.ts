/**
 * SimulatedTag base class + canned subclasses (§6b): the in-memory tag
 * model InMemoryNfcTransport reads from and writes to.
 */
import {createDOMException, DOMException} from '../lib/dom-exception';
import {type NdefWireRecord, stringToBytes} from '../lib/ndef-wire';
import {encodeWebRecord} from '../lib/well-known-records';

export interface LastWrite {
  records: NdefWireRecord[];
  overwrite: boolean;
}

export class SimulatedTag {
  serialNumber: string;
  records: NdefWireRecord[];
  writable: boolean;
  lastWrite: LastWrite | null = null;
  /** Non-NDEF tags surface as `readingerror`, not `reading` (§5f, §6b). */
  isNdef = true;

  constructor(
    opts: {
      serialNumber?: string;
      records?: NdefWireRecord[];
      writable?: boolean;
    } = {},
  ) {
    this.serialNumber = opts.serialNumber ?? defaultSerialNumber();
    this.records = opts.records ?? [];
    this.writable = opts.writable ?? true;
  }

  /** Called by InMemoryNfcTransport when a write() targets this tag. */
  onWrite(records: NdefWireRecord[], overwrite: boolean): void {
    if (!this.writable) {
      throw createDOMException('InvalidStateError', 'tag is read-only');
    }
    if (!overwrite && this.records.length > 0) {
      throw createDOMException(
        'NotAllowedError',
        'tag already has NDEF records and overwrite is false',
      );
    }
    this.records = records;
    this.lastWrite = {records, overwrite};
  }

  /** Called by InMemoryNfcTransport when makeReadOnly() targets this tag. */
  onMakeReadOnly(): void {
    // Already-read-only resolves as a no-op success (§6e) — not an error.
    this.writable = false;
  }
}

let nextSerial = 1;
function defaultSerialNumber(): string {
  const n = nextSerial;
  nextSerial += 1;
  return `sim-tag-${n}`;
}

export class TextTag extends SimulatedTag {
  constructor(opts: {
    text: string;
    lang?: string;
    serialNumber?: string;
    writable?: boolean;
  }) {
    super({
      serialNumber: opts.serialNumber,
      writable: opts.writable,
      records: [
        encodeWebRecord({
          recordType: 'text',
          data: stringToBytes(opts.text),
          lang: opts.lang,
        }),
      ],
    });
  }
}

export class UrlTag extends SimulatedTag {
  constructor(opts: {url: string; serialNumber?: string; writable?: boolean}) {
    super({
      serialNumber: opts.serialNumber,
      writable: opts.writable,
      records: [
        encodeWebRecord({
          recordType: 'url',
          data: stringToBytes(opts.url),
        }),
      ],
    });
  }
}

export class ReadOnlyTag extends SimulatedTag {
  constructor(opts: {records?: NdefWireRecord[]; serialNumber?: string} = {}) {
    super({
      serialNumber: opts.serialNumber,
      records: opts.records ?? [],
      writable: false,
    });
  }
}

export class EmptyTag extends SimulatedTag {
  constructor(opts: {serialNumber?: string; writable?: boolean} = {}) {
    super({
      serialNumber: opts.serialNumber,
      writable: opts.writable,
      records: [],
    });
  }
}

export class MultiRecordTag extends SimulatedTag {
  constructor(opts: {
    records: NdefWireRecord[];
    serialNumber?: string;
    writable?: boolean;
  }) {
    super({
      serialNumber: opts.serialNumber,
      writable: opts.writable,
      records: opts.records,
    });
  }
}

/** Delays discovery/write by `delayMs`, to test cancellation mid-operation. */
export class SlowTag extends SimulatedTag {
  readonly delayMs: number;

  constructor(opts: {
    delayMs: number;
    records?: NdefWireRecord[];
    serialNumber?: string;
    writable?: boolean;
  }) {
    super({
      serialNumber: opts.serialNumber,
      writable: opts.writable,
      records: opts.records ?? [],
    });
    this.delayMs = opts.delayMs;
  }
}

/** Fails the Nth write with NetworkError (1-indexed), succeeding otherwise. */
export class FlakyTag extends SimulatedTag {
  private writeAttempts = 0;
  readonly failOnAttempt: number;

  constructor(opts: {
    failOnAttempt: number;
    records?: NdefWireRecord[];
    serialNumber?: string;
  }) {
    super({serialNumber: opts.serialNumber, records: opts.records ?? []});
    this.failOnAttempt = opts.failOnAttempt;
  }

  override onWrite(records: NdefWireRecord[], overwrite: boolean): void {
    this.writeAttempts += 1;
    if (this.writeAttempts === this.failOnAttempt) {
      throw createDOMException(
        'NetworkError',
        'simulated data transfer failure',
      );
    }
    super.onWrite(records, overwrite);
  }
}

/** A tag that exposes a non-NDEF technology: discovery surfaces readingerror (§5f). */
export class NonNdefTag extends SimulatedTag {
  constructor(opts: {serialNumber?: string} = {}) {
    super({serialNumber: opts.serialNumber, records: []});
    this.isNdef = false;
  }
}

export {DOMException};
