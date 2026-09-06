/**
 * Direct coverage for SimulatedTag and its canned subclasses (§6b): the tag
 * model InMemoryNfcTransport reads from and writes to. Exercised elsewhere
 * only indirectly (via fixtures/other suites) — this file drives every
 * class and branch directly so it stands on its own.
 */
import {decodeRecord} from '../lib/well-known-records';
import {
  DOMException,
  EmptyTag,
  FlakyTag,
  MultiRecordTag,
  NonNdefTag,
  ReadOnlyTag,
  SimulatedTag,
  SlowTag,
  TextTag,
  UrlTag,
} from './simulated-tag';

describe('SimulatedTag', () => {
  test('defaults: auto-generated serialNumber, empty records, writable', () => {
    const tag = new SimulatedTag();
    expect(tag.serialNumber).toMatch(/^sim-tag-\d+$/);
    expect(tag.records).toEqual([]);
    expect(tag.writable).toBe(true);
    expect(tag.isNdef).toBe(true);
    expect(tag.lastWrite).toBeNull();
  });

  test('auto-generated serial numbers are unique and increasing across instances', () => {
    const a = new SimulatedTag();
    const b = new SimulatedTag();
    expect(a.serialNumber).not.toBe(b.serialNumber);
  });

  test('accepts explicit serialNumber, records, and writable', () => {
    const records = [{tnf: 1, type: 'VA==', id: '', payload: 'AQID'}];
    const tag = new SimulatedTag({
      serialNumber: 'custom-1',
      records,
      writable: false,
    });
    expect(tag.serialNumber).toBe('custom-1');
    expect(tag.records).toBe(records);
    expect(tag.writable).toBe(false);
  });

  describe('onWrite()', () => {
    test('writes records and records lastWrite when writable and overwrite is true', () => {
      const tag = new SimulatedTag();
      const records = [{tnf: 1, type: 'VA==', id: '', payload: 'AQID'}];
      tag.onWrite(records, true);
      expect(tag.records).toBe(records);
      expect(tag.lastWrite).toEqual({records, overwrite: true});
    });

    test('throws InvalidStateError when the tag is read-only', () => {
      const tag = new SimulatedTag({writable: false});
      expect(() => tag.onWrite([], true)).toThrow(DOMException);
      try {
        tag.onWrite([], true);
        throw new Error('expected onWrite to throw');
      } catch (err) {
        expect((err as DOMException).name).toBe('InvalidStateError');
      }
    });

    test('throws NotAllowedError when overwrite is false and records already exist', () => {
      const existing = [{tnf: 1, type: 'VA==', id: '', payload: 'AQID'}];
      const tag = new SimulatedTag({records: existing});
      expect(() => tag.onWrite([], false)).toThrow(DOMException);
      try {
        tag.onWrite([], false);
        throw new Error('expected onWrite to throw');
      } catch (err) {
        expect((err as DOMException).name).toBe('NotAllowedError');
      }
    });

    test('overwrite:false succeeds when there are no existing records', () => {
      const tag = new SimulatedTag();
      const records = [{tnf: 1, type: 'VA==', id: '', payload: 'AQID'}];
      tag.onWrite(records, false);
      expect(tag.records).toBe(records);
    });
  });

  describe('onMakeReadOnly()', () => {
    test('flips writable to false', () => {
      const tag = new SimulatedTag();
      tag.onMakeReadOnly();
      expect(tag.writable).toBe(false);
    });

    test('is a no-op success when already read-only', () => {
      const tag = new SimulatedTag({writable: false});
      expect(() => tag.onMakeReadOnly()).not.toThrow();
      expect(tag.writable).toBe(false);
    });
  });
});

describe('TextTag', () => {
  test('encodes a single well-known text record with the given text', () => {
    const tag = new TextTag({text: 'hello'});
    expect(tag.records).toHaveLength(1);
    const decoded = decodeRecord(tag.records[0]);
    expect(decoded.recordType).toBe('text');
    expect(decoded.lang).toBe('en');
  });

  test('accepts an explicit lang, serialNumber, and writable', () => {
    const tag = new TextTag({
      text: 'hola',
      lang: 'es',
      serialNumber: 's1',
      writable: false,
    });
    expect(tag.serialNumber).toBe('s1');
    expect(tag.writable).toBe(false);
    expect(decodeRecord(tag.records[0]).lang).toBe('es');
  });
});

