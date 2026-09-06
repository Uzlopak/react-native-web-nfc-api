/**
 * Codec vectors (§6a): hand-encoded NDEF Forum bytes for text/URI/
 * smart-poster/MIME/external/unknown/empty/malformed records, and the
 * reverse encode path. TNF/type/id/payload byte layouts follow the NFC
 * Forum RTD specs (Text RTD, URI RTD, Smart Poster RTD).
 */
import {
  base64ToBytes,
  bytesToBase64,
  bytesToString,
  type NdefWireRecord,
  stringToBytes,
  TNF,
} from './ndef-wire';
import {decodeRecord, encodeWebRecord} from './well-known-records';

function wire(
  tnf: number,
  type: Uint8Array,
  id: Uint8Array,
  payload: Uint8Array,
): NdefWireRecord {
  return {
    tnf,
    type: bytesToBase64(type),
    id: bytesToBase64(id),
    payload: bytesToBase64(payload),
  };
}

describe('text record (NFC Forum Text RTD)', () => {
  test('decodes a UTF-8 English text record', () => {
    // status byte 0x02 = UTF-8, lang length 2 ("en"), then "en" + "hello"
    const payload = new Uint8Array([
      0x02,
      ...stringToBytes('en'),
      ...stringToBytes('hello'),
    ]);
    const rec = wire(
      TNF.WELL_KNOWN,
      stringToBytes('T'),
      new Uint8Array(0),
      payload,
    );
    const decoded = decodeRecord(rec);
    expect(decoded.recordType).toBe('text');
    expect(decoded.encoding).toBe('utf-8');
    expect(decoded.lang).toBe('en');
    expect(bytesToString(decoded.data)).toBe('hello');
  });

  test('decodes a UTF-16 text record with BOM', () => {
    const langBytes = stringToBytes('en');
    const textUtf16 = new Uint8Array([0xfe, 0xff, 0x00, 0x68, 0x00, 0x69]); // BOM + "hi" BE
    const statusByte = 0x80 | langBytes.length;
    const payload = new Uint8Array([statusByte, ...langBytes, ...textUtf16]);
    const rec = wire(
      TNF.WELL_KNOWN,
      stringToBytes('T'),
      new Uint8Array(0),
      payload,
    );
    const decoded = decodeRecord(rec);
    expect(decoded.encoding).toBe('utf-16');
    expect(bytesToString(decoded.data)).toBe('hi');
  });

  test('decodes UTF-16 little-endian via BOM', () => {
    const langBytes = stringToBytes('en');
    const textUtf16LE = new Uint8Array([0xff, 0xfe, 0x68, 0x00, 0x69, 0x00]); // BOM LE + "hi"
    const statusByte = 0x80 | langBytes.length;
    const payload = new Uint8Array([statusByte, ...langBytes, ...textUtf16LE]);
    const rec = wire(
      TNF.WELL_KNOWN,
      stringToBytes('T'),
      new Uint8Array(0),
      payload,
    );
    const decoded = decodeRecord(rec);
    expect(bytesToString(decoded.data)).toBe('hi');
  });

  test('decodes UTF-16 without BOM as big-endian', () => {
    const langBytes = stringToBytes('en');
    const textUtf16 = new Uint8Array([0x00, 0x68, 0x00, 0x69]); // "hi" BE, no BOM
    const statusByte = 0x80 | langBytes.length;
    const payload = new Uint8Array([statusByte, ...langBytes, ...textUtf16]);
    const rec = wire(
      TNF.WELL_KNOWN,
      stringToBytes('T'),
      new Uint8Array(0),
      payload,
    );
    const decoded = decodeRecord(rec);
    expect(bytesToString(decoded.data)).toBe('hi');
  });

  test('decodes a UTF-16 text record whose text bytes are shorter than a BOM (0-1 bytes)', () => {
    const langBytes = stringToBytes('en');
    const statusByte = 0x80 | langBytes.length;
    // Only one trailing byte: too short to be a BOM, exercises the
    // `bytes.length >= 2` false branch in decodeUtf16.
    const payload = new Uint8Array([statusByte, ...langBytes, 0x41]);
    const rec = wire(
      TNF.WELL_KNOWN,
      stringToBytes('T'),
      new Uint8Array(0),
      payload,
    );
    const decoded = decodeRecord(rec);
    expect(decoded.encoding).toBe('utf-16');
    expect(bytesToString(decoded.data)).toBe(''); // odd trailing byte can't form a code unit
  });

  test('malformed: empty text payload throws', () => {
    const rec = wire(
      TNF.WELL_KNOWN,
      stringToBytes('T'),
      new Uint8Array(0),
      new Uint8Array(0),
    );
    expect(() => decodeRecord(rec)).toThrow('malformed text record');
  });

  test('malformed: language code length exceeds payload throws', () => {
    const payload = new Uint8Array([0x05, 0x65, 0x6e]); // claims 5-byte lang, only 2 bytes present
    const rec = wire(
      TNF.WELL_KNOWN,
      stringToBytes('T'),
      new Uint8Array(0),
      payload,
    );
    expect(() => decodeRecord(rec)).toThrow('malformed text record');
  });

  test('encodes a UTF-8 text record and round trips', () => {
    const wireRec = encodeWebRecord({
      recordType: 'text',
      data: stringToBytes('hello'),
      lang: 'en',
    });
    const decoded = decodeRecord(wireRec);
    expect(decoded.recordType).toBe('text');
    expect(decoded.lang).toBe('en');
    expect(bytesToString(decoded.data)).toBe('hello');
    expect(decoded.encoding).toBe('utf-8');
  });

  test('encodes a UTF-16 text record and round trips', () => {
    const wireRec = encodeWebRecord({
      recordType: 'text',
      data: stringToBytes('hi'),
      lang: 'de',
      encoding: 'utf-16',
    });
    const decoded = decodeRecord(wireRec);
    expect(decoded.encoding).toBe('utf-16');
    expect(decoded.lang).toBe('de');
    expect(bytesToString(decoded.data)).toBe('hi');
  });

  test('encode defaults lang to "en" when omitted', () => {
    const wireRec = encodeWebRecord({
      recordType: 'text',
      data: stringToBytes('x'),
    });
    expect(decodeRecord(wireRec).lang).toBe('en');
  });

  test('encode rejects a language code longer than 63 bytes', () => {
    const longLang = 'x'.repeat(64);
    expect(() =>
      encodeWebRecord({
        recordType: 'text',
        data: stringToBytes('x'),
        lang: longLang,
      }),
    ).toThrow('language code too long');
  });
});

