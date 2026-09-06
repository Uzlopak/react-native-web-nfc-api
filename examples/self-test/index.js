/**
 * @format
 */

import {AppRegistry} from 'react-native';
import App from './App';
import {name as appName} from './app.json';

// Hermes (RN's default JS engine) does not implement the WHATWG
// TextEncoder/TextDecoder globals. react-native-web-nfc-api's lib/ndef-wire.ts
// uses them (UTF-8 <-> bytes) for the same reason any Web NFC/NDEF codec
// would on a real browser, where they're always present. This is a
// minimal, dependency-free polyfill covering exactly the UTF-8 encode/decode
// surface the library needs — not a general-purpose TextEncoder/TextDecoder
// implementation — so the example app can run the library unmodified on
// Hermes without pulling in a third-party polyfill package.
if (typeof global.TextEncoder === 'undefined') {
  class MinimalTextEncoder {
    encode(input = '') {
      const bytes = [];
      for (let i = 0; i < input.length; i++) {
        let codePoint = input.codePointAt(i);
        if (codePoint > 0xffff) i++; // consumed a surrogate pair
        if (codePoint < 0x80) {
          bytes.push(codePoint);
        } else if (codePoint < 0x800) {
          bytes.push(0xc0 | (codePoint >> 6), 0x80 | (codePoint & 0x3f));
        } else if (codePoint < 0x10000) {
          bytes.push(
            0xe0 | (codePoint >> 12),
            0x80 | ((codePoint >> 6) & 0x3f),
            0x80 | (codePoint & 0x3f),
          );
        } else {
          bytes.push(
            0xf0 | (codePoint >> 18),
            0x80 | ((codePoint >> 12) & 0x3f),
            0x80 | ((codePoint >> 6) & 0x3f),
            0x80 | (codePoint & 0x3f),
          );
        }
      }
      return new Uint8Array(bytes);
    }
  }
  global.TextEncoder = MinimalTextEncoder;
}

if (typeof global.TextDecoder === 'undefined') {
  class MinimalTextDecoder {
    decode(bytes = new Uint8Array(0)) {
      let result = '';
      let i = 0;
      while (i < bytes.length) {
        const b0 = bytes[i];
        if (b0 < 0x80) {
          result += String.fromCharCode(b0);
          i += 1;
        } else if ((b0 & 0xe0) === 0xc0) {
          const b1 = bytes[i + 1] ?? 0;
          result += String.fromCharCode(((b0 & 0x1f) << 6) | (b1 & 0x3f));
          i += 2;
        } else if ((b0 & 0xf0) === 0xe0) {
          const b1 = bytes[i + 1] ?? 0;
          const b2 = bytes[i + 2] ?? 0;
          result += String.fromCharCode(
            ((b0 & 0x0f) << 12) | ((b1 & 0x3f) << 6) | (b2 & 0x3f),
          );
          i += 3;
        } else {
          const b1 = bytes[i + 1] ?? 0;
          const b2 = bytes[i + 2] ?? 0;
          const b3 = bytes[i + 3] ?? 0;
          const codePoint =
            ((b0 & 0x07) << 18) |
            ((b1 & 0x3f) << 12) |
            ((b2 & 0x3f) << 6) |
            (b3 & 0x3f);
          result += String.fromCodePoint(codePoint);
          i += 4;
        }
      }
      return result;
    }
  }
  global.TextDecoder = MinimalTextDecoder;
}

AppRegistry.registerComponent(appName, () => App);
