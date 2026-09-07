/**
 * Port of the vendored react-native-nfc-rewriter's NfcProxy.js, reimplemented
 * against react-native-web-nfc-api's public NDEFReader/DOMException surface.
 * Only the NDEF-scoped methods are ported (per the task's scope boundary):
 * init, isEnabled, readNdefOnce, readTag, writeNdef, makeReadOnly.
 * goToNfcSetting() has no equivalent in this library (there is no native
 * "jump to system NFC settings" call in the public API) — see README.md's
 * "Ported from react-native-nfc-rewriter" section for this and other
 * documented divergences.
 *
 * The original's `withAndroidPrompt` wrapper (an Android-only "Ready to
 * scan" modal shown for the duration of a native NFC prompt) and
 * `handleException` (bypass UserCancel, alert on Timeout, alert/invalidate
 * otherwise) patterns are preserved here, adapted to this library's
 * DOMException-name error model instead of nfc-manager's NfcError classes.
 */
import {Platform} from 'react-native';
import {NDEFReader, type NDEFReadingEvent} from 'react-native-web-nfc-api';

export type WriteType = 'TEXT' | 'URI' | 'WIFI_SIMPLE' | 'VCARD';

export interface VCardValue {
  name: string;
  org?: string;
  tel?: string;
  email?: string;
}

export interface WifiSimpleValue {
  ssid: string;
  networkKey: string;
}

export type WriteValue = string | VCardValue | WifiSimpleValue;

export interface WriteNdefArgs {
  type: WriteType;
  value: WriteValue;
}

export interface SimpleTag {
  serialNumber: string;
  records: Array<{
    recordType: string;
    mediaType?: string;
    id?: string;
    text?: string;
  }>;
}

/** Set by the app to show/hide the Android "Ready to scan" prompt (§ withAndroidPrompt). */
type PromptHandler = (visible: boolean, message?: string) => void;
let promptHandler: PromptHandler | null = null;
function setPromptHandler(handler: PromptHandler | null) {
  promptHandler = handler;
}

/** Set by the app to receive user-facing alerts (§ handleException). */
type AlertHandler = (title: string, message?: string) => void;
let alertHandler: AlertHandler = (title, message) =>
  console.warn(`[NfcProxy alert] ${title}: ${message ?? ''}`);
function setAlertHandler(handler: AlertHandler) {
  alertHandler = handler;
}

/**
 * Mirrors the original's `withAndroidPrompt` higher-order function: shows a
 * "Ready to scan NFC" prompt (Android only) for the duration of `fn`, hiding
 * it ~800ms after `fn` settles (matching the original's UX timing so the
 * success/failure state is briefly visible before the prompt dismisses).
 */
function withAndroidPrompt<Args extends unknown[], R>(
  fn: (...args: Args) => Promise<R>,
): (...args: Args) => Promise<R> {
  return async (...args: Args) => {
    if (Platform.OS === 'android') {
      promptHandler?.(true, 'Ready to scan NFC');
    }
    try {
      return await fn(...args);
    } finally {
      if (Platform.OS === 'android') {
        setTimeout(() => promptHandler?.(false), 800);
      }
    }
  };
}

/**
 * Mirrors the original's `handleException`: a DOMException named
 * `AbortError` is the user/app-cancellation case (bypassed, no alert) —
 * this library's closest analogue to nfc-manager's `NfcError.UserCancel`.
 * Any other error is surfaced via alertHandler, same as the original's
 * fallback branch (the original's iOS `invalidateSessionWithErrorIOS` path
 * has no equivalent here — this library manages session invalidation
 * internally).
 */
function handleException(ex: unknown): void {
  if (ex instanceof DOMException && ex.name === 'AbortError') {
    // bypass — matches NfcError.UserCancel in the original
    return;
  }
  console.warn(ex);
  if (ex instanceof DOMException && ex.name === 'NotReadableError') {
    // The radio is physically off (see isEnabled()'s doc comment below) —
    // scan()/write()/makeReadOnly() rejecting this is the only reliable
    // signal this library gives for that. Callers that want to update a
    // "NFC is off" banner from this should use onNotReadable below instead
    // of matching alertHandler's generic text.
    notReadableHandler?.();
    alertHandler('NFC is turned off', 'Enable NFC in system settings and try again.');
    return;
  }
  const message = ex instanceof Error ? ex.message : String(ex);
  alertHandler('NFC Error', message);
}

/** Set by the app to react to a scan()/write() call revealing NFC is off. */
type NotReadableHandler = () => void;
let notReadableHandler: NotReadableHandler | null = null;
function setNotReadableHandler(handler: NotReadableHandler | null) {
  notReadableHandler = handler;
}