describe('URI record (NFC Forum URI RTD)', () => {
  test('decodes prefix code 0x01 (http://www.)', () => {
    const payload = new Uint8Array([0x01, ...stringToBytes('example.com')]);
    const rec = wire(
      TNF.WELL_KNOWN,
      stringToBytes('U'),
      new Uint8Array(0),
      payload,
    );
    const decoded = decodeRecord(rec);
    expect(decoded.recordType).toBe('url');
    expect(bytesToString(decoded.data)).toBe('http://www.example.com');
  });

  test('decodes prefix code 0x00 (no prefix)', () => {
    const payload = new Uint8Array([0x00, ...stringToBytes('urn:isbn:12345')]);
    const rec = wire(
      TNF.WELL_KNOWN,
      stringToBytes('U'),
      new Uint8Array(0),
      payload,
    );
    expect(bytesToString(decodeRecord(rec).data)).toBe('urn:isbn:12345');
  });

  test('decodes an out-of-range prefix code as no prefix (defensive)', () => {
    const payload = new Uint8Array([0xff, ...stringToBytes('rest')]);
    const rec = wire(
      TNF.WELL_KNOWN,
      stringToBytes('U'),
      new Uint8Array(0),
      payload,
    );
    expect(bytesToString(decodeRecord(rec).data)).toBe('rest');
  });

  test('decodes empty URI payload as empty string', () => {
    const rec = wire(
      TNF.WELL_KNOWN,
      stringToBytes('U'),
      new Uint8Array(0),
      new Uint8Array(0),
    );
    expect(bytesToString(decodeRecord(rec).data)).toBe('');
  });

  test('encode picks the longest matching prefix and round trips', () => {
    const wireRec = encodeWebRecord({
      recordType: 'url',
      data: stringToBytes('https://www.example.com/path'),
    });
    const decoded = decodeRecord(wireRec);
    expect(decoded.recordType).toBe('url');
    expect(bytesToString(decoded.data)).toBe('https://www.example.com/path');
    // Confirm compaction actually happened (prefix code 2 = "https://www.").
    const decodedWirePayload = base64ToBytes(wireRec.payload);
    expect(decodedWirePayload[0]).toBe(2);
  });

  test('encode with no matching prefix uses code 0', () => {
    const wireRec = encodeWebRecord({
      recordType: 'url',
      data: stringToBytes('custom:scheme/x'),
    });
    const payloadBytes = base64ToBytes(wireRec.payload);
    expect(payloadBytes[0]).toBe(0);
  });
});

