/**
 * Single entry point on every platform (§1): NDEFReader, NDEFMessage,
 * NDEFRecord, NDEFReadingEvent, and the public option/init types.
 */

export {getNfcTransport, resetNfcTransport, setNfcTransport} from './NfcModule';
export type {NfcTransport} from './transport';
export type {
  NDEFMakeReadOnlyOptions,
  NDEFMessageInit,
  NDEFReaderOptions,
  NDEFReadingEventInit,
  NDEFRecordInit,
  NDEFScanOptions,
  NDEFWriteOptions,
} from './WebNfcReader';
export {
  NDEFMessage,
  NDEFReader,
  NDEFReadingEvent,
  NDEFRecord,
} from './WebNfcReader';
