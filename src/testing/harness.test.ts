/**
 * Coverage for harness.ts's zero-dep assert helpers and WPT-ported factory
 * functions: these back every assertion in the conformance suite, so a bug
 * here (e.g. deepEqual silently treating two different values as equal)
 * would produce false-positive passes across the whole suite.
 */
import {
  assert,
  AssertionError,
  assertEqual,
  assertRejects,
  assertRejectsWithName,
  assertWebNDEFMessagesEqual,
  createMessage,
  createMimeRecord,
  createRecord,
  createTextRecord,
  createUnknownRecord,
  createUrlRecord,
  withTimeout,
} from './harness';
import type {NDEFMessage, NDEFRecord} from '../WebNfcReader';

function toDataView(bytes: number[]): DataView {
  const arr = new Uint8Array(bytes);
  return new DataView(arr.buffer, arr.byteOffset, arr.byteLength);
}

function record(overrides: Partial<NDEFRecord> = {}): NDEFRecord {
  return {
    recordType: 'text',
    mediaType: undefined,
    id: undefined,
    encoding: undefined,
    lang: undefined,
    data: toDataView([1, 2, 3]),
    ...overrides,
  } as NDEFRecord;
}

describe('assert()', () => {
  test('does not throw for a truthy condition', () => {
    expect(() => assert(true)).not.toThrow();
    expect(() => assert(1)).not.toThrow();
  });

  test('throws AssertionError with the default message for a falsy condition', () => {
    expect(() => assert(false)).toThrow(AssertionError);
    expect(() => assert(false)).toThrow('assertion failed');
  });

  test('throws AssertionError with a custom message', () => {
    expect(() => assert(0, 'custom message')).toThrow('custom message');
  });
});

describe('assertEqual()', () => {
  test('passes for identical primitives', () => {
    expect(() => assertEqual(1, 1)).not.toThrow();
    expect(() => assertEqual('a', 'a')).not.toThrow();
    expect(() => assertEqual(undefined, undefined)).not.toThrow();
  });

  test('passes for deep-equal arrays and objects', () => {
    expect(() => assertEqual([1, [2, 3]], [1, [2, 3]])).not.toThrow();
    expect(() =>
      assertEqual({a: 1, b: {c: 2}}, {a: 1, b: {c: 2}}),
    ).not.toThrow();
  });

  test('passes for byte-equal DataViews', () => {
    expect(() =>
      assertEqual(toDataView([1, 2, 3]), toDataView([1, 2, 3])),
    ).not.toThrow();
  });

  test('fails for DataViews of different length', () => {
    expect(() => assertEqual(toDataView([1, 2]), toDataView([1, 2, 3]))).toThrow(
      AssertionError,
    );
  });

  test('fails for DataViews with the same length but different bytes', () => {
    expect(() => assertEqual(toDataView([1, 2, 3]), toDataView([1, 2, 4]))).toThrow(
      AssertionError,
    );
  });

  test('fails for arrays of different length', () => {
    expect(() => assertEqual([1, 2], [1, 2, 3])).toThrow(AssertionError);
  });

  test('fails for arrays with same length but different elements', () => {
    expect(() => assertEqual([1, 2, 3], [1, 2, 4])).toThrow(AssertionError);
  });

  test('fails for objects with different key counts', () => {
    expect(() => assertEqual({a: 1}, {a: 1, b: 2})).toThrow(AssertionError);
  });

  test('fails for objects with the same keys but different values', () => {
    expect(() => assertEqual({a: 1}, {a: 2})).toThrow(AssertionError);
  });

  test('fails when comparing an object to a primitive', () => {
    expect(() => assertEqual({a: 1}, 1 as unknown as {a: number})).toThrow(
      AssertionError,
    );
  });

  test('fails when comparing null to an object', () => {
    expect(() =>
      assertEqual(null as unknown as object, {} as object),
    ).toThrow(AssertionError);
  });

  test('uses the default message (includes JSON of both values) when none is given', () => {
    expect(() => assertEqual(1, 2)).toThrow('expected 2, got 1');
  });

  test('uses a custom message when given', () => {
    expect(() => assertEqual(1, 2, 'custom')).toThrow('custom');
  });
});

describe('assertRejects()', () => {
  test('resolves with the rejection reason when the promise rejects', async () => {
    const err = await assertRejects(Promise.reject(new Error('boom')));
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe('boom');
  });

  test('throws AssertionError when the promise resolves instead', async () => {
    await expect(assertRejects(Promise.resolve('ok'))).rejects.toThrow(
      AssertionError,
    );
  });

  test('uses a custom message when the promise unexpectedly resolves', async () => {
    await expect(
      assertRejects(Promise.resolve('ok'), 'expected a failure'),
    ).rejects.toThrow('expected a failure');
  });
});