function toSimpleTag(ev: NDEFReadingEvent): SimpleTag {
  return {
    serialNumber: ev.serialNumber,
    records: ev.message.records.map(r => ({
      recordType: r.recordType,
      mediaType: r.mediaType,
      id: r.id,
      text: decodeRecordText(r),
    })),
  };
}

function decodeRecordText(record: {
  recordType: string;
  data?: DataView;
  encoding?: string;
}): string | undefined {
  if (!record.data) {
    return undefined;
  }
  try {
    const decoder = new TextDecoder(record.encoding || 'utf-8');
    return decoder.decode(record.data);
  } catch {
    return undefined;
  }
}

class NfcProxy {
  private reader: NDEFReader | null = null;
  private mode: 'passthrough' | 'managed' = 'passthrough';

  /**
   * Switches every subsequently-constructed reader between real
   * scan/write (the default, `'passthrough'` on web / real hardware on
   * native) and the simulatable `'managed'` polyfill (§4), so this app's
   * "Virtual Tag demo" toggle can drive the exact same NfcProxy/screens
   * against `InMemoryNfcTransport` instead of a real NFC radio. Any reader
   * already constructed under the previous mode is discarded — the next
   * call that needs one builds a fresh reader under the new mode.
   */
  setMode(mode: 'passthrough' | 'managed'): void {
    if (this.mode === mode) return;
    this.mode = mode;
    this.reader = null;
  }

  private getReader(): NDEFReader {
    if (!this.reader) {
      this.reader = new NDEFReader({mode: this.mode});
    }
    return this.reader;
  }

  /** Matches the original's init(): checks support, no separate start() call needed here. */
  async init(): Promise<boolean> {
    return NDEFReader.isSupported(this.mode);
  }

  /** Synchronous feature-detection helper (§4's non-spec static), for UI reads like Settings. */
  isSupported(): boolean {
    return NDEFReader.isSupported(this.mode);
  }

  /**
   * The library's public NDEFReader surface has no standalone isEnabled()
   * query (unlike nfc-manager's NfcManager.isEnabled()) — the Web NFC spec
   * itself has no such concept either; it only ever reports "the radio is
   * off" indirectly, as a scan()/write()/makeReadOnly() call rejecting with
   * NotReadableError (§8 of the plan) once you actually try to use it.
   *
   * An earlier version of this proxy "solved" that gap by starting a real
   * scan() and immediately aborting it just to observe whether it rejected
   * NotReadableError first — that's a real native NFC session opened purely
   * to answer a yes/no question, and it can race SessionCoordinator's
   * same-reader re-scan rule (§5a) if a genuine scan() follows too quickly
   * behind the still-settling probe. Given this screen only ever calls
   * isEnabled() to decide whether to render a "NFC is off" banner (see
   * Screens/Home.tsx), the honest, non-probing answer is: we don't know
   * until something real is attempted. `enabled: null` means exactly that —
   * the Home screen renders no banner from this call alone, and the very
   * first real scan()/write() rejecting NotReadableError is what actually
   * reveals the radio is off, same as the rest of this library's design.
   *
   * That real signal is wired up via setNotReadableHandler()/
   * handleException() above: any scan()/write()/makeReadOnly() call that
   * rejects NotReadableError invokes the registered handler, which
   * Screens/Home.tsx uses to flip its banner on immediately instead of
   * waiting on a nonexistent isEnabled() poll or a live stateChanged
   * subscription (not exposed on the public NDEFReader API — see
   * README.md's "Ported from react-native-nfc-rewriter" section).
   */
  async isEnabled(): Promise<boolean | null> {
    if (!NDEFReader.isSupported(this.mode)) {
      return false;
    }
    return null;
  }

  /**
   * There is no goToNfcSetting() equivalent in react-native-web-nfc-api's
   * public API — this library manages NFC state checks internally rather
   * than exposing a "jump to system settings" native call. Kept as a no-op
   * stub (rather than removed) so call sites can still reference it and the
   * gap is visible in one place; see README.md.
   */
  async goToNfcSetting(): Promise<void> {
    console.warn(
      'NfcProxy.goToNfcSetting(): no equivalent in react-native-web-nfc-api\'s public API — see README.md',
    );
  }

