/**
 * Web NFC NDEFRecordInit validation/coercion (§2, §5b). This is the
 * write()-side front door: turns whatever the caller passed
 * (string | BufferSource | NDEFMessageInit) into wire records via
 * well-known-records.ts's encoder, raising the exact spec error names
 * (§8) on malformed input.
 *
 * Zero react-native imports — portable to Node/Jest per §5.
 */
import {createDOMException, DOMException} from './dom-exception';
import {
  base64ToBytes,
  bytesToBase64,
  EMPTY_BYTES_BASE64,
  type NdefWireRecord,
  RTD_SMART_POSTER_BASE64,
  stringToBytes,
} from './ndef-wire';
import {encodeWebRecord} from './well-known-records';

/** Mirrors the Web NFC .d.ts shape (§2). */
export interface NDEFRecordInit {
  recordType: string;
  mediaType?: string;
  id?: string;
  data?: string | BufferSource | NDEFMessageInit;
  encoding?: string;
  lang?: string;
}

export interface NDEFMessageInit {
  records: NDEFRecordInit[];
}

/** The write()/scan-message argument shape (§2's "NDEFMessageSource"). */
export type NDEFMessageSource = string | BufferSource | NDEFMessageInit;

const MAX_RECURSION_DEPTH = 32; // generous bound; WPT's recursion-limit test wants *some* cap, not this exact number

function bufferSourceToBytes(source: BufferSource): Uint8Array {
  if (ArrayBuffer.isView(source)) {
    return new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
  }
  return new Uint8Array(source);
}

function isBufferSource(value: unknown): value is BufferSource {
  return (
    value instanceof ArrayBuffer ||
    (typeof ArrayBuffer !== 'undefined' &&
      ArrayBuffer.isView(value as ArrayBufferView))
  );
}

function isPlainMessageInit(value: unknown): value is NDEFMessageInit {
  return (
    value !== null &&
    typeof value === 'object' &&
    Array.isArray((value as NDEFMessageInit).records)
  );
}

/**
 * Validate + encode a single NDEFRecordInit into one or more wire records.
 * Most record types produce exactly one wire record; a record whose `data`
 * is itself an `NDEFMessageInit` (valid for any recordType per the spec's
 * recursive record model, exercised concretely by "smart-poster") requires
 * recursively encoding the nested message first.
 */
function encodeRecordInit(init: NDEFRecordInit, depth: number): NdefWireRecord {
  if (depth > MAX_RECURSION_DEPTH) {
    throw createDOMException(
      'SyntaxError',
      'NDEFMessageInit nesting exceeds the recursion limit',
    );
  }
  if (typeof init !== 'object' || init === null) {
    throw createDOMException('SyntaxError', 'NDEFRecordInit must be an object');
  }
  if (typeof init.recordType !== 'string' || init.recordType.length === 0) {
    throw createDOMException(
      'SyntaxError',
      'NDEFRecordInit.recordType must be a non-empty string',
    );
  }
  if (init.recordType === 'mime' && !init.mediaType) {
    throw createDOMException(
      'SyntaxError',
      'a "mime" record requires mediaType',
    );
  }
  if (
    init.encoding !== undefined &&
    init.encoding !== 'utf-8' &&
    init.encoding !== 'utf-16'
  ) {
    throw createDOMException(
      'SyntaxError',
      `unsupported encoding: ${init.encoding}`,
    );
  }
  if (init.encoding !== undefined && init.recordType !== 'text') {
    throw createDOMException(
      'SyntaxError',
      'encoding is only valid for "text" records',
    );
  }
  if (init.lang !== undefined && init.recordType !== 'text') {
    throw createDOMException(
      'SyntaxError',
      'lang is only valid for "text" records',
    );
  }

  const data = init.data;

  if (init.recordType === 'smart-poster') {
    // A smart-poster's data must itself be an NDEFMessageInit (or coercible
    // string/BufferSource is rejected — the spec requires structured content).
    if (!isPlainMessageInit(data)) {
      throw createDOMException(
        'SyntaxError',
        'a "smart-poster" record requires an NDEFMessageInit as data',
      );
    }
    if (data.records.length === 0) {
      // Mirrors the same-shape guard in coerceMessageSource() for the
      // top-level NDEFMessageInit: an empty smart-poster payload produces
      // a zero-record NDEF message that no conformant reader expects, so
      // reject the call synchronously rather than committing a malformed
      // record to the tag.
      throw createDOMException(
        'SyntaxError',
        'a "smart-poster" record requires at least one nested record',
      );
    }
    const nested = data.records.map(r => encodeRecordInit(r, depth + 1));
    return encodeSmartPoster(nested, init.id);
  }

  let bytes: Uint8Array;
  if (data === undefined) {
    bytes = new Uint8Array(0);
  } else if (typeof data === 'string') {
    bytes = stringToBytes(data);
  } else if (isBufferSource(data)) {
    bytes = bufferSourceToBytes(data);
  } else if (isPlainMessageInit(data)) {
    // A non-smart-poster record whose data is a nested message: encode the
    // message payload as raw bytes is not spec-defined for arbitrary
    // recordTypes — treat this the same permissive way well-known-records.ts
    // expects (encode nested records to a flat NDEF message byte sequence)
    // only for recordType values that are themselves message-shaped.
    throw createDOMException(
      'SyntaxError',
      `recordType "${init.recordType}" does not accept an NDEFMessageInit as data`,
    );
  } else {
    throw createDOMException(
      'SyntaxError',
      'NDEFRecordInit.data is not a valid BufferSource/string/NDEFMessageInit',
    );
  }

  try {
    return encodeWebRecord({
      recordType: init.recordType,
      mediaType: init.mediaType,
      id: init.id,
      data: bytes,
      encoding: init.encoding,
      lang: init.lang,
    });
  } catch (err) {
    // well-known-records.ts's encoder only ever throws plain Error instances.
    throw createDOMException('SyntaxError', (err as Error).message);
  }
}

