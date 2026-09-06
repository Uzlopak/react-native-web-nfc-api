/**
 * Assert helpers + WPT-ported helpers (§5f): assertWebNDEFMessagesEqual,
 * createMessage/createRecord/createTextRecord/createMimeRecord/
 * createUrlRecord/createUnknownRecord, assertRejectsWithName.
 *
 * Zero-dep (no Jest import) so these are usable from any test runner, per
 * the plan's "harness.ts: assert/assertEqual/assertRejects/withTimeout
 * (zero-dep)" note (§1).
 */
import {stringToBytes} from '../lib/ndef-wire';
import type {
  NDEFMessage,
  NDEFMessageInit,
  NDEFRecord,
  NDEFRecordInit,
} from '../WebNfcReader';

export class AssertionError extends Error {}

export function assert(
  condition: unknown,
  message = 'assertion failed',
): asserts condition {
  if (!condition) throw new AssertionError(message);
}

export function assertEqual<T>(actual: T, expected: T, message?: string): void {
  if (!deepEqual(actual, expected)) {
    throw new AssertionError(
      message ??
        `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (a instanceof DataView && b instanceof DataView) {
    if (a.byteLength !== b.byteLength) return false;
    for (let i = 0; i < a.byteLength; i++) {
      if (a.getUint8(i) !== b.getUint8(i)) return false;
    }
    return true;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (
    typeof a === 'object' &&
    typeof b === 'object' &&
    a !== null &&
    b !== null
  ) {
    const aKeys = Object.keys(a as object);
    const bKeys = Object.keys(b as object);
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every(k =>
      deepEqual(
        (a as Record<string, unknown>)[k],
        (b as Record<string, unknown>)[k],
      ),
    );
  }
  return false;
}

/** Rejects unless `promise` rejects; throws AssertionError otherwise. */
export async function assertRejects(
  promise: Promise<unknown>,
  message?: string,
): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new AssertionError(message ?? 'expected promise to reject');
}

/** WPT's promise_rejects_dom(t, 'ErrorName', promise) equivalent (§5f). */
export async function assertRejectsWithName(
  promise: Promise<unknown>,
  name: string,
): Promise<unknown> {
  const err = await assertRejects(
    promise,
    `expected promise to reject with name "${name}"`,
  );
  const actualName = (err as {name?: string} | undefined)?.name;
  if (actualName !== name) {
    throw new AssertionError(
      `expected rejection name "${name}", got "${actualName}"`,
    );
  }
  return err;
}

export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message = 'timed out',
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new AssertionError(message)), ms);
    promise.then(
      value => {
        clearTimeout(timer);
        resolve(value);
      },
      err => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

// --- WPT-ported factory helpers (§5e/§5f) -----------------------------------

export function createTextRecord(
  text: string,
  opts: {lang?: string; id?: string} = {},
): NDEFRecordInit {
  return {recordType: 'text', data: text, lang: opts.lang ?? 'en', id: opts.id};
}

export function createUrlRecord(
  url: string,
  opts: {id?: string} = {},
): NDEFRecordInit {
  return {recordType: 'url', data: url, id: opts.id};
}

export function createMimeRecord(
  mediaType: string,
  data: BufferSource | string,
  opts: {id?: string} = {},
): NDEFRecordInit {
  // stringToBytes returns Uint8Array<ArrayBufferLike>; the public
  // NDEFRecordInit.data type is `string | BufferSource | NDEFMessageInit`.
  // TS5 tightened ArrayBufferView's generic to ArrayBuffer (excluding
  // SharedArrayBuffer), which our Uint8Array doesn't satisfy under strict
  // mode — cast through unknown rather than loosening the type.
  const bytes = (
    typeof data === 'string' ? stringToBytes(data) : data
  ) as BufferSource;
  return {recordType: 'mime', mediaType, data: bytes, id: opts.id};
}

export function createUnknownRecord(
  data: BufferSource,
  opts: {id?: string} = {},
): NDEFRecordInit {
  return {recordType: 'unknown', data, id: opts.id};
}

export function createRecord(
  recordType: string,
  data?: string | BufferSource | NDEFMessageInit,
  opts: {id?: string; mediaType?: string} = {},
): NDEFRecordInit {
  return {recordType, data, id: opts.id, mediaType: opts.mediaType};
}

export function createMessage(records: NDEFRecordInit[]): NDEFMessageInit {
  return {records};
}

// --- WPT-ported deep-equality assertion (§5e/§5f) ---------------------------

/**
 * Ports WPT's assertWebNDEFMessagesEqual: record-by-record field comparison
 * (recordType/mediaType/id/encoding/lang/byte-equal data), recursing into
 * toRecords() for smart-poster records.
 */
export function assertWebNDEFMessagesEqual(
  actual: NDEFMessage,
  expected: NDEFMessage,
): void {
  assertEqual(
    actual.records.length,
    expected.records.length,
    'message record count mismatch',
  );
  for (let i = 0; i < actual.records.length; i++) {
    assertRecordsEqual(actual.records[i], expected.records[i]);
  }
}

function assertRecordsEqual(actual: NDEFRecord, expected: NDEFRecord): void {
  assertEqual(actual.recordType, expected.recordType, 'recordType mismatch');
  assertEqual(actual.mediaType, expected.mediaType, 'mediaType mismatch');
  assertEqual(actual.id, expected.id, 'id mismatch');
  assertEqual(actual.encoding, expected.encoding, 'encoding mismatch');
  assertEqual(actual.lang, expected.lang, 'lang mismatch');
  assertDataViewsEqual(actual.data, expected.data);
  if (expected.toRecords) {
    assert(
      typeof actual.toRecords === 'function',
      'expected toRecords() to be defined',
    );
    const actualNested = actual.toRecords?.() ?? [];
    const expectedNested = expected.toRecords();
    assertEqual(
      actualNested.length,
      expectedNested.length,
      'nested record count mismatch',
    );
    for (let i = 0; i < actualNested.length; i++) {
      assertRecordsEqual(actualNested[i], expectedNested[i]);
    }
  }
}

function assertDataViewsEqual(
  actual: DataView | undefined,
  expected: DataView | undefined,
): void {
  if (actual === undefined || expected === undefined) {
    assertEqual(actual, expected, 'data presence mismatch');
    return;
  }
  assertEqual(actual.byteLength, expected.byteLength, 'data length mismatch');
  for (let i = 0; i < actual.byteLength; i++) {
    assertEqual(
      actual.getUint8(i),
      expected.getUint8(i),
      `data byte ${i} mismatch`,
    );
  }
}