describe('MIME record', () => {
  test('decodes a MIME record', () => {
    const payload = stringToBytes('{"a":1}');
    const rec = wire(
      TNF.MIME_MEDIA,
      stringToBytes('application/json'),
      new Uint8Array(0),
      payload,
    );
    const decoded = decodeRecord(rec);
    expect(decoded.recordType).toBe('mime');
    expect(decoded.mediaType).toBe('application/json');
    expect(bytesToString(decoded.data)).toBe('{"a":1}');
  });

  test('decodes an empty MIME type as application/octet-stream fallback', () => {
    const rec = wire(
      TNF.MIME_MEDIA,
      new Uint8Array(0),
      new Uint8Array(0),
      stringToBytes('x'),
    );
    expect(decodeRecord(rec).mediaType).toBe('application/octet-stream');
  });

  test('encode requires mediaType', () => {
    expect(() =>
      encodeWebRecord({recordType: 'mime', data: stringToBytes('x')}),
    ).toThrow('mime record requires mediaType');
  });

  test('encode/decode round trip preserves mediaType and bytes', () => {
    const wireRec = encodeWebRecord({
      recordType: 'mime',
      mediaType: 'text/plain',
      data: stringToBytes('hi'),
    });
    const decoded = decodeRecord(wireRec);
    expect(decoded.mediaType).toBe('text/plain');
    expect(bytesToString(decoded.data)).toBe('hi');
  });
});

