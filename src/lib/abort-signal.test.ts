import {
  AbortControllerImpl,
  isAbortSignal,
  ShimAbortController,
} from './abort-signal';

describe('AbortControllerImpl (real global, since Node/Jest provides one)', () => {
  test('signal starts unaborted', () => {
    const controller = new AbortControllerImpl();
    expect(controller.signal.aborted).toBe(false);
  });

  test('abort() flips aborted and fires the abort event exactly once', () => {
    const controller = new AbortControllerImpl();
    const fn = jest.fn();
    controller.signal.addEventListener('abort', fn);
    controller.abort();
    controller.abort(); // idempotent
    expect(controller.signal.aborted).toBe(true);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('removeEventListener stops future notifications', () => {
    const controller = new AbortControllerImpl();
    const fn = jest.fn();
    controller.signal.addEventListener('abort', fn);
    controller.signal.removeEventListener('abort', fn);
    controller.abort();
    expect(fn).not.toHaveBeenCalled();
  });
});

describe('ShimAbortController (the fallback used when no global AbortController exists)', () => {
  test('signal starts unaborted', () => {
    const controller = new ShimAbortController();
    expect(controller.signal.aborted).toBe(false);
    expect(controller.signal.reason).toBeUndefined();
  });

  test('abort() with an explicit reason sets aborted + reason and fires "abort"', () => {
    const controller = new ShimAbortController();
    const fn = jest.fn();
    controller.signal.addEventListener('abort', fn);
    controller.abort('my-reason');
    expect(controller.signal.aborted).toBe(true);
    expect(controller.signal.reason).toBe('my-reason');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('abort() with no reason synthesizes an AbortError', () => {
    const controller = new ShimAbortController();
    controller.abort();
    expect((controller.signal.reason as Error).name).toBe('AbortError');
  });

  test('abort() is idempotent: a second call does not re-fire or change the reason', () => {
    const controller = new ShimAbortController();
    const fn = jest.fn();
    controller.signal.addEventListener('abort', fn);
    controller.abort('first');
    controller.abort('second');
    expect(controller.signal.reason).toBe('first');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('is recognized by isAbortSignal', () => {
    const controller = new ShimAbortController();
    expect(isAbortSignal(controller.signal)).toBe(true);
  });
});

describe('isAbortSignal', () => {
  test('recognizes a real AbortSignal', () => {
    const controller = new AbortControllerImpl();
    expect(isAbortSignal(controller.signal)).toBe(true);
  });

  test('rejects null/undefined/primitives', () => {
    expect(isAbortSignal(null)).toBe(false);
    expect(isAbortSignal(undefined)).toBe(false);
    expect(isAbortSignal(42)).toBe(false);
    expect(isAbortSignal('signal')).toBe(false);
  });

  test('rejects an object missing the required shape', () => {
    expect(isAbortSignal({})).toBe(false);
    expect(isAbortSignal({aborted: true})).toBe(false);
    expect(isAbortSignal({aborted: true, addEventListener: () => {}})).toBe(
      false,
    );
  });
});
