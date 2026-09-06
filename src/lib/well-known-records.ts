/**
 * text/url/smart-poster/mime interpretation on top of the neutral
 * `NdefWireRecord` wire format (§5b). This is where TNF + type bytes get
 * turned into Web NFC `recordType`/`mediaType`/`data`/`encoding`/`lang`
 * semantics — native never does this interpretation itself.
 *
 * Layering (per §5b):
 *   NdefWireRecord  --decode-->  WebRecordFields  (used to build NDEFRecord)
 *   WebRecordFields --encode-->  NdefWireRecord[]  (used by write())
 */
import {
  bytesToBase64,
  bytesToString,
  decodeWireRecord,
  EMPTY_BYTES_BASE64,
  type NdefWireRecord,
  RTD_SMART_POSTER_BASE64,
  RTD_TEXT_BASE64,
  RTD_URI_BASE64,
  stringToBytes,
  TNF,
} from './ndef-wire';

/** The decoded fields needed to construct a public `NDEFRecord` (§2). */
export interface WebRecordFields {
  recordType: string;
  mediaType?: string;
  id?: string;
  data: Uint8Array;
  encoding?: string;
  lang?: string;
  /** Present only for recordType === 'smart-poster': the nested records. */
  toRecordsWire?: NdefWireRecord[];
}

// --- Well-known RTD type bytes ---------------------------------------------

const RTD_TEXT = stringToBytes('T');
const RTD_URI = stringToBytes('U');
const RTD_SMART_POSTER = stringToBytes('Sp');

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