describe('assertRejectsWithName()', () => {
  test('resolves with the error when its name matches', async () => {
    const err = await assertRejectsWithName(
      Promise.reject({name: 'AbortError'}),
      'AbortError',
    );
    expect(err).toEqual({name: 'AbortError'});
  });

  test('throws AssertionError when the promise resolves instead of rejecting', async () => {
    await expect(
      assertRejectsWithName(Promise.resolve('ok'), 'AbortError'),
    ).rejects.toThrow('expected promise to reject with name "AbortError"');
  });

  test('throws AssertionError when the rejection name does not match', async () => {
    await expect(
      assertRejectsWithName(
        Promise.reject({name: 'NotFoundError'}),
        'AbortError',
      ),
    ).rejects.toThrow(
      'expected rejection name "AbortError", got "NotFoundError"',
    );
  });

  test('reports "undefined" when the rejection has no name at all', async () => {
    await expect(
      assertRejectsWithName(Promise.reject('a plain string'), 'AbortError'),
    ).rejects.toThrow('expected rejection name "AbortError", got "undefined"');
  });
});

describe('withTimeout()', () => {
  test('resolves with the value when the promise settles before the timeout', async () => {
    await expect(withTimeout(Promise.resolve('value'), 1000)).resolves.toBe(
      'value',
    );
  });

  test('rejects with the original error when the promise rejects before the timeout', async () => {
    await expect(
      withTimeout(Promise.reject(new Error('boom')), 1000),
    ).rejects.toThrow('boom');
  });

  test('rejects with AssertionError (default message) when the timeout elapses first', async () => {
    const never = new Promise<void>(() => {});
    await expect(withTimeout(never, 5)).rejects.toThrow(AssertionError);
    await expect(withTimeout(never, 5)).rejects.toThrow('timed out');
  });

  test('rejects with a custom message when the timeout elapses first', async () => {
    const never = new Promise<void>(() => {});
    await expect(withTimeout(never, 5, 'scan() timed out')).rejects.toThrow(
      'scan() timed out',
    );
  });
});

describe('WPT-ported factory helpers', () => {
  test('createTextRecord defaults lang to "en" and omits id when not given', () => {
    expect(createTextRecord('hello')).toEqual({
      recordType: 'text',
      data: 'hello',
      lang: 'en',
      id: undefined,
    });
  });

  test('createTextRecord accepts an explicit lang and id', () => {
    expect(createTextRecord('hola', {lang: 'es', id: 'r1'})).toEqual({
      recordType: 'text',
      data: 'hola',
      lang: 'es',
      id: 'r1',
    });
  });

  test('createUrlRecord builds a url record', () => {
    expect(createUrlRecord('https://example.com')).toEqual({
      recordType: 'url',
      data: 'https://example.com',
      id: undefined,
    });
    expect(createUrlRecord('https://example.com', {id: 'r2'}).id).toBe('r2');
  });

  test('createMimeRecord passes string data through stringToBytes', () => {
    const rec = createMimeRecord('text/plain', 'hi');
    expect(rec.recordType).toBe('mime');
    expect(rec.mediaType).toBe('text/plain');
    expect(rec.data).toBeInstanceOf(Uint8Array);
    expect(Array.from(rec.data as Uint8Array)).toEqual([
      'h'.charCodeAt(0),
      'i'.charCodeAt(0),
    ]);
  });

  test('createMimeRecord passes BufferSource data through unchanged', () => {
    const bytes = new Uint8Array([9, 9, 9]);
    const rec = createMimeRecord('application/octet-stream', bytes, {
      id: 'r3',
    });
    expect(rec.data).toBe(bytes);
    expect(rec.id).toBe('r3');
  });

  test('createUnknownRecord builds an unknown record', () => {
    const bytes = new Uint8Array([1]);
    const rec = createUnknownRecord(bytes, {id: 'r4'});
    expect(rec).toEqual({recordType: 'unknown', data: bytes, id: 'r4'});
  });

  test('createUnknownRecord omits id when opts is not given at all', () => {
    const bytes = new Uint8Array([1]);
    expect(createUnknownRecord(bytes)).toEqual({
      recordType: 'unknown',
      data: bytes,
      id: undefined,
    });
  });

  test('createRecord builds a generic record with optional mediaType/id', () => {
    expect(createRecord('smart-poster', undefined)).toEqual({
      recordType: 'smart-poster',
      data: undefined,
      id: undefined,
      mediaType: undefined,
    });
    expect(
      createRecord('mime', new Uint8Array([1]), {
        id: 'r5',
        mediaType: 'text/plain',
      }),
    ).toEqual({
      recordType: 'mime',
      data: new Uint8Array([1]),
      id: 'r5',
      mediaType: 'text/plain',
    });
  });

  test('createMessage wraps records', () => {
    const records = [createTextRecord('a'), createUrlRecord('https://x')];
    expect(createMessage(records)).toEqual({records});
  });
});

