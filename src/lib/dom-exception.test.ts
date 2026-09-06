import {createDOMException, DOMException} from './dom-exception';

describe('DOMException shim', () => {
  test('sets name and message, is an Error instance', () => {
    const err = new DOMException('boom', 'NotSupportedError');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(DOMException);
    expect(err.name).toBe('NotSupportedError');
    expect(err.message).toBe('boom');
  });

  test('createDOMException defaults message to the name', () => {
    const err = createDOMException('AbortError');
    expect(err.name).toBe('AbortError');
    expect(err.message).toBe('AbortError');
  });

  test('createDOMException accepts an explicit message', () => {
    const err = createDOMException('NetworkError', 'tag removed');
    expect(err.name).toBe('NetworkError');
    expect(err.message).toBe('tag removed');
  });
});