// RFC 6838 §4.2 "tchar": the set of characters allowed in a type or
// subtype token, excluding the slash that separates the two halves. We
// use this to validate MIME mediaType strings on the write() path so a
// malformed value like "not-a-mime" is rejected up-front instead of being
// silently committed to the tag.
const MIME_TCHAR = /[!#$%&'*+\-.^_`|~0-9A-Za-z]/;

function isValidMimeType(value: string): boolean {
  // Caller (encodeWebRecord) guarantees value is a non-empty string before
  // calling this — the empty/undefined case is handled by the upstream
  // `!input.mediaType` check in encodeWebRecord.
  const slash = value.indexOf('/');
  if (slash <= 0 || slash !== value.lastIndexOf('/')) return false;
  const type = value.slice(0, slash);
  const subtype = value.slice(slash + 1);
  // `type` is guaranteed non-empty here: slash <= 0 above already rejects
  // slash === 0 (empty type) and slash === -1 (no slash at all).
  if (!subtype) return false;
  for (let i = 0; i < type.length; i++) {
    if (!MIME_TCHAR.test(type[i])) return false;
  }
  for (let i = 0; i < subtype.length; i++) {
    if (!MIME_TCHAR.test(subtype[i])) return false;
  }
  return true;
}

// --- URI record: NFC Forum URI Record Type Definition prefix table --------

const URI_PREFIXES: readonly string[] = [
  '', // 0x00 - no prefix
  'http://www.',
  'https://www.',
  'http://',
  'https://',
  'tel:',
  'mailto:',
  'ftp://anonymous:anonymous@',
  'ftp://ftp.',
  'ftps://',
  'sftp://',
  'smb://',
  'nfs://',
  'ftp://',
  'dav://',
  'news:',
  'telnet://',
  'imap:',
  'rtsp://',
  'urn:',
  'pop:',
  'sip:',
  'sips:',
  'tftp:',
  'btspp://',
  'btl2cap://',
  'btgoep://',
  'tcpobex://',
  'irdaobex://',
  'file://',
  'urn:epc:id:',
  'urn:epc:tag:',
  'urn:epc:pat:',
  'urn:epc:raw:',
  'urn:epc:',
  'urn:nfc:',
];

function decodeUriPayload(payload: Uint8Array): string {
  if (payload.length === 0) {
    return '';
  }
  const prefixCode = payload[0];
  const prefix = URI_PREFIXES[prefixCode] ?? '';
  const rest = bytesToString(payload.subarray(1));
  return prefix + rest;
}

// Pre-sorted table (longest-prefix-first, excluding the empty 0x00 entry
// at index 0) so encodeUriPayload can break on the first match instead of
// scanning all 35 prefixes to find the longest. Built once at module load.
const URI_PREFIXES_BY_LENGTH = (() => {
  const entries: Array<{index: number; prefix: string}> = [];
  for (let i = 1; i < URI_PREFIXES.length; i++) {
    entries.push({index: i, prefix: URI_PREFIXES[i]});
  }
  entries.sort((a, b) => b.prefix.length - a.prefix.length);
  return entries;
})();

function encodeUriPayload(uri: string): Uint8Array {
  // Choose the longest matching prefix for compactness (not required, but
  // matches real-world encoder behavior and keeps round trips minimal).
  // URI_PREFIXES_BY_LENGTH is sorted longest-first, so the first match
  // wins — no need to scan every prefix to confirm no longer one matches.
  let bestIndex = 0;
  let bestLength = 0;
  for (const {index, prefix} of URI_PREFIXES_BY_LENGTH) {
    if (uri.startsWith(prefix)) {
      bestIndex = index;
      bestLength = prefix.length;
      break;
    }
  }
  const rest = uri.slice(bestLength);
  const restBytes = stringToBytes(rest);
  const out = new Uint8Array(restBytes.length + 1);
  out[0] = bestIndex;
  out.set(restBytes, 1);
  return out;
}

// --- Text record: NFC Forum Text Record Type Definition -------------------

interface DecodedText {
  text: string;
  lang: string;
  encoding: 'utf-8' | 'utf-16';
}

function decodeTextPayload(payload: Uint8Array): DecodedText {
  if (payload.length === 0) {
    throw new Error('malformed text record: empty payload');
  }
  const statusByte = payload[0];
  const isUtf16 = (statusByte & 0x80) !== 0;
  const langLength = statusByte & 0x3f;
  if (1 + langLength > payload.length) {
    throw new Error(
      'malformed text record: language code length exceeds payload',
    );
  }
  const langBytes = payload.subarray(1, 1 + langLength);
  const lang = bytesToString(langBytes);
  const textBytes = payload.subarray(1 + langLength);
  const encoding: 'utf-8' | 'utf-16' = isUtf16 ? 'utf-16' : 'utf-8';
  const text = isUtf16 ? decodeUtf16(textBytes) : bytesToString(textBytes);
  return {text, lang, encoding};
}

function decodeUtf16(bytes: Uint8Array): string {
  // Respect a BOM if present; otherwise assume big-endian (NFC Forum default).
  let littleEndian = false;
  let offset = 0;
  if (bytes.length >= 2) {
    if (bytes[0] === 0xff && bytes[1] === 0xfe) {
      littleEndian = true;
      offset = 2;
    } else if (bytes[0] === 0xfe && bytes[1] === 0xff) {
      littleEndian = false;
      offset = 2;
    }
  }
  const codeUnits: number[] = [];
  for (let i = offset; i + 1 < bytes.length; i += 2) {
    const lo = bytes[i];
    const hi = bytes[i + 1];
    codeUnits.push(littleEndian ? (hi << 8) | lo : (lo << 8) | hi);
  }
  return String.fromCharCode(...codeUnits);
}

function encodeTextPayload(
  text: string,
  lang: string,
  encoding: 'utf-8' | 'utf-16',
): Uint8Array {
  const langBytes = stringToBytes(lang);
  if (langBytes.length > 0x3f) {
    throw new Error('language code too long (max 63 bytes)');
  }
  const isUtf16 = encoding === 'utf-16';
  const statusByte = (isUtf16 ? 0x80 : 0x00) | langBytes.length;
  const textBytes = isUtf16 ? encodeUtf16BE(text) : stringToBytes(text);
  const out = new Uint8Array(1 + langBytes.length + textBytes.length);
  out[0] = statusByte;
  out.set(langBytes, 1);
  out.set(textBytes, 1 + langBytes.length);
  return out;
}

function encodeUtf16BE(text: string): Uint8Array {
  const out = new Uint8Array(text.length * 2);
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    out[i * 2] = (code >> 8) & 0xff;
    out[i * 2 + 1] = code & 0xff;
  }
  return out;
}

// --- Decode: NdefWireRecord -> WebRecordFields -----------------------------

