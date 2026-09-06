/**
 * The lossless native wire format (§5b). Native produces/consumes exactly
 * this shape — TNF + type + id + payload, base64-encoded — and never
 * interprets NDEF bytes into Web NFC semantics. All RTD/text-encoding/URI
 * interpretation happens once, in `well-known-records.ts`.
 */

/** NFC Forum Type Name Format values (3-bit field, first byte of a record header). */
export const TNF = {
  EMPTY: 0x00,
  WELL_KNOWN: 0x01,
  MIME_MEDIA: 0x02,
  ABSOLUTE_URI: 0x03,
  EXTERNAL: 0x04,
  UNKNOWN: 0x05,
  UNCHANGED: 0x06,
} as const;

export type TnfValue = (typeof TNF)[keyof typeof TNF];

export interface NdefWireRecord {
  tnf: number;
  /** base64-encoded type bytes (may be empty string). */
  type: string;
  /** base64-encoded id bytes (may be empty string). */
  id: string;
  /** base64-encoded payload bytes (may be empty string). */
  payload: string;
}

// --- base64 <-> Uint8Array, portable across Node/Jest and Hermes ---------

const BASE64_CHARS =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function bytesToBase64(bytes: Uint8Array): string {
  if (bytes.length === 0) return '';
  // Push chunks into a fixed array of 4-char groups and join once. Each
  // 24-bit input produces exactly 4 base64 chars (with '=' for trailing
  // 1 or 2 input bytes), so we can size the buffer exactly.
  const quads = Math.floor(bytes.length / 3);
  const remainder = bytes.length - quads * 3;
  const totalLen = quads * 4 + (remainder === 0 ? 0 : remainder + 1);
  const parts: string[] = new Array((totalLen / 4) | 0);

  let p = 0;
  for (let i = 0; i < quads; i++) {
    const j = i * 3;
    const b0 = bytes[j];
    const b1 = bytes[j + 1];
    const b2 = bytes[j + 2];
    const chunk = (b0 << 16) | (b1 << 8) | b2;
    parts[p++] =
      BASE64_CHARS[(chunk >> 18) & 0x3f] +
      BASE64_CHARS[(chunk >> 12) & 0x3f] +
      BASE64_CHARS[(chunk >> 6) & 0x3f] +
      BASE64_CHARS[chunk & 0x3f];
  }
  if (remainder === 1) {
    const b0 = bytes[quads * 3];
    const chunk = b0 << 16;
    parts[p++] =
      BASE64_CHARS[(chunk >> 18) & 0x3f] +
      BASE64_CHARS[(chunk >> 12) & 0x3f] +
      '==';
  } else if (remainder === 2) {
    const j = quads * 3;
    const chunk = (bytes[j] << 16) | (bytes[j + 1] << 8);
    parts[p++] =
      BASE64_CHARS[(chunk >> 18) & 0x3f] +
      BASE64_CHARS[(chunk >> 12) & 0x3f] +
      BASE64_CHARS[(chunk >> 6) & 0x3f] +
      '=';
  }
  return parts.join('');
}

const BASE64_LOOKUP: Record<string, number> = {};
for (let i = 0; i < BASE64_CHARS.length; i++) {
  BASE64_LOOKUP[BASE64_CHARS[i]] = i;
}