function encodeSmartPoster(
  nested: NdefWireRecord[],
  id: string | undefined,
): NdefWireRecord {
  // Frame nested records into one flat NDEF message byte sequence (mirrors
  // well-known-records.ts's decoder for the same framing).
  const idBytes = id !== undefined ? stringToBytes(id) : new Uint8Array(0);
  const chunks: Uint8Array[] = [];
  nested.forEach((record, index) => {
    const typeBytes = base64ToBytes(record.type);
    const idBytesInner = base64ToBytes(record.id);
    const payloadBytes = base64ToBytes(record.payload);
    const isFirst = index === 0;
    const isLast = index === nested.length - 1;
    const shortRecord = payloadBytes.length <= 0xff;
    const idLengthPresent = idBytesInner.length > 0;

    let header = record.tnf & 0x07;
    if (isFirst) header |= 0x80; // MB
    if (isLast) header |= 0x40; // ME
    if (shortRecord) header |= 0x10; // SR
    if (idLengthPresent) header |= 0x08; // IL

    const parts: number[] = [header, typeBytes.length];
    if (shortRecord) {
      parts.push(payloadBytes.length);
    } else {
      parts.push(
        (payloadBytes.length >>> 24) & 0xff,
        (payloadBytes.length >>> 16) & 0xff,
        (payloadBytes.length >>> 8) & 0xff,
        payloadBytes.length & 0xff,
      );
    }
    if (idLengthPresent) {
      parts.push(idBytesInner.length);
    }
    chunks.push(new Uint8Array(parts), typeBytes, idBytesInner, payloadBytes);
  });

  const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
  const payload = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    payload.set(chunk, offset);
    offset += chunk.length;
  }

  return {
    tnf: 0x01, // WELL_KNOWN
    type: RTD_SMART_POSTER_BASE64,
    id: bytesToBase64(idBytes),
    payload: bytesToBase64(payload),
  };
}

/**
 * Coerce a write()-style NDEFMessageSource (string | BufferSource |
 * NDEFMessageInit) into one or more wire records (§2's behavioral note: a
 * bare string is always encoded as a single "text" record; strings are
 * never auto-detected as URLs).
 */
export function coerceMessageSource(
  source: NDEFMessageSource,
): NdefWireRecord[] {
  if (typeof source === 'string') {
    return [encodeRecordInit({recordType: 'text', data: source}, 0)];
  }
  if (isBufferSource(source)) {
    return [
      encodeRecordInit(
        {
          recordType: 'mime',
          mediaType: 'application/octet-stream',
          data: source,
        },
        0,
      ),
    ];
  }
  if (isPlainMessageInit(source)) {
    if (source.records.length === 0) {
      throw createDOMException(
        'SyntaxError',
        'NDEFMessageInit.records must not be empty',
      );
    }
    return source.records.map(r => encodeRecordInit(r, 0));
  }
  throw createDOMException(
    'SyntaxError',
    'message must be a string, BufferSource, or NDEFMessageInit',
  );
}

export {DOMException};