/**
 * Decode a single NdefWireRecord into the fields needed for a public
 * NDEFRecord. Smart-poster nested records are decoded recursively into
 * `toRecordsWire` (kept as wire records; WebNfcReader.ts is responsible for
 * turning those into actual NDEFRecord instances via `toRecords()`, since
 * that requires the NDEFRecord constructor itself, which lib/ doesn't
 * depend on to avoid a circular import).
 *
 * Named `decodeRecord` (not `decodeWireRecord`) so it doesn't shadow
 * ndef-wire.ts's same-named helper that does the byte-level decoding +
 * TNF-range validation — this function delegates to that one to avoid
 * duplicating the base64 decode and the `0..7` TNF guard, which previously
 * let out-of-range TNFs through this layer to fall into the default
 * "unknown" branch instead of being rejected up-front like ndef-wire's
 * decodeWireRecord would.
 */
export function decodeRecord(record: NdefWireRecord): WebRecordFields {
  const {
    tnf,
    type: typeBytes,
    id: idBytes,
    payload: payloadBytes,
  } = decodeWireRecord(record);
  const id = idBytes.length > 0 ? bytesToString(idBytes) : undefined;

  switch (tnf) {
    case TNF.EMPTY:
      return {recordType: 'empty', id, data: new Uint8Array(0)};

    case TNF.WELL_KNOWN: {
      if (bytesEqual(typeBytes, RTD_TEXT)) {
        const {text, lang, encoding} = decodeTextPayload(payloadBytes);
        return {
          recordType: 'text',
          id,
          data: stringToBytes(text),
          encoding,
          lang,
        };
      }
      if (bytesEqual(typeBytes, RTD_URI)) {
        const uri = decodeUriPayload(payloadBytes);
        return {recordType: 'url', id, data: stringToBytes(uri)};
      }
      if (bytesEqual(typeBytes, RTD_SMART_POSTER)) {
        const nested = decodeNdefMessagePayload(payloadBytes);
        return {
          recordType: 'smart-poster',
          id,
          data: payloadBytes,
          toRecordsWire: nested,
        };
      }
      return {recordType: 'unknown', id, data: payloadBytes};
    }

    case TNF.MIME_MEDIA: {
      const mediaType = bytesToString(typeBytes) || 'application/octet-stream';
      return {recordType: 'mime', mediaType, id, data: payloadBytes};
    }

    case TNF.ABSOLUTE_URI: {
      // TNF 0x03: the *type* itself is the absolute URI; no RTD subtype.
      return {
        recordType: 'absolute-url',
        id,
        data: stringToBytes(bytesToString(typeBytes)),
      };
    }

    case TNF.EXTERNAL: {
      const externalType = bytesToString(typeBytes);
      if (!externalType) {
        throw new Error('malformed external record: empty type');
      }
      return {recordType: externalType, id, data: payloadBytes};
    }

    case TNF.UNKNOWN:
      return {recordType: 'unknown', id, data: payloadBytes};

    default:
      // Reached for any TNF value that passed ndef-wire's `0..7 integer`
      // guard but isn't one of the recognized cases above (TNF.UNCHANGED
      // 0x06 being the realistic one — only valid inside an NDEF message
      // chunk, never as a top-level record).
      throw new Error(`unsupported TNF for decode: ${record.tnf}`);
  }
}

/**
 * Decode a raw NDEF message byte sequence (as found inside a smart-poster
 * payload) into wire records. This is a minimal NDEF *message* framing
 * parser — not exposed publicly; nested smart-poster records are the only
 * user.
 */