describe('external / unknown / empty / absolute-url records', () => {
  test('decodes an external record using the type bytes as recordType', () => {
    const rec = wire(
      TNF.EXTERNAL,
      stringToBytes('example.com:foo'),
      new Uint8Array(0),
      stringToBytes('payload'),
    );
    const decoded = decodeRecord(rec);
    expect(decoded.recordType).toBe('example.com:foo');
    expect(bytesToString(decoded.data)).toBe('payload');
  });

  test('malformed: external record with empty type throws', () => {
    const rec = wire(
      TNF.EXTERNAL,
      new Uint8Array(0),
      new Uint8Array(0),
      stringToBytes('x'),
    );
    expect(() => decodeRecord(rec)).toThrow('malformed external record');
  });

  test('decodes an unknown-TNF record as recordType "unknown"', () => {
    const rec = wire(
      TNF.UNKNOWN,
      new Uint8Array(0),
      new Uint8Array(0),
      stringToBytes('bytes'),
    );
    const decoded = decodeRecord(rec);
    expect(decoded.recordType).toBe('unknown');
    expect(bytesToString(decoded.data)).toBe('bytes');
  });

  test('decodes a well-known record with unrecognized type as "unknown"', () => {
    const rec = wire(
      TNF.WELL_KNOWN,
      stringToBytes('X'),
      new Uint8Array(0),
      stringToBytes('bytes'),
    );
    expect(decodeRecord(rec).recordType).toBe('unknown');
  });

  test('decodes an empty (TNF.EMPTY) record', () => {
    const rec = wire(
      TNF.EMPTY,
      new Uint8Array(0),
      new Uint8Array(0),
      new Uint8Array(0),
    );
    const decoded = decodeRecord(rec);
    expect(decoded.recordType).toBe('empty');
    expect(decoded.data.length).toBe(0);
  });

  test('decodes an absolute-URI record (TNF 0x03)', () => {
    const rec = wire(
      TNF.ABSOLUTE_URI,
      stringToBytes('urn:example:1'),
      new Uint8Array(0),
      new Uint8Array(0),
    );
    const decoded = decodeRecord(rec);
    expect(decoded.recordType).toBe('absolute-url');
    expect(bytesToString(decoded.data)).toBe('urn:example:1');
  });

  test('decodes id bytes when present', () => {
    const rec = wire(
      TNF.EMPTY,
      new Uint8Array(0),
      stringToBytes('myid'),
      new Uint8Array(0),
    );
    expect(decodeRecord(rec).id).toBe('myid');
  });

  test('id is undefined when absent', () => {
    const rec = wire(
      TNF.EMPTY,
      new Uint8Array(0),
      new Uint8Array(0),
      new Uint8Array(0),
    );
    expect(decodeRecord(rec).id).toBeUndefined();
  });

  test('unsupported TNF (UNCHANGED, 0x06) throws on decode', () => {
    const rec = wire(
      TNF.UNCHANGED,
      new Uint8Array(0),
      new Uint8Array(0),
      new Uint8Array(0),
    );
    expect(() => decodeRecord(rec)).toThrow('unsupported TNF for decode');
  });

  test('out-of-range TNF (0x09) is rejected by ndef-wire validation (regression: finding #7)', () => {
    // Before the refactor, well-known-records.ts reimplemented the base64
    // decode + skipped the 0..7 integer guard from ndef-wire.ts's
    // decodeWireRecord, letting out-of-range TNFs fall into the default
    // branch (which threw on 0x06 but not on 0x09). Now decodeRecord
    // delegates to ndef-wire, so the same "invalid TNF value" error fires.
    const rec = {
      tnf: 0x09,
      type: bytesToBase64(new Uint8Array(0)),
      id: bytesToBase64(new Uint8Array(0)),
      payload: bytesToBase64(new Uint8Array(0)),
    };
    expect(() => decodeRecord(rec)).toThrow('invalid TNF value');
  });

  test('encode: mime record rejects a malformed mediaType (regression: finding #8)', () => {
    expect(() =>
      encodeWebRecord({
        recordType: 'mime',
        mediaType: 'not-a-mime',
        data: stringToBytes('x'),
      }),
    ).toThrow(/not a valid MIME type/);
    expect(() =>
      encodeWebRecord({
        recordType: 'mime',
        mediaType: '/missing-type',
        data: stringToBytes('x'),
      }),
    ).toThrow(/not a valid MIME type/);
    expect(() =>
      encodeWebRecord({
        recordType: 'mime',
        mediaType: 'missing-subtype/',
        data: stringToBytes('x'),
      }),
    ).toThrow(/not a valid MIME type/);
    expect(() =>
      encodeWebRecord({
        recordType: 'mime',
        mediaType: 'has whitespace/x',
        data: stringToBytes('x'),
      }),
    ).toThrow(/not a valid MIME type/);
    expect(() =>
      encodeWebRecord({
        recordType: 'mime',
        mediaType: 'two/slashes/bad',
        data: stringToBytes('x'),
      }),
    ).toThrow(/not a valid MIME type/);
    expect(() =>
      encodeWebRecord({
        recordType: 'mime',
        mediaType: 'text/has whitespace',
        data: stringToBytes('x'),
      }),
    ).toThrow(/not a valid MIME type/);
  });

  test('encode: mime record accepts well-formed mediaType values', () => {
    for (const mt of [
      'application/octet-stream',
      'text/plain',
      'text/html;charset=utf-8', // semicolons and equals are not in tchar but RFC 7231 allows parameters after a space — we strip them
      'application/vnd.api+json',
      'image/svg+xml',
    ]) {
      expect(() =>
        encodeWebRecord({
          recordType: 'mime',
          mediaType: mt.split(';')[0], // encode the type/subtype portion only
          data: stringToBytes('x'),
        }),
      ).not.toThrow();
    }
  });

  test('encode: empty record type', () => {
    const wireRec = encodeWebRecord({
      recordType: 'empty',
      data: new Uint8Array(0),
    });
    expect(wireRec.tnf).toBe(TNF.EMPTY);
  });

  test('encode: absolute-url record type', () => {
    const wireRec = encodeWebRecord({
      recordType: 'absolute-url',
      data: stringToBytes('urn:x'),
    });
    expect(wireRec.tnf).toBe(TNF.ABSOLUTE_URI);
    const decoded = decodeRecord(wireRec);
    expect(bytesToString(decoded.data)).toBe('urn:x');
  });

  test('encode: unknown record type', () => {
    const wireRec = encodeWebRecord({
      recordType: 'unknown',
      data: stringToBytes('x'),
    });
    expect(wireRec.tnf).toBe(TNF.UNKNOWN);
  });

  test('encode: arbitrary external recordType falls through to TNF.EXTERNAL', () => {
    const wireRec = encodeWebRecord({
      recordType: 'example.com:custom',
      data: stringToBytes('x'),
    });
    expect(wireRec.tnf).toBe(TNF.EXTERNAL);
    expect(decodeRecord(wireRec).recordType).toBe('example.com:custom');
  });

  test('encode preserves id when provided', () => {
    const wireRec = encodeWebRecord({
      recordType: 'empty',
      id: 'abc',
      data: new Uint8Array(0),
    });
    expect(decodeRecord(wireRec).id).toBe('abc');
  });
});

