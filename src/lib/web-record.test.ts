/**
 * Codec tests for web-record.ts (§6a): NDEFRecordInit/NDEFMessageInit
 * validation/coercion and the write()-side NDEFMessageSource coercion,
 * including malformed-input error-name assertions (§8) and vectors ported
 * from the WPT record/message constructor tests' intent (§5e/§6a) — exact
 * TypeError/SyntaxError shapes for bad recordType/data.
 */
import {base64ToBytes, bytesToString} from './ndef-wire';
import {coerceMessageSource} from './web-record';

describe('coerceMessageSource: string', () => {
  test('a bare string is always encoded as a single "text" record, never a URL', () => {
    const [wire] = coerceMessageSource('hello world');
    // TNF 0x01 (WELL_KNOWN) + type "T" is the text RTD wire signature.
    expect(wire.tnf).toBe(0x01);
    expect(base64ToBytes(wire.type)).toEqual(new Uint8Array([0x54])); // "T"
  });

  test('a string that looks like a URL is still encoded as text (spec-defined, §2)', () => {
    const [wire] = coerceMessageSource('https://example.com');
    expect(base64ToBytes(wire.type)).toEqual(new Uint8Array([0x54])); // "T", not "U"
  });
});

describe('coerceMessageSource: BufferSource', () => {
  test('an ArrayBuffer is encoded as a mime record with a generic media type', () => {
    const buf = new Uint8Array([1, 2, 3]).buffer;
    const [wire] = coerceMessageSource(buf);
    expect(wire.tnf).toBe(0x02); // MIME_MEDIA
    expect(bytesToString(base64ToBytes(wire.payload))).toBe('');
  });

  test('a typed array (e.g. Uint8Array) is accepted as a BufferSource', () => {
    const view = new Uint8Array([9, 9]);
    const [wire] = coerceMessageSource(view);
    expect(wire.tnf).toBe(0x02);
  });

  test('a DataView (an ArrayBufferView) is accepted as a BufferSource', () => {
    const buf = new ArrayBuffer(4);
    const view = new DataView(buf);
    view.setUint8(0, 42);
    const [wire] = coerceMessageSource(view);
    expect(wire.tnf).toBe(0x02);
  });

  test('a partial view (byteOffset/byteLength) is respected, not the whole buffer', () => {
    const buf = new Uint8Array([0xaa, 1, 2, 3, 0xbb]).buffer;
    const view = new Uint8Array(buf, 1, 3);
    const [wire] = coerceMessageSource(view);
    expect(base64ToBytes(wire.payload)).toEqual(new Uint8Array([1, 2, 3]));
  });
});

describe('coerceMessageSource: NDEFMessageInit', () => {
  test('encodes each record in order', () => {
    const wires = coerceMessageSource({
      records: [
        {recordType: 'text', data: 'a'},
        {recordType: 'url', data: 'https://example.com'},
      ],
    });
    expect(wires).toHaveLength(2);
    expect(wires[0].tnf).toBe(0x01);
    expect(wires[1].tnf).toBe(0x01);
  });

  test('rejects an empty records array with SyntaxError', () => {
    expect(() => coerceMessageSource({records: []})).toThrow(
      expect.objectContaining({name: 'SyntaxError'}),
    );
  });

  test('rejects a non-string/BufferSource/NDEFMessageInit value with SyntaxError', () => {
    expect(() => coerceMessageSource(42 as never)).toThrow(
      expect.objectContaining({name: 'SyntaxError'}),
    );
  });
});

describe('NDEFRecordInit validation', () => {
  test('rejects a missing recordType with SyntaxError', () => {
    expect(() => coerceMessageSource({records: [{} as never]})).toThrow(
      expect.objectContaining({name: 'SyntaxError'}),
    );
  });

  test('rejects an empty-string recordType with SyntaxError', () => {
    expect(() => coerceMessageSource({records: [{recordType: ''}]})).toThrow(
      expect.objectContaining({name: 'SyntaxError'}),
    );
  });

  test('rejects a non-object record with SyntaxError', () => {
    expect(() => coerceMessageSource({records: [null as never]})).toThrow(
      expect.objectContaining({name: 'SyntaxError'}),
    );
  });

  test('rejects "mime" without mediaType with SyntaxError', () => {
    expect(() =>
      coerceMessageSource({records: [{recordType: 'mime', data: 'x'}]}),
    ).toThrow(expect.objectContaining({name: 'SyntaxError'}));
  });

  test('rejects an unsupported encoding value with SyntaxError', () => {
    expect(() =>
      coerceMessageSource({
        records: [{recordType: 'text', data: 'x', encoding: 'ascii'}],
      }),
    ).toThrow(expect.objectContaining({name: 'SyntaxError'}));
  });

  test('rejects encoding on a non-text record with SyntaxError', () => {
    expect(() =>
      coerceMessageSource({
        records: [{recordType: 'url', data: 'https://x', encoding: 'utf-8'}],
      }),
    ).toThrow(expect.objectContaining({name: 'SyntaxError'}));
  });

  test('rejects lang on a non-text record with SyntaxError', () => {
    expect(() =>
      coerceMessageSource({
        records: [{recordType: 'url', data: 'https://x', lang: 'en'}],
      }),
    ).toThrow(expect.objectContaining({name: 'SyntaxError'}));
  });

  test('accepts a record with no data (defaults to empty bytes)', () => {
    const [wire] = coerceMessageSource({records: [{recordType: 'empty'}]});
    expect(base64ToBytes(wire.payload)).toEqual(new Uint8Array(0));
  });

  test('rejects data that is not string/BufferSource/NDEFMessageInit with SyntaxError', () => {
    expect(() =>
      coerceMessageSource({
        records: [{recordType: 'unknown', data: 12345 as never}],
      }),
    ).toThrow(expect.objectContaining({name: 'SyntaxError'}));
  });

  test('rejects a non-smart-poster record whose data is an NDEFMessageInit', () => {
    expect(() =>
      coerceMessageSource({
        records: [
          {
            recordType: 'text',
            data: {records: [{recordType: 'text', data: 'x'}]},
          },
        ],
      }),
    ).toThrow(expect.objectContaining({name: 'SyntaxError'}));
  });

  test('a codec-level encode error is wrapped as SyntaxError (e.g. mime record whose encoder rejects)', () => {
    // "mime" already validated to have mediaType at this layer; force the
    // underlying encoder to throw via an over-long language code path
    // instead, since it's the one well-known-records.ts error this layer
    // doesn't pre-validate for.
    expect(() =>
      coerceMessageSource({
        records: [{recordType: 'text', data: 'x', lang: 'x'.repeat(64)}],
      }),
    ).toThrow(expect.objectContaining({name: 'SyntaxError'}));
  });
});