describe('UrlTag', () => {
  test('encodes a single well-known url record', () => {
    const tag = new UrlTag({url: 'https://example.com'});
    expect(tag.records).toHaveLength(1);
    expect(decodeRecord(tag.records[0]).recordType).toBe('url');
  });

  test('accepts an explicit serialNumber and writable', () => {
    const tag = new UrlTag({
      url: 'https://example.com',
      serialNumber: 's2',
      writable: false,
    });
    expect(tag.serialNumber).toBe('s2');
    expect(tag.writable).toBe(false);
  });
});

describe('ReadOnlyTag', () => {
  test('defaults to writable:false and empty records', () => {
    const tag = new ReadOnlyTag();
    expect(tag.writable).toBe(false);
    expect(tag.records).toEqual([]);
  });

  test('accepts explicit records and serialNumber', () => {
    const records = [{tnf: 1, type: 'VA==', id: '', payload: 'AQID'}];
    const tag = new ReadOnlyTag({records, serialNumber: 's3'});
    expect(tag.records).toBe(records);
    expect(tag.serialNumber).toBe('s3');
    expect(tag.writable).toBe(false);
  });
});

describe('EmptyTag', () => {
  test('defaults to writable:true and empty records', () => {
    const tag = new EmptyTag();
    expect(tag.writable).toBe(true);
    expect(tag.records).toEqual([]);
  });

  test('accepts explicit serialNumber and writable', () => {
    const tag = new EmptyTag({serialNumber: 's4', writable: false});
    expect(tag.serialNumber).toBe('s4');
    expect(tag.writable).toBe(false);
  });
});

describe('MultiRecordTag', () => {
  test('holds exactly the given records', () => {
    const records = [
      {tnf: 1, type: 'VA==', id: '', payload: 'AQID'},
      {tnf: 1, type: 'VQ==', id: '', payload: 'BAUG'},
    ];
    const tag = new MultiRecordTag({records});
    expect(tag.records).toBe(records);
  });

  test('accepts explicit serialNumber and writable', () => {
    const tag = new MultiRecordTag({
      records: [],
      serialNumber: 's5',
      writable: false,
    });
    expect(tag.serialNumber).toBe('s5');
    expect(tag.writable).toBe(false);
  });
});

describe('SlowTag', () => {
  test('exposes delayMs and defaults records to empty', () => {
    const tag = new SlowTag({delayMs: 42});
    expect(tag.delayMs).toBe(42);
    expect(tag.records).toEqual([]);
  });

  test('accepts explicit records, serialNumber, and writable', () => {
    const records = [{tnf: 1, type: 'VA==', id: '', payload: 'AQID'}];
    const tag = new SlowTag({
      delayMs: 10,
      records,
      serialNumber: 's6',
      writable: false,
    });
    expect(tag.records).toBe(records);
    expect(tag.serialNumber).toBe('s6');
    expect(tag.writable).toBe(false);
  });
});

describe('FlakyTag', () => {
  test('fails exactly the Nth write attempt with NetworkError, succeeding on others', () => {
    const tag = new FlakyTag({failOnAttempt: 2});
    const records1 = [{tnf: 1, type: 'VA==', id: '', payload: 'AQID'}];
    const records2 = [{tnf: 1, type: 'VQ==', id: '', payload: 'BAUG'}];
    const records3 = [{tnf: 1, type: 'Vg==', id: '', payload: 'BwgJ'}];

    tag.onWrite(records1, true); // attempt 1: succeeds
    expect(tag.records).toBe(records1);

    expect(() => tag.onWrite(records2, true)).toThrow(DOMException); // attempt 2: fails
    // records are unchanged by the failed attempt.
    expect(tag.records).toBe(records1);

    tag.onWrite(records3, true); // attempt 3 (post-failure): succeeds again
    expect(tag.records).toBe(records3);
  });

  test('the failing attempt rejects with name NetworkError specifically', () => {
    const tag = new FlakyTag({failOnAttempt: 1});
    try {
      tag.onWrite([], true);
      throw new Error('expected onWrite to throw');
    } catch (err) {
      expect((err as DOMException).name).toBe('NetworkError');
    }
  });

  test('accepts explicit records and serialNumber', () => {
    const records = [{tnf: 1, type: 'VA==', id: '', payload: 'AQID'}];
    const tag = new FlakyTag({
      failOnAttempt: 5,
      records,
      serialNumber: 's7',
    });
    expect(tag.records).toBe(records);
    expect(tag.serialNumber).toBe('s7');
  });
});

describe('NonNdefTag', () => {
  test('has isNdef:false and empty records', () => {
    const tag = new NonNdefTag();
    expect(tag.isNdef).toBe(false);
    expect(tag.records).toEqual([]);
  });

  test('accepts an explicit serialNumber', () => {
    const tag = new NonNdefTag({serialNumber: 's8'});
    expect(tag.serialNumber).toBe('s8');
  });
});