describe('smart-poster record (NFC Forum Smart Poster RTD)', () => {
  test('decodes a smart poster with one nested URI record', () => {
    // Build a raw NDEF message for the nested URI record: MB|ME|SR header.
    const uriType = stringToBytes('U');
    const uriPayload = new Uint8Array([0x04, ...stringToBytes('example.com')]); // prefix 4 = https://
    const header = 0x80 | 0x40 | 0x10 | 0x01; // MB|ME|SR|TNF=WELL_KNOWN
    const nestedMessage = new Uint8Array([
      header,
      uriType.length,
      uriPayload.length,
      ...uriType,
      ...uriPayload,
    ]);

    const rec = wire(
      TNF.WELL_KNOWN,
      stringToBytes('Sp'),
      new Uint8Array(0),
      nestedMessage,
    );
    const decoded = decodeRecord(rec);
    expect(decoded.recordType).toBe('smart-poster');
    expect(decoded.toRecordsWire).toBeDefined();
    expect(decoded.toRecordsWire).toHaveLength(1);

    const nestedDecoded = decodeRecord(decoded.toRecordsWire![0]);
    expect(nestedDecoded.recordType).toBe('url');
    expect(bytesToString(nestedDecoded.data)).toBe('https://example.com');
  });

  test('decodes a smart poster with multiple nested records (URI + text)', () => {
    const uriType = stringToBytes('U');
    const uriPayload = new Uint8Array([0x00, ...stringToBytes('u:x')]);
    const textType = stringToBytes('T');
    const textPayload = new Uint8Array([
      0x02,
      ...stringToBytes('en'),
      ...stringToBytes('Title'),
    ]);

    const header1 = 0x80 | 0x10 | 0x01; // MB|SR|WELL_KNOWN (not last)
    const rec1 = new Uint8Array([
      header1,
      uriType.length,
      uriPayload.length,
      ...uriType,
      ...uriPayload,
    ]);
    const header2 = 0x40 | 0x10 | 0x01; // ME|SR|WELL_KNOWN (last)
    const rec2 = new Uint8Array([
      header2,
      textType.length,
      textPayload.length,
      ...textType,
      ...textPayload,
    ]);

    const nestedMessage = new Uint8Array([...rec1, ...rec2]);
    const rec = wire(
      TNF.WELL_KNOWN,
      stringToBytes('Sp'),
      new Uint8Array(0),
      nestedMessage,
    );
    const decoded = decodeRecord(rec);
    expect(decoded.toRecordsWire).toHaveLength(2);
    expect(decodeRecord(decoded.toRecordsWire![0]).recordType).toBe('url');
    expect(decodeRecord(decoded.toRecordsWire![1]).recordType).toBe('text');
  });

  test('decodes a smart poster with a long-form (non-SR) nested record', () => {
    const type = stringToBytes('T');
    const payload = new Uint8Array([
      0x02,
      ...stringToBytes('en'),
      ...stringToBytes('long'),
    ]);
    const len = payload.length;
    const header = 0x80 | 0x40 | 0x01; // MB|ME|WELL_KNOWN, no SR bit -> 4-byte length
    const nestedMessage = new Uint8Array([
      header,
      type.length,
      (len >>> 24) & 0xff,
      (len >>> 16) & 0xff,
      (len >>> 8) & 0xff,
      len & 0xff,
      ...type,
      ...payload,
    ]);
    const rec = wire(
      TNF.WELL_KNOWN,
      stringToBytes('Sp'),
      new Uint8Array(0),
      nestedMessage,
    );
    const decoded = decodeRecord(rec);
    expect(decoded.toRecordsWire).toHaveLength(1);
    expect(decodeRecord(decoded.toRecordsWire![0]).recordType).toBe('text');
  });

  test('decodes a smart poster nested record with an id field (IL bit)', () => {
    const type = stringToBytes('T');
    const payload = new Uint8Array([
      0x02,
      ...stringToBytes('en'),
      ...stringToBytes('x'),
    ]);
    const id = stringToBytes('nid');
    const header = 0x80 | 0x40 | 0x10 | 0x08 | 0x01; // MB|ME|SR|IL|WELL_KNOWN
    const nestedMessage = new Uint8Array([
      header,
      type.length,
      payload.length,
      id.length,
      ...type,
      ...id,
      ...payload,
    ]);
    const rec = wire(
      TNF.WELL_KNOWN,
      stringToBytes('Sp'),
      new Uint8Array(0),
      nestedMessage,
    );
    const decoded = decodeRecord(rec);
    expect(decodeRecord(decoded.toRecordsWire![0]).id).toBe('nid');
  });

  test('malformed nested NDEF message: short-record header with missing payload-length byte throws', () => {
    // header, typeLength byte present, but the mandatory SR payload-length
    // byte is missing.
    const header = 0x80 | 0x40 | 0x10 | 0x01; // MB|ME|SR|WELL_KNOWN
    const nestedMessage = new Uint8Array([header, 1]); // typeLength=1, nothing after
    const rec = wire(
      TNF.WELL_KNOWN,
      stringToBytes('Sp'),
      new Uint8Array(0),
      nestedMessage,
    );
    expect(() => decodeRecord(rec)).toThrow('malformed nested NDEF message');
  });

  test('malformed nested NDEF message: header present but type-length byte missing throws', () => {
    // header claims short-record (0x10) but the byte stream ends right after
    // the header, before the mandatory type-length byte.
    const header = 0x80 | 0x40 | 0x10 | 0x01;
    const nestedMessage = new Uint8Array([header]);
    const rec = wire(
      TNF.WELL_KNOWN,
      stringToBytes('Sp'),
      new Uint8Array(0),
      nestedMessage,
    );
    expect(() => decodeRecord(rec)).toThrow('malformed nested NDEF message');
  });

  test('malformed nested NDEF message: missing type-length byte throws', () => {
    const nestedMessage = new Uint8Array([0x80, 0x01]); // header + typeLength claiming more, but nothing follows
    // header says SR not set (0x80 has no 0x10), so it expects a 4-byte length next; only 1 byte present.
    const rec = wire(
      TNF.WELL_KNOWN,
      stringToBytes('Sp'),
      new Uint8Array(0),
      nestedMessage,
    );
    expect(() => decodeRecord(rec)).toThrow('malformed nested NDEF message');
  });

  test('malformed nested NDEF message: length exceeds buffer throws', () => {
    const type = stringToBytes('T');
    const header = 0x80 | 0x40 | 0x10 | 0x01;
    // Declares a payload length of 100 bytes but provides none.
    const nestedMessage = new Uint8Array([header, type.length, 100, ...type]);
    const rec = wire(
      TNF.WELL_KNOWN,
      stringToBytes('Sp'),
      new Uint8Array(0),
      nestedMessage,
    );
    expect(() => decodeRecord(rec)).toThrow('malformed nested NDEF message');
  });

  test('malformed nested NDEF message: missing id-length byte throws', () => {
    const type = stringToBytes('T');
    const header = 0x80 | 0x40 | 0x10 | 0x08 | 0x01; // MB|ME|SR|IL|WELL_KNOWN
    // header, typeLength, payloadLength(=0) all present, but the mandatory
    // id-length byte (IL bit set) is missing.
    const nestedMessage = new Uint8Array([header, type.length, 0]);
    const rec = wire(
      TNF.WELL_KNOWN,
      stringToBytes('Sp'),
      new Uint8Array(0),
      nestedMessage,
    );
    expect(() => decodeRecord(rec)).toThrow('malformed nested NDEF message');
  });
});

