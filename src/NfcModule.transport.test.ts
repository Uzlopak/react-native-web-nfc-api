/**
 * Regression tests for NfcModule.ts's native-rejection wrapping (finding #1).
 *
 * The RN bridge surfaces `promise.reject(code, message)` (Kotlin) /
 * `reject(code, message)` (Obj-C) as a plain Error whose `.code` carries the
 * first arg and whose `.message` carries the second. Without the wrap,
 * WebNfcReader.write/makeReadOnly/beginScan would propagate that Error to
 * app code, which checks `error.name` per the Web NFC spec — those checks
 * would never match against the spec error name on real hardware while
 * silently passing in tests that inject a transport throwing DOMException
 * directly.
 */

import {DOMException} from './lib/dom-exception';
import {toDomException} from './NfcModule';

describe('toDomException — native rejection mapping (regression: finding #1)', () => {
  test('already-a-DOMException passes through unchanged', () => {
    const orig = new DOMException('boom', 'NotAllowedError');
    const wrapped = toDomException(orig);
    expect(wrapped).toBe(orig);
    expect(wrapped.name).toBe('NotAllowedError');
  });

  test('RN bridge shape #1: {code: "NotAllowedError", message: "..."}', () => {
    // What the RN bridge produces for `promise.reject("NotAllowedError", msg)`.
    const err = Object.assign(new Error('tag already has NDEF records'), {
      code: 'NotAllowedError',
    });
    const wrapped = toDomException(err);
    expect(wrapped).toBeInstanceOf(DOMException);
    expect(wrapped.name).toBe('NotAllowedError');
    expect(wrapped.message).toContain('tag already has NDEF records');
  });

  test('RN bridge shape #2: message itself prefixed with the spec name', () => {
    // Some bridge versions compose `code: message` into `.message` directly
    // and drop `.code`. The wrap should still recover the spec name.
    const err = Object.assign(new Error('NetworkError: tag removed'), {});
    const wrapped = toDomException(err);
    expect(wrapped.name).toBe('NetworkError');
  });

  test('maps every spec error name correctly', () => {
    for (const name of [
      'NotSupportedError',
      'NotReadableError',
      'NotAllowedError',
      'NetworkError',
      'AbortError',
      'SyntaxError',
      'InvalidStateError',
    ] as const) {
      const wrapped = toDomException(
        Object.assign(new Error(`${name}: something`), {code: name}),
      );
      expect(wrapped.name).toBe(name);
    }
  });

  test('unknown error code falls back to NotReadableError', () => {
    const err = Object.assign(new Error('something unexpected'), {
      code: 'SomeRandomError',
    });
    const wrapped = toDomException(err);
    expect(wrapped.name).toBe('NotReadableError');
  });

  test('a non-Error rejection (e.g. thrown string) is wrapped as NotReadableError', () => {
    const wrapped = toDomException('plain string rejection');
    expect(wrapped.name).toBe('NotReadableError');
    expect(wrapped.message).toContain('plain string rejection');
  });

  test('undefined rejection surfaces a NotReadableError without crashing', () => {
    const wrapped = toDomException(undefined);
    expect(wrapped.name).toBe('NotReadableError');
  });
});
