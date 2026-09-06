/**
 * Minimal EventTarget/Event shim (§1). Zero-dependency, works identically
 * under Node/Jest, Hermes (RN), and a real browser — we don't rely on any
 * global `EventTarget`/`Event` being present, since Hermes historically
 * hasn't provided one.
 *
 * Only the subset of the DOM EventTarget contract this library needs:
 * addEventListener/removeEventListener/dispatchEvent, plus `on<type>`-style
 * properties are layered on top by WebNfcReader.ts itself (not here).
 */

export interface EventInit {
  bubbles?: boolean;
  cancelable?: boolean;
}

export class Event {
  readonly type: string;
  readonly bubbles: boolean;
  readonly cancelable: boolean;
  defaultPrevented = false;
  target: EventTarget | null = null;

  constructor(type: string, init?: EventInit) {
    this.type = type;
    this.bubbles = init?.bubbles ?? false;
    this.cancelable = init?.cancelable ?? false;
  }

  preventDefault(): void {
    if (this.cancelable) this.defaultPrevented = true;
  }
}

type Listener = (ev: Event) => void;
interface ListenerOptions {
  once?: boolean;
}

interface Registration {
  listener: Listener;
  once: boolean;
}

export class EventTarget {
  private readonly listeners = new Map<string, Set<Registration>>();

  addEventListener(
    type: string,
    listener: Listener | null,
    options?: ListenerOptions,
  ): void {
    if (!listener) return;
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    // Adding the identical listener function twice for the same type is a
    // no-op per the DOM spec — search by function identity, not registration.
    for (const reg of set) {
      if (reg.listener === listener) return;
    }
    set.add({listener, once: options?.once ?? false});
  }

  removeEventListener(type: string, listener: Listener | null): void {
    if (!listener) return;
    const set = this.listeners.get(type);
    if (!set) return;
    for (const reg of set) {
      if (reg.listener === listener) {
        set.delete(reg);
        break;
      }
    }
  }

  dispatchEvent(event: Event): boolean {
    event.target = this;
    const set = this.listeners.get(event.type);
    if (!set || set.size === 0) {
      return !event.defaultPrevented;
    }
    if (set.size === 1) {
      // Fast path: the universal case (one NDEFReader with one onreading
      // listener). Avoid the Array.from snapshot + per-iter Set.has check.
      const reg = set.values().next().value as Registration;
      if (reg.once) set.delete(reg);
      reg.listener.call(this, event);
      return !event.defaultPrevented;
    }
    // Snapshot before iterating: a listener may remove itself (once) or
    // another listener mid-dispatch. The set.has(reg) check per iteration
    // also covers mid-dispatch removal of another listener (a pre-existing
    // bug if missed — listeners removed mid-dispatch would otherwise still
    // fire on this dispatch because the snapshot still references them).
    for (const reg of Array.from(set)) {
      if (reg.once) {
        set.delete(reg);
      } else if (!set.has(reg)) {
        continue;
      }
      reg.listener.call(this, event);
    }
    return !event.defaultPrevented;
  }
}