  /**
   * One-shot single-read helper, analogous to the original's readNdefOnce()
   * (nfc-manager's NDEF-only iOS registerTagEvent API). Since this library's
   * scan() is a standing session rather than nfc-manager's one-shot
   * register/unregister pair, this wraps scan() + an abort once the first
   * `reading` event fires.
   */
  readNdefOnce = withAndroidPrompt(async (): Promise<SimpleTag | null> => {
    const reader = new NDEFReader({mode: this.mode});
    const controller = new AbortController();
    return new Promise<SimpleTag | null>(resolve => {
      let settled = false;
      const finish = (tag: SimpleTag | null) => {
        if (settled) {
          return;
        }
        settled = true;
        reader.onreading = null;
        reader.onreadingerror = null;
        controller.abort();
        resolve(tag);
      };
      reader.onreading = (ev: NDEFReadingEvent) => finish(toSimpleTag(ev));
      reader.onreadingerror = () => finish(null);
      reader.scan({signal: controller.signal}).catch(ex => {
        if (!(ex instanceof DOMException && ex.name === 'AbortError')) {
          handleException(ex);
        }
        finish(null);
      });
    });
  });

  /**
   * Matches the original's readTag(): scans for a single tag and resolves
   * with its data (or null on any failure — "for tag reading, we don't
   * actually need to show any error", per the original's comment).
   */
  readTag = withAndroidPrompt(async (): Promise<SimpleTag | null> => {
    try {
      return await this.readNdefOnce();
    } catch (ex) {
      console.log(ex);
      return null;
    }
  });

  /**
   * Matches the original's writeNdef({type, value}): builds an
   * NDEFMessageInit per type and calls write(). TEXT/URI use the library's
   * well-known-record coercion; WIFI_SIMPLE/VCARD are written as MIME
   * records — there is no dedicated wifiSimpleRecord()/vCard encoder in this
   * library's public API (unlike nfc-manager's Ndef helpers), so this port
   * builds the MIME payload bytes directly, same as VCardWriter/
   * WifiSimpleWriter already had to compose by hand in the original.
   */
  writeNdef = withAndroidPrompt(async ({type, value}: WriteNdefArgs): Promise<boolean> => {
    try {
      const reader = this.getReader();
      if (type === 'TEXT') {
        await reader.write(value as string);
      } else if (type === 'URI') {
        await reader.write({records: [{recordType: 'url', data: value as string}]});
      } else if (type === 'WIFI_SIMPLE') {
        const {ssid, networkKey} = value as WifiSimpleValue;
        await reader.write({
          records: [
            {
              recordType: 'mime',
              mediaType: 'application/vnd.wfa.wsc',
              data: encodeWifiSimple(ssid, networkKey),
            },
          ],
        });
      } else if (type === 'VCARD') {
        const {name, org = '', tel = '', email = ''} = value as VCardValue;
        const vCard = `BEGIN:VCARD\nVERSION:2.1\nN:;${name}\nORG: ${org}\nTEL;HOME:${tel}\nEMAIL:${email}\nEND:VCARD`;
        await reader.write({
          records: [{recordType: 'mime', mediaType: 'text/vcard', data: vCard}],
        });
      } else {
        return false;
      }
      return true;
    } catch (ex) {
      handleException(ex);
      return false;
    }
  });

  /** Matches the original's makeReadOnly(). */
  makeReadOnly = withAndroidPrompt(async (): Promise<boolean> => {
    try {
      await this.getReader().makeReadOnly();
      return true;
    } catch (ex) {
      handleException(ex);
      return false;
    }
  });
}

/**
 * Minimal WPS (Wi-Fi Simple Config) TLV payload for SSID + network key —
 * enough for the vendored app's WifiSimpleWriter round trip, not a full WSC
 * implementation. Mirrors nfc-manager's Ndef.wifiSimpleRecord() output shape
 * closely enough for another NDEF reader to decode SSID/passphrase back out.
 */
function encodeWifiSimple(ssid: string, networkKey: string): Uint8Array<ArrayBuffer> {
  const encoder = new TextEncoder();
  const ssidBytes = encoder.encode(ssid);
  const keyBytes = encoder.encode(networkKey);

  function tlv(type: number, bytes: Uint8Array): number[] {
    return [
      (type >> 8) & 0xff,
      type & 0xff,
      (bytes.length >> 8) & 0xff,
      bytes.length & 0xff,
      ...bytes,
    ];
  }

  const ssidTlv = tlv(0x1045, ssidBytes); // CREDENTIAL/SSID
  const keyTlv = tlv(0x1027, keyBytes); // NETWORK_KEY
  const credentialBody = [...ssidTlv, ...keyTlv];
  const credentialTlv = tlv(0x100e, new Uint8Array(credentialBody)); // CREDENTIAL
  return new Uint8Array(credentialTlv);
}

const nfcProxy = new NfcProxy();
export default nfcProxy;
export {setPromptHandler, setAlertHandler, setNotReadableHandler, handleException};