describe('smart-poster records', () => {
  test('encodes a smart-poster with nested url + text records and round trips via decode', () => {
    const [wire] = coerceMessageSource({
      records: [
        {
          recordType: 'smart-poster',
          data: {
            records: [
              {recordType: 'url', data: 'https://example.com'},
              {recordType: 'text', data: 'Example', lang: 'en'},
            ],
          },
        },
      ],
    });
    expect(wire.tnf).toBe(0x01); // WELL_KNOWN
    expect(bytesToString(base64ToBytes(wire.type))).toBe('Sp');

    // Decode via well-known-records.ts to confirm the framing round trips.
    const {decodeRecord} = jest.requireActual(
      './well-known-records',
    ) as typeof import('./well-known-records');
    const decoded = decodeRecord(wire);
    expect(decoded.recordType).toBe('smart-poster');
    expect(decoded.toRecordsWire).toHaveLength(2);
    expect(decodeRecord(decoded.toRecordsWire![0]).recordType).toBe('url');
    expect(decodeRecord(decoded.toRecordsWire![1]).recordType).toBe('text');
  });

  test('encodes a smart-poster preserving its own id', () => {
    const [wire] = coerceMessageSource({
      records: [
        {
          recordType: 'smart-poster',
          id: 'poster-1',
          data: {records: [{recordType: 'url', data: 'https://x'}]},
        },
      ],
    });
    expect(bytesToString(base64ToBytes(wire.id))).toBe('poster-1');
  });

  test('rejects a smart-poster whose data is not an NDEFMessageInit', () => {
    expect(() =>
      coerceMessageSource({
        records: [{recordType: 'smart-poster', data: 'not-a-message'}],
      }),
    ).toThrow(expect.objectContaining({name: 'SyntaxError'}));
  });

  test('rejects a smart-poster with an empty nested-records array (regression: finding #5)', () => {
    // Mirrors the same-shape guard coerceMessageSource() already applies to
    // the top-level NDEFMessageInit: an empty smart-poster payload produces
    // a zero-record NDEF message that no conformant reader expects.
    expect(() =>
      coerceMessageSource({
        records: [{recordType: 'smart-poster', data: {records: []}}],
      }),
    ).toThrow(expect.objectContaining({name: 'SyntaxError'}));
  });

  test('encodes a smart-poster with a long-form (>255 byte payload) nested record', () => {
    const longText = 'x'.repeat(300);
    const [wire] = coerceMessageSource({
      records: [
        {
          recordType: 'smart-poster',
          data: {records: [{recordType: 'text', data: longText, lang: 'en'}]},
        },
      ],
    });
    const {decodeRecord} = jest.requireActual(
      './well-known-records',
    ) as typeof import('./well-known-records');
    const decoded = decodeRecord(wire);
    expect(decoded.toRecordsWire).toHaveLength(1);
    const nested = decodeRecord(decoded.toRecordsWire![0]);
    expect(bytesToString(nested.data)).toBe(longText);
  });

  test('encodes a smart-poster with a nested record that itself has an id (IL bit)', () => {
    const [wire] = coerceMessageSource({
      records: [
        {
          recordType: 'smart-poster',
          data: {
            records: [{recordType: 'url', id: 'nested-id', data: 'https://x'}],
          },
        },
      ],
    });
    const {decodeRecord} = jest.requireActual(
      './well-known-records',
    ) as typeof import('./well-known-records');
    const decoded = decodeRecord(wire);
    const nested = decodeRecord(decoded.toRecordsWire![0]);
    expect(nested.id).toBe('nested-id');
  });

  test('rejects a smart-poster with no data at all', () => {
    expect(() =>
      coerceMessageSource({records: [{recordType: 'smart-poster'}]}),
    ).toThrow(expect.objectContaining({name: 'SyntaxError'}));
  });

  test('enforces the nesting recursion limit with SyntaxError (WPT recursion-limit intent, §5e/§6a)', () => {
    // Build a smart-poster nested 40 levels deep (exceeds MAX_RECURSION_DEPTH = 32).
    let inner: {recordType: string; data?: unknown} = {
      recordType: 'url',
      data: 'https://x',
    };
    for (let i = 0; i < 40; i++) {
      inner = {recordType: 'smart-poster', data: {records: [inner]}};
    }
    expect(() => coerceMessageSource({records: [inner as never]})).toThrow(
      expect.objectContaining({name: 'SyntaxError'}),
    );
  });
});