export function base64ToBytes(base64: string): Uint8Array {
  const clean = base64.replace(/=+$/, '');
  if (clean.length === 0) {
    return new Uint8Array(0);
  }
  // Compute exact output length up front (3 output bytes per 4 input chars,
  // minus 1 or 2 for a trailing partial quad) and write directly into a
  // single Uint8Array — avoids the throwaway number[] + second memcpy that
  // the original implementation did.
  const fullQuads = Math.floor(clean.length / 4);
  const tailChars = clean.length - fullQuads * 4;
  let outLen = fullQuads * 3;
  if (tailChars >= 2) outLen += tailChars - 1;
  const out = new Uint8Array(outLen);

  let w = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const c0 = BASE64_LOOKUP[clean[i]];
    const c1 = BASE64_LOOKUP[clean[i + 1]];
    const c2 =
      clean[i + 2] === undefined ? undefined : BASE64_LOOKUP[clean[i + 2]];
    const c3 =
      clean[i + 3] === undefined ? undefined : BASE64_LOOKUP[clean[i + 3]];
    if (c0 === undefined || c1 === undefined) {
      throw new Error('malformed base64 input');
    }
    if (c3 !== undefined && c2 === undefined) {
      // Malformed 4-char quad like "AB=C": c2 is undefined but c3 is set.
      // Without this guard we'd write ((undefined & 0x3) << 6) | c3 — a
      // NaN-tainted byte that silently masks payload corruption as a
      // wrong-but-valid byte sequence.
      throw new Error('malformed base64 input');
    }
    out[w++] = (c0 << 2) | (c1 >> 4);
    if (c2 !== undefined) {
      out[w++] = ((c1 & 0xf) << 4) | (c2 >> 2);
    }
    if (c3 !== undefined) {
      out[w++] = ((c2! & 0x3) << 6) | c3;
    }
  }
  return out;
}

// Both TextEncoder and TextDecoder are safe to reuse across single-shot
// encode/decode calls (they're stateless for full-string/full-buffer
// inputs — only multi-chunk streaming builds up state on TextDecoder, and
// we never stream here). Caching the instances avoids constructing a new
// pair on every NDEF record round-trip, which matters on the
// scan→build-message→user-callback hot path where a single multi-record
// tag invokes these helpers 4-5x per record.
const SHARED_TEXT_ENCODER = new TextEncoder();
const SHARED_TEXT_DECODER = new TextDecoder();

export function stringToBytes(str: string): Uint8Array {
  return SHARED_TEXT_ENCODER.encode(str);
}

export function bytesToString(bytes: Uint8Array): string {
  return SHARED_TEXT_DECODER.decode(bytes);
}

// --- NdefWireRecord construction helpers ----------------------------------

export interface NdefWireRecordBytes {
  tnf: number;
  type: Uint8Array;
  id: Uint8Array;
  payload: Uint8Array;
}

// --- Pre-encoded constants for the well-known RTD type bytes ----------------
// These are recomputed inside encodeWebRecord() on every record of every
// write(); they depend on nothing user-controlled so we hoist them to
// module scope so the encoder just references the strings instead of
// calling bytesToBase64() each time.

/** base64 of an empty Uint8Array. */
export const EMPTY_BYTES_BASE64 = '';
/** base64 of the bytes "T" (NFC Forum Text RTD type). */
export const RTD_TEXT_BASE64 = 'VA==';
/** base64 of the bytes "U" (NFC Forum URI RTD type). */
export const RTD_URI_BASE64 = 'VQ==';
/** base64 of the bytes "Sp" (NFC Forum Smart Poster RTD type). */
export const RTD_SMART_POSTER_BASE64 = 'U3A=';
/** base64 of an empty id bytes payload (no id on the record). */
export const EMPTY_ID_BYTES_BASE64 = '';

export function encodeWireRecord(record: NdefWireRecordBytes): NdefWireRecord {
  if (record.tnf < 0 || record.tnf > 7 || !Number.isInteger(record.tnf)) {
    throw new Error(`invalid TNF value: ${record.tnf}`);
  }
  return {
    tnf: record.tnf,
    type: bytesToBase64(record.type),
    id: bytesToBase64(record.id),
    payload: bytesToBase64(record.payload),
  };
}

export function decodeWireRecord(record: NdefWireRecord): NdefWireRecordBytes {
  if (record.tnf < 0 || record.tnf > 7 || !Number.isInteger(record.tnf)) {
    throw new Error(`invalid TNF value: ${record.tnf}`);
  }
  return {
    tnf: record.tnf,
    type: base64ToBytes(record.type),
    id: base64ToBytes(record.id),
    payload: base64ToBytes(record.payload),
  };
}