describe('assertWebNDEFMessagesEqual()', () => {
  function message(records: NDEFRecord[]): NDEFMessage {
    return {records} as NDEFMessage;
  }

  test('passes for two messages with identical records', () => {
    const a = message([record()]);
    const b = message([record()]);
    expect(() => assertWebNDEFMessagesEqual(a, b)).not.toThrow();
  });

  test('fails when record counts differ', () => {
    const a = message([record()]);
    const b = message([record(), record()]);
    expect(() => assertWebNDEFMessagesEqual(a, b)).toThrow(
      'message record count mismatch',
    );
  });

  test('fails when recordType differs', () => {
    const a = message([record({recordType: 'text'})]);
    const b = message([record({recordType: 'url'})]);
    expect(() => assertWebNDEFMessagesEqual(a, b)).toThrow(
      'recordType mismatch',
    );
  });

  test('fails when mediaType differs', () => {
    const a = message([record({mediaType: 'text/plain'})]);
    const b = message([record({mediaType: 'text/html'})]);
    expect(() => assertWebNDEFMessagesEqual(a, b)).toThrow(
      'mediaType mismatch',
    );
  });

  test('fails when id differs', () => {
    const a = message([record({id: 'r1'})]);
    const b = message([record({id: 'r2'})]);
    expect(() => assertWebNDEFMessagesEqual(a, b)).toThrow('id mismatch');
  });

  test('fails when encoding differs', () => {
    const a = message([record({encoding: 'utf-8'})]);
    const b = message([record({encoding: 'utf-16'})]);
    expect(() => assertWebNDEFMessagesEqual(a, b)).toThrow(
      'encoding mismatch',
    );
  });

  test('fails when lang differs', () => {
    const a = message([record({lang: 'en'})]);
    const b = message([record({lang: 'es'})]);
    expect(() => assertWebNDEFMessagesEqual(a, b)).toThrow('lang mismatch');
  });

  test('fails when data byte length differs', () => {
    const a = message([record({data: toDataView([1, 2])})]);
    const b = message([record({data: toDataView([1, 2, 3])})]);
    expect(() => assertWebNDEFMessagesEqual(a, b)).toThrow(
      'data length mismatch',
    );
  });

  test('fails when a data byte differs', () => {
    const a = message([record({data: toDataView([1, 2, 3])})]);
    const b = message([record({data: toDataView([1, 2, 4])})]);
    expect(() => assertWebNDEFMessagesEqual(a, b)).toThrow(
      'data byte 2 mismatch',
    );
  });

  test('passes when both records have undefined data', () => {
    const a = message([record({data: undefined})]);
    const b = message([record({data: undefined})]);
    expect(() => assertWebNDEFMessagesEqual(a, b)).not.toThrow();
  });

  test('fails when one record has data and the other does not', () => {
    const a = message([record({data: toDataView([1])})]);
    const b = message([record({data: undefined})]);
    expect(() => assertWebNDEFMessagesEqual(a, b)).toThrow(
      'data presence mismatch',
    );
  });

  test('treats a toRecords() that itself returns undefined as an empty nested list', () => {
    // The public NDEFRecord.toRecords type always returns NDEFRecord[], so
    // this only exercises the `?? []` defensive fallback via a fake record
    // that violates that contract on purpose.
    const a = message([
      record({
        recordType: 'smart-poster',
        data: undefined,
        toRecords: (() => undefined) as unknown as () => NDEFRecord[],
      }),
    ]);
    const b = message([
      record({
        recordType: 'smart-poster',
        data: undefined,
        toRecords: () => [],
      }),
    ]);
    expect(() => assertWebNDEFMessagesEqual(a, b)).not.toThrow();
  });

  test('recurses into toRecords() for smart-poster records and passes when nested records match', () => {
    const nested = record({recordType: 'url', data: toDataView([1])});
    const a = message([
      record({
        recordType: 'smart-poster',
        data: undefined,
        toRecords: () => [nested],
      }),
    ]);
    const b = message([
      record({
        recordType: 'smart-poster',
        data: undefined,
        toRecords: () => [nested],
      }),
    ]);
    expect(() => assertWebNDEFMessagesEqual(a, b)).not.toThrow();
  });

  test('fails when expected has toRecords but actual does not', () => {
    const nested = record({recordType: 'url'});
    const a = message([record({recordType: 'smart-poster', data: undefined})]);
    const b = message([
      record({
        recordType: 'smart-poster',
        data: undefined,
        toRecords: () => [nested],
      }),
    ]);
    expect(() => assertWebNDEFMessagesEqual(a, b)).toThrow(
      'expected toRecords() to be defined',
    );
  });

  test('fails when nested record counts differ', () => {
    const nested = record({recordType: 'url'});
    const a = message([
      record({
        recordType: 'smart-poster',
        data: undefined,
        toRecords: () => [nested],
      }),
    ]);
    const b = message([
      record({
        recordType: 'smart-poster',
        data: undefined,
        toRecords: () => [nested, nested],
      }),
    ]);
    expect(() => assertWebNDEFMessagesEqual(a, b)).toThrow(
      'nested record count mismatch',
    );
  });

  test('fails when a nested record itself differs', () => {
    const a = message([
      record({
        recordType: 'smart-poster',
        data: undefined,
        toRecords: () => [record({recordType: 'url'})],
      }),
    ]);
    const b = message([
      record({
        recordType: 'smart-poster',
        data: undefined,
        toRecords: () => [record({recordType: 'text'})],
      }),
    ]);
    expect(() => assertWebNDEFMessagesEqual(a, b)).toThrow(
      'recordType mismatch',
    );
  });
});
