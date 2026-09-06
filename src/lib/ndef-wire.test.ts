import {
  base64ToBytes,
  bytesToBase64,
  bytesToString,
  decodeWireRecord,
  encodeWireRecord,
  stringToBytes,
  TNF,
} from './ndef-wire';

describe('base64 <-> bytes', () => {
  test('round-trips arbitrary byte lengths (0,1,2,3 mod 3)', () => {
    for (const len of [0, 1, 2, 3, 4, 5, 6, 10]) {
      const bytes = new Uint8Array(len).map((_, i) => i * 7 + 1);
      const b64 = bytesToBase64(bytes);
      expect(base64ToBytes(b64)).toEqual(bytes);
    }
  });

  test('empty input round-trips to empty', () => {
    expect(bytesToBase64(new Uint8Array(0))).toBe('');
    expect(base64ToBytes('')).toEqual(new Uint8Array(0));
  });

  test('base64ToBytes rejects malformed input', () => {
    expect(() => base64ToBytes('a')).toThrow('malformed base64 input');
  });

  test('base64ToBytes rejects a 4-char quad with c2 undefined but c3 set (regression: finding #6)', () => {
    // Without the c2-undefined guard the decoder would compute
    // ((undefined & 0x3) << 6) | c3 — a NaN-tainted byte that masks
    // payload corruption. It must instead raise the same error other
    // malformed shapes do.
    //
    // 'AB!D' after stripping '=': c2=undefined (lookup miss on '!'),
    // c3=BASE64_LOOKUP['D']. Triggers the new guard.
    expect(() => base64ToBytes('AB!D')).toThrow('malformed base64 input');
    expect(() => base64ToBytes('AAAAA')).toThrow('malformed base64 input');
  });

  test('base64ToBytes accepts the trailing 2-char quad (single byte with == pad)', () => {
    // 'AB==' has length 4: c0='A', c1='B', c2=undefined (was '='),
    // c3=undefined (was '=') — both are legitimately undefined after
    // stripping '=' chars, which is the normal path the decoder handles.
    expect(base64ToBytes('AB==')).toEqual(new Uint8Array([0x00]));
    expect(base64ToBytes('AQ==')).toEqual(new Uint8Array([0x01]));
  });

  test('string <-> bytes round trip, including multi-byte UTF-8', () => {
    const str = 'hello, éè 中文';
    expect(bytesToString(stringToBytes(str))).toBe(str);
  });

  test('stringToBytes/bytesToString are stateless across repeated calls (TextEncoder/TextDecoder caching)', () => {
    // Both helpers cache a shared TextEncoder/TextDecoder. Verify that
    // repeated calls don't leak state — e.g. a streaming TextDecoder
    // carrying an unterminated multi-byte sequence from a prior chunk
    // would corrupt a later, unrelated decode.
    const a = stringToBytes('hello');
    const b = stringToBytes('中文');
    const c = stringToBytes('hello');
    expect(a).toEqual(c);
    expect(bytesToString(a)).toBe('hello');
    expect(bytesToString(b)).toBe('中文');
    expect(bytesToString(a)).toBe('hello');
  });

  test('cached TextEncoder/TextDecoder still round-trip multi-byte UTF-8', () => {
    // Behavior pin for the cached-encoder perf optimization (#3): the
    // module-scope singleton must continue to handle every code point,
    // not just ASCII, after the singleton was introduced.
    for (const s of [
      '',
      'hello',
      '中文',
      'emoji 🦊 café',
      '\u0000\u00ff\ufffd',
    ]) {
      expect(bytesToString(stringToBytes(s))).toBe(s);
    }
  });

  test('bytesToBase64 matches btoa(String.fromCharCode) for arbitrary byte inputs', () => {
    // Behavior pin for the string-array-then-join perf rewrite (#4): the
    // output must remain byte-identical to the btoa reference for every
    // input length (0, 1, 2, 3 mod 3) — including inputs containing
    // bytes that would coerce oddly through String.fromCharCode if the
    // implementation tried to be clever.
    for (const len of [0, 1, 2, 3, 4, 5, 6, 10, 100]) {
      const bytes = new Uint8Array(len).map((_, i) => (i * 37 + 11) & 0xff);
      const expected = btoa(String.fromCharCode(...bytes));
      expect(bytesToBase64(bytes)).toBe(expected);
    }
  });

  test('base64ToBytes accepts bytesToBase64 output for every length class', () => {
    // Pins the inverse property — if either side drifts the other is
    // caught here. Companion to the btoa pin above.
    for (const len of [0, 1, 2, 3, 4, 5, 6, 10, 100]) {
      const bytes = new Uint8Array(len).map((_, i) => (i * 53 + 7) & 0xff);
      expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
    }
  });

  test('base64ToBytes output is a single Uint8Array allocation', () => {
    // Pins the perf #1 single-allocation rewrite: the result must be a
    // Uint8Array (not a number[] or any other iterable), and it must
    // share identity across calls (the function returns fresh arrays,
    // but the implementation should never allocate an intermediate
    // number[] that gets wrapped — a snapshot with toHaveLength on
    // toString would catch that). Here we assert the type and contents.
    const out = base64ToBytes('AQID');
    expect(out).toBeInstanceOf(Uint8Array);
    expect(Array.from(out)).toEqual([1, 2, 3]);
  });
});

describe('encodeWireRecord / decodeWireRecord', () => {
  test('round trips a well-known text-type record', () => {
    const bytes = {
      tnf: TNF.WELL_KNOWN,
      type: stringToBytes('T'),
      id: stringToBytes('id1'),
      payload: stringToBytes('hello'),
    };
    const wire = encodeWireRecord(bytes);
    expect(wire).toEqual({
      tnf: 0x01,
      type: bytesToBase64(stringToBytes('T')),
      id: bytesToBase64(stringToBytes('id1')),
      payload: bytesToBase64(stringToBytes('hello')),
    });
    expect(decodeWireRecord(wire)).toEqual(bytes);
  });

  test('rejects invalid TNF on encode', () => {
    expect(() =>
      encodeWireRecord({
        tnf: 8,
        type: new Uint8Array(0),
        id: new Uint8Array(0),
        payload: new Uint8Array(0),
      }),
    ).toThrow('invalid TNF value');
    expect(() =>
      encodeWireRecord({
        tnf: -1,
        type: new Uint8Array(0),
        id: new Uint8Array(0),
        payload: new Uint8Array(0),
      }),
    ).toThrow('invalid TNF value');
    expect(() =>
      encodeWireRecord({
        tnf: 1.5,
        type: new Uint8Array(0),
        id: new Uint8Array(0),
        payload: new Uint8Array(0),
      }),
    ).toThrow('invalid TNF value');
  });

  test('rejects invalid TNF on decode', () => {
    expect(() =>
      decodeWireRecord({tnf: 9, type: '', id: '', payload: ''}),
    ).toThrow('invalid TNF value');
  });
});
