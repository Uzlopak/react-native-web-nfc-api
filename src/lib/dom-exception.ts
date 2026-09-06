/**
 * DOMException shim (§8). RN's JS runtime (Hermes) does not reliably provide
 * a global DOMException, and even where a global exists we want a stable,
 * dependency-free type across Node/Jest, Hermes, and browsers.
 *
 * Behaves like the real DOMException: `.name` is the spec error name,
 * `.message` is a human string, and `instanceof Error` holds.
 */

/** The spec error names this library ever throws/rejects with (§8). */
export type DomExceptionName =
  | 'NotSupportedError'
  | 'NotReadableError'
  | 'NotAllowedError'
  | 'NetworkError'
  | 'AbortError'
  | 'SyntaxError'
  | 'InvalidStateError';

export class DOMException extends Error {
  readonly name: DomExceptionName;

  constructor(message: string, name: DomExceptionName) {
    super(message);
    this.name = name;
    // Restore prototype chain for environments transpiling class extends Error.
    Object.setPrototypeOf(this, DOMException.prototype);
  }
}

/** Convenience constructor matching the call sites' usual shape. */
export function createDOMException(
  name: DomExceptionName,
  message?: string,
): DOMException {
  return new DOMException(message ?? name, name);
}
