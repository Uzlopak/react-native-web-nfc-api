import {Event, EventTarget} from './event-target';

describe('Event', () => {
  test('defaults bubbles/cancelable to false', () => {
    const ev = new Event('foo');
    expect(ev.type).toBe('foo');
    expect(ev.bubbles).toBe(false);
    expect(ev.cancelable).toBe(false);
    expect(ev.defaultPrevented).toBe(false);
    expect(ev.target).toBeNull();
  });

  test('respects init options', () => {
    const ev = new Event('foo', {bubbles: true, cancelable: true});
    expect(ev.bubbles).toBe(true);
    expect(ev.cancelable).toBe(true);
  });

  test('preventDefault only takes effect when cancelable', () => {
    const nonCancelable = new Event('foo');
    nonCancelable.preventDefault();
    expect(nonCancelable.defaultPrevented).toBe(false);

    const cancelable = new Event('foo', {cancelable: true});
    cancelable.preventDefault();
    expect(cancelable.defaultPrevented).toBe(true);
  });
});

describe('EventTarget', () => {
  test('dispatches to registered listeners and sets event.target', () => {
    const target = new EventTarget();
    const received: Event[] = [];
    target.addEventListener('foo', ev => received.push(ev));
    const ev = new Event('foo');
    const result = target.dispatchEvent(ev);
    expect(received).toEqual([ev]);
    expect(ev.target).toBe(target);
    expect(result).toBe(true);
  });

  test('dispatchEvent returns false when defaultPrevented', () => {
    const target = new EventTarget();
    target.addEventListener('foo', ev => ev.preventDefault());
    const ev = new Event('foo', {cancelable: true});
    expect(target.dispatchEvent(ev)).toBe(false);
  });

  test('does not dispatch to listeners of a different type', () => {
    const target = new EventTarget();
    const fn = jest.fn();
    target.addEventListener('bar', fn);
    target.dispatchEvent(new Event('foo'));
    expect(fn).not.toHaveBeenCalled();
  });

  test('dispatching with no listeners registered for the type is a no-op', () => {
    const target = new EventTarget();
    expect(() => target.dispatchEvent(new Event('unregistered'))).not.toThrow();
  });

  test('adding the same listener function twice registers it once', () => {
    const target = new EventTarget();
    const fn = jest.fn();
    target.addEventListener('foo', fn);
    target.addEventListener('foo', fn);
    target.dispatchEvent(new Event('foo'));
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('addEventListener with a null listener is a no-op', () => {
    const target = new EventTarget();
    expect(() => target.addEventListener('foo', null)).not.toThrow();
    expect(target.dispatchEvent(new Event('foo'))).toBe(true);
  });

  test('removeEventListener removes a registered listener', () => {
    const target = new EventTarget();
    const fn = jest.fn();
    target.addEventListener('foo', fn);
    target.removeEventListener('foo', fn);
    target.dispatchEvent(new Event('foo'));
    expect(fn).not.toHaveBeenCalled();
  });

  test('removeEventListener with a null listener is a no-op', () => {
    const target = new EventTarget();
    expect(() => target.removeEventListener('foo', null)).not.toThrow();
  });

  test('removeEventListener on a type with no listeners is a no-op', () => {
    const target = new EventTarget();
    expect(() =>
      target.removeEventListener('never-added', () => {}),
    ).not.toThrow();
  });

  test('removeEventListener for a listener not registered under that type is a no-op', () => {
    const target = new EventTarget();
    const fn = jest.fn();
    const other = jest.fn();
    target.addEventListener('foo', fn);
    target.removeEventListener('foo', other);
    target.dispatchEvent(new Event('foo'));
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('a "once" listener fires only once', () => {
    const target = new EventTarget();
    const fn = jest.fn();
    target.addEventListener('foo', fn, {once: true});
    target.dispatchEvent(new Event('foo'));
    target.dispatchEvent(new Event('foo'));
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('a "once" listener is removed after firing in the size>1 path', () => {
    // Exercises the set.delete(reg) branch inside the size>1 dispatch
    // loop — distinct from the size=1 fast path which has its own
    // removeEventListener call.
    const target = new EventTarget();
    const once = jest.fn();
    const persistent = jest.fn();
    target.addEventListener('foo', persistent);
    target.addEventListener('foo', once, {once: true});
    target.dispatchEvent(new Event('foo'));
    target.dispatchEvent(new Event('foo'));
    expect(once).toHaveBeenCalledTimes(1);
    expect(persistent).toHaveBeenCalledTimes(2);
  });

  test('a listener removing another listener mid-dispatch prevents it from firing on this dispatch', () => {
    // Per the DOM EventTarget spec, calling removeEventListener() during a
    // dispatch takes effect immediately: any listener still in the Set at
    // the moment of iteration fires, any listener already removed does
    // not. The old snapshot semantics that fired removed listeners was a
    // pre-existing bug fixed alongside the perf #5 fast-path refactor.
    const target = new EventTarget();
    const second = jest.fn();
    const first = jest.fn(() => target.removeEventListener('foo', second));
    target.addEventListener('foo', first);
    target.addEventListener('foo', second);
    target.dispatchEvent(new Event('foo'));
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(0);
  });

  test('a listener removing itself does NOT fire on subsequent dispatches', () => {
    // Distinct from the mid-dispatch mid-removal test above: even when
    // the snapshot is size > 1 and the listener removes itself on the
    // current dispatch, subsequent dispatches must respect the Set's
    // current membership (not the stale snapshot).
    const target = new EventTarget();
    let self: () => void = () => {};
    self = jest.fn(() => target.removeEventListener('foo', self));
    const other = jest.fn();
    target.addEventListener('foo', self);
    target.addEventListener('foo', other);
    target.dispatchEvent(new Event('foo'));
    expect(self).toHaveBeenCalledTimes(1);
    expect(other).toHaveBeenCalledTimes(1);
    target.dispatchEvent(new Event('foo'));
    expect(self).toHaveBeenCalledTimes(1);
    expect(other).toHaveBeenCalledTimes(2);
  });
});
