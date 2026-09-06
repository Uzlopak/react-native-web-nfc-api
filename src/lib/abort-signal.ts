/**
 * AbortSignal/AbortController shim (§1), used only as a fallback where the
 * host runtime doesn't already provide one. Both Node and modern Hermes
 * provide real globals, but we don't want a hard runtime assumption baked
 * into `WebNfcReader.ts` — this module is the single place that decides.
 *
 * Kept intentionally tiny: just enough of the real API surface
 * (`aborted`, `reason`, `addEventListener('abort', ...)`, `AbortController`)
 * for this library's own use, not a full polyfill.
 */
import {Event, EventTarget} from './event-target';

export interface AbortSignalLike {
  readonly aborted: boolean;
  readonly reason?: unknown;
  addEventListener(type: 'abort', listener: (ev: Event) => void): void;
  removeEventListener(type: 'abort', listener: (ev: Event) => void): void;
}

export class ShimAbortSignal extends EventTarget implements AbortSignalLike {
  private _aborted = false;
  private _reason: unknown;

  get aborted(): boolean {
    return this._aborted;
  }

  get reason(): unknown {
    return this._reason;
  }

  /** @internal */
  _doAbort(reason: unknown): void {
    if (this._aborted) return;
    this._aborted = true;
    this._reason = reason;
    this.dispatchEvent(new Event('abort'));
  }
}

export class ShimAbortController {
  readonly signal: ShimAbortSignal = new ShimAbortSignal();

  abort(reason?: unknown): void {
    this.signal._doAbort(reason ?? createAbortError());
  }
}

function createAbortError(): unknown {
  // A plain tagged Error, not dom-exception.ts's DOMException — this module
  // stays standalone/dependency-free by convention (§1); WebNfcReader.ts is
  // responsible for translating abort reasons into DOMException where the
  // public API requires one.
  const err = new Error('The operation was aborted.');
  (err as {name: string}).name = 'AbortError';
  return err;
}

/** Resolves to a real global AbortController/AbortSignal if present, else the shim. */
export const AbortControllerImpl: {
  new (): {signal: AbortSignalLike; abort(reason?: unknown): void};
} =
  typeof globalThis.AbortController !== 'undefined'
    ? (globalThis.AbortController as unknown as {
        new (): {signal: AbortSignalLike; abort(reason?: unknown): void};
      })
    : ShimAbortController;

export function isAbortSignal(value: unknown): value is AbortSignalLike {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as Partial<AbortSignalLike>;
  return (
    typeof candidate.aborted === 'boolean' &&
    typeof candidate.addEventListener === 'function' &&
    typeof candidate.removeEventListener === 'function'
  );
}
