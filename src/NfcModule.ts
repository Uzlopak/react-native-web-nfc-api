/**
 * NfcTransport injection seam (§5), mirroring UsbSerial.ts's pattern in the
 * sibling serial repo: an override installed via setNfcTransport() always
 * wins; otherwise a lazily-built platform transport is used.
 *
 * The lazily-built platform transport wraps NativeNfc (§3) via
 * NativeEventEmitter. On web (NativeNfc.web.ts stubs to null) or whenever
 * the native module isn't linked, the platform transport throws
 * NotSupportedError from every method — there is nothing to fall back to
 * except an explicitly injected transport (§4's managed-mode note).
 */
import {NativeEventEmitter} from 'react-native';
import {
  createDOMException,
  DOMException,
  type DomExceptionName,
} from './lib/dom-exception';
import type {NdefWireRecord} from './lib/ndef-wire';
import NativeNfc from './NativeNfc';
import type {
  LaunchTagActivation,
  NfcTransport,
  NfcTransportEventMap,
  NfcTransportEventType,
  Subscription,
} from './transport';

let overrideTransport: NfcTransport | null = null;
let lazyInstance: NfcTransport | null = null;

/** Spec error names this transport maps from native rejections (§3/§8). */
const NATIVE_ERROR_NAMES: readonly DomExceptionName[] = [
  'NotSupportedError',
  'NotReadableError',
  'NotAllowedError',
  'NetworkError',
  'AbortError',
  'SyntaxError',
  'InvalidStateError',
];

/**
 * Convert an arbitrary rejection value delivered by the RN bridge into a
 * DOMException with the correct `.name`. The bridge surfaces native
 * `promise.reject(code, message)` as a plain Error whose `.code` carries the
 * first arg (a string in RN's bridge convention) and whose `.message` carries
 * the second — `.name` is always "Error". Without this mapping, app code
 * matching on `error.name === "NotAllowedError"` per the Web NFC spec never
 * matches against a real device while silently passing in tests that inject
 * a transport which already throws DOMException.
 *
 * Exported for testing — see src/NfcModule.transport.test.ts.
 */
export function toDomException(error: unknown): DOMException {
  if (error instanceof DOMException) return error;
  const e = error as {code?: unknown; message?: unknown} | null | undefined;
  const message = typeof e?.message === 'string' ? e.message : String(error);
  // RN bridge shape #1: `promise.reject(code, msg)` → {code: string, message: "code: msg"}.
  // RN bridge shape #2 (older / fallback): message itself is the code.
  const code = pickCode(e?.code, e?.message);
  if (code && NATIVE_ERROR_NAMES.includes(code as DomExceptionName)) {
    return createDOMException(code as DomExceptionName, message);
  }
  return createDOMException('NotReadableError', message);
}

function pickCode(
  code: unknown,
  message: unknown,
): DomExceptionName | undefined {
  if (
    typeof code === 'string' &&
    (NATIVE_ERROR_NAMES as readonly string[]).includes(code)
  ) {
    return code as DomExceptionName;
  }
  // The RN bridge surfaces `promise.reject(code, msg)` as an Error whose
  // .message is `"code: msg"`. Strip the "code: " prefix and re-check.
  if (typeof message === 'string') {
    const colon = message.indexOf(':');
    const candidate = colon > 0 ? message.slice(0, colon) : message;
    if ((NATIVE_ERROR_NAMES as readonly string[]).includes(candidate)) {
      return candidate as DomExceptionName;
    }
  }
  return undefined;
}

/**
 * Wrap a native TurboModule call so a rejection surfaces as a DOMException
 * with the correct `.name` (per the Web NFC spec). Without this, native
 * rejections from NfcModule.kt's `promise.reject("NotAllowedError", msg)`
 * would arrive at app code as plain Errors with `.name === "Error"`.
 */
async function runNative<R>(call: () => Promise<R>): Promise<R> {
  try {
    return await call();
  } catch (err) {
    throw toDomException(err);
  }
}

/**
 * The real platform transport, built lazily around NativeNfc + a
 * NativeEventEmitter. Every method rejects with NotSupportedError when the
 * native module isn't present (web, or a host app that hasn't linked native
 * code yet) — this is intentional per §4: on web there's nothing to
 * physically fall back to besides an injected transport.
 */
class NativeNfcTransport implements NfcTransport {
  private readonly emitter: NativeEventEmitter | null;

  constructor() {
    this.emitter = NativeNfc
      ? new NativeEventEmitter(NativeNfc as never)
      : null;
  }

  private requireNative(): NonNullable<typeof NativeNfc> {
    if (!NativeNfc) {
      throw createDOMException(
        'NotSupportedError',
        'NativeNfc module is not available on this platform',
      );
    }
    return NativeNfc;
  }

  async isSupported(): Promise<boolean> {
    const native = this.requireNative();
    return runNative(() => native.isSupported());
  }

  async isEnabled(): Promise<boolean> {
    const native = this.requireNative();
    return runNative(() => native.isEnabled());
  }

  async beginScan(
    operationId: string,
    opts: {alertMessage?: string},
  ): Promise<void> {
    return runNative(() => this.requireNative().beginScan(operationId, opts));
  }

  async beginWrite(
    operationId: string,
    records: NdefWireRecord[],
    opts: {overwrite: boolean; alertMessage?: string},
  ): Promise<void> {
    return runNative(() =>
      this.requireNative().beginWrite(operationId, records, opts),
    );
  }

  async beginMakeReadOnly(
    operationId: string,
    opts: {alertMessage?: string},
  ): Promise<void> {
    return runNative(() =>
      this.requireNative().beginMakeReadOnly(operationId, opts),
    );
  }

  async cancelOperation(operationId: string): Promise<void> {
    return runNative(() => this.requireNative().cancelOperation(operationId));
  }

  async consumePendingLaunchTag(): Promise<LaunchTagActivation | null> {
    return runNative(() => this.requireNative().consumePendingLaunchTag());
  }

  addEventListener<T extends NfcTransportEventType>(
    type: T,
    cb: (ev: NfcTransportEventMap[T]) => void,
  ): Subscription {
    if (!this.emitter) {
      return {remove: () => {}};
    }
    const sub = this.emitter.addListener(type, cb as (ev: unknown) => void);
    return {remove: () => sub.remove()};
  }
}

export function getNfcTransport(): NfcTransport {
  if (overrideTransport) return overrideTransport;
  if (!lazyInstance) lazyInstance = new NativeNfcTransport();
  return lazyInstance;
}

export function setNfcTransport(transport: NfcTransport | null): void {
  overrideTransport = transport;
}

export function resetNfcTransport(): void {
  overrideTransport = null;
  lazyInstance = null;
}