function decodeNdefMessagePayload(bytes: Uint8Array): NdefWireRecord[] {
  const records: NdefWireRecord[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    const header = bytes[offset];
    const tnf = header & 0x07;
    const shortRecord = (header & 0x10) !== 0;
    const idLengthPresent = (header & 0x08) !== 0;
    offset += 1;

    if (offset >= bytes.length)
      throw new Error('malformed nested NDEF message: truncated');
    const typeLength = bytes[offset];
    offset += 1;

    let payloadLength: number;
    if (shortRecord) {
      if (offset >= bytes.length)
        throw new Error('malformed nested NDEF message: truncated');
      payloadLength = bytes[offset];
      offset += 1;
    } else {
      if (offset + 4 > bytes.length)
        throw new Error('malformed nested NDEF message: truncated');
      payloadLength =
        (bytes[offset] << 24) |
        (bytes[offset + 1] << 16) |
        (bytes[offset + 2] << 8) |
        bytes[offset + 3];
      offset += 4;
    }

    let idLength = 0;
    if (idLengthPresent) {
      if (offset >= bytes.length)
        throw new Error('malformed nested NDEF message: truncated');
      idLength = bytes[offset];
      offset += 1;
    }

    const typeBytes = bytes.subarray(offset, offset + typeLength);
    offset += typeLength;
    const idBytes = bytes.subarray(offset, offset + idLength);
    offset += idLength;
    const payloadBytes = bytes.subarray(offset, offset + payloadLength);
    offset += payloadLength;

    if (offset > bytes.length) {
      throw new Error('malformed nested NDEF message: length exceeds buffer');
    }

    records.push({
      tnf,
      type: bytesToBase64(typeBytes),
      id: bytesToBase64(idBytes),
      payload: bytesToBase64(payloadBytes),
    });
  }
  return records;
}

// --- Encode: WebRecordFields (write-side input) -> NdefWireRecord[] -------

/** Input shape for encoding one record on the write() path. */
export interface EncodeRecordInput {
  recordType: string;
  mediaType?: string;
  id?: string;
  data: Uint8Array;
  encoding?: string;
  lang?: string;
}

export function encodeWebRecord(input: EncodeRecordInput): NdefWireRecord {
  const idBytes =
    input.id !== undefined ? stringToBytes(input.id) : new Uint8Array(0);

  switch (input.recordType) {
    case 'text': {
      const encoding = input.encoding === 'utf-16' ? 'utf-16' : 'utf-8';
      const lang = input.lang ?? 'en';
      const text = bytesToString(input.data);
      const payload = encodeTextPayload(text, lang, encoding);
      return {
        tnf: TNF.WELL_KNOWN,
        type: RTD_TEXT_BASE64,
        id: bytesToBase64(idBytes),
        payload: bytesToBase64(payload),
      };
    }

    case 'url': {
      const uri = bytesToString(input.data);
      const payload = encodeUriPayload(uri);
      return {
        tnf: TNF.WELL_KNOWN,
        type: RTD_URI_BASE64,
        id: bytesToBase64(idBytes),
        payload: bytesToBase64(payload),
      };
    }

    case 'mime': {
      if (!input.mediaType) {
        throw new Error('mime record requires mediaType');
      }
      if (!isValidMimeType(input.mediaType)) {
        // Per the Web NFC spec, the mime record's mediaType is parsed as a
        // MIME type on write. Without this guard a caller can commit a
        // malformed value (e.g. "not-a-mime") to the tag and a conformant
        // reader later sees an NDEFRecord whose mediaType fails MIME
        // parsing — that should fail at write time with a SyntaxError, not
        // silently round-trip.
        throw new Error(
          `mime record mediaType is not a valid MIME type: ${input.mediaType}`,
        );
      }
      return {
        tnf: TNF.MIME_MEDIA,
        type: bytesToBase64(stringToBytes(input.mediaType)),
        id: bytesToBase64(idBytes),
        payload: bytesToBase64(input.data),
      };
    }

    case 'empty':
      return {
        tnf: TNF.EMPTY,
        type: EMPTY_BYTES_BASE64,
        id: bytesToBase64(idBytes),
        payload: EMPTY_BYTES_BASE64,
      };

    case 'absolute-url': {
      const uri = bytesToString(input.data);
      return {
        tnf: TNF.ABSOLUTE_URI,
        type: bytesToBase64(stringToBytes(uri)),
        id: bytesToBase64(idBytes),
        payload: EMPTY_BYTES_BASE64,
      };
    }

    case 'unknown':
      return {
        tnf: TNF.UNKNOWN,
        type: EMPTY_BYTES_BASE64,
        id: bytesToBase64(idBytes),
        payload: bytesToBase64(input.data),
      };

    default: {
      // Any other recordType string is treated as an external RTD type
      // (e.g. "example.com:custom") per the Web NFC spec's external-type
      // rules — colon-containing lowercase domain-prefixed identifiers.
      return {
        tnf: TNF.EXTERNAL,
        type: bytesToBase64(stringToBytes(input.recordType)),
        id: bytesToBase64(idBytes),
        payload: bytesToBase64(input.data),
      };
    }
  }
}