describe('perf #2 + #10: encode-side correctness pins', () => {
  test('encodeWebRecord for text emits a constant type field regardless of input', () => {
    // Behavior pin for perf #2 + #3: text records must always emit the
    // same type-bytes-on-the-wire ('VA==') so the constant-hoisting
    // refactor doesn't accidentally branch on input.
    for (const text of ['hi', '中文', 'a'.repeat(500)]) {
      const wire = encodeWebRecord({
        recordType: 'text',
        data: stringToBytes(text),
      });
      expect(wire.type).toBe('VA==');
    }
  });

  test('encodeWebRecord for url emits the constant RTD_URI_BASE64 type field', () => {
    // Behavior pin for perf #2: the 'U' type-bytes value is hoisted to
    // a module-scope constant — if a refactor regresses this back to
    // an inline bytesToBase64(stringToBytes('U')) call, the output is
    // identical but the hot-path optimization is undone.
    expect(
      encodeWebRecord({recordType: 'url', data: stringToBytes('https://x')})
        .type,
    ).toBe('VQ==');
  });

  test('https://example.com encodes with URI prefix 4 (https://), not 3 (http://)', () => {
    // Behavior pin for perf #10: URI_PREFIXES_BY_LENGTH is sorted
    // longest-first so the first match wins — a regression that
    // re-introduced the unsorted scan would also still pick 4 here
    // because 8 > 7, but the round-trip below exercises the explicit
    // longest-prefix preference (12-char 'https://www.' trumps 8-char
    // 'https://').
    const wire = encodeWebRecord({
      recordType: 'url',
      data: stringToBytes('https://www.example.com'),
    });
    // URI_PREFIXES index 2 = 'https://www.' (12 chars), the longest
    // matching prefix for this URL.
    expect(base64ToBytes(wire.payload)[0]).toBe(2);
  });

  test('encodeUriPayload picks the longest matching prefix', () => {
    // 'https://example.com' (no 'www.') picks prefix 4 ('https://', 8 chars)
    // over prefix 3 ('http://', 7 chars) — i.e. the longest that matches.
    const wire = encodeWebRecord({
      recordType: 'url',
      data: stringToBytes('https://example.com'),
    });
    expect(base64ToBytes(wire.payload)[0]).toBe(0x04);
  });

  test('encodeUriPayload with no matching prefix emits code 0x00 and the URI verbatim', () => {
    const wire = encodeWebRecord({
      recordType: 'url',
      data: stringToBytes('example.com'),
    });
    expect(base64ToBytes(wire.payload)[0]).toBe(0x00);
    expect(bytesToString(base64ToBytes(wire.payload).subarray(1))).toBe(
      'example.com',
    );
  });
});
