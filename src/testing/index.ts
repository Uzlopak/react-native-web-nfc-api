/**
 * Public testing subpath export (§1, §6): react-native-web-nfc-api/testing.
 * Test-only code — never imported from the main entry point — so it (and
 * its consumers) never ships as part of the production bundle path.
 */

export {NfcClient} from './client';
export {
  type CreateTagFixtureOptions,
  createTagFixture,
  type TagFixture,
} from './fixtures';
export {
  AssertionError,
  assert,
  assertEqual,
  assertRejects,
  assertRejectsWithName,
  assertWebNDEFMessagesEqual,
  createMessage,
  createMimeRecord,
  createRecord,
  createTextRecord,
  createUnknownRecord,
  createUrlRecord,
  withTimeout,
} from './harness';
export {
  type HardwareStatus,
  InMemoryNfcTransport,
  type InMemoryNfcTransportOptions,
  TagHandle,
} from './in-memory-transport';
export {
  EmptyTag,
  FlakyTag,
  type LastWrite,
  MultiRecordTag,
  NonNdefTag,
  ReadOnlyTag,
  SimulatedTag,
  SlowTag,
  TextTag,
  UrlTag,
} from './simulated-tag';
