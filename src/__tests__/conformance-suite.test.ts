/**
 * Jest wrapper for the conformance suite (§6c): runs each transport-
 * independent behavioral case as its own Jest test, so failures show up
 * individually rather than as one aggregate pass/fail.
 */
import {resetNfcTransport} from '../NfcModule';
import {conformanceCases} from './conformance-suite';

afterEach(() => {
  resetNfcTransport();
});

describe('conformance suite (§6c) — against InMemoryNfcTransport', () => {
  for (const testCase of conformanceCases) {
    test(testCase.name, async () => {
      await testCase.run();
    });
  }
});
