/**
 * Conformance suite (§6c): transport-independent behavioral assertions from
 * §6e/§12f that hold for any correct NfcTransport, run here against
 * InMemoryNfcTransport via createTagFixture. Scenario structure ported from
 * WPT's NDEFReader_scan.https.html / NDEFReader_write.https.html per the
 * primitive-by-primitive mapping in §5f, not re-derived from the behavioral
 * matrix alone.
 *
 * This file is intentionally *.ts, not *.test.ts (§1's package layout) so it
 * can also be imported by the example app's Self-Test screen as
 * `runNfcConformance()` (§6c) — the actual Jest test file that runs it in
 * this repo is `conformance-suite.test.ts`.
 */
import {AbortControllerImpl} from '../lib/abort-signal';
import {encodeWebRecord} from '../lib/well-known-records';
import {getNfcTransport, setNfcTransport} from '../NfcModule';
import {NfcClient} from '../testing/client';
import {createTagFixture} from '../testing/fixtures';
import {
  assertRejectsWithName,
  assertWebNDEFMessagesEqual,
  createMessage,
  createTextRecord,
  createUrlRecord,
} from '../testing/harness';
import {
  EmptyTag,
  FlakyTag,
  MultiRecordTag,
  NonNdefTag,
  ReadOnlyTag,
  SlowTag,
  TextTag,
  UrlTag,
} from '../testing/simulated-tag';
import {NDEFMessage, NDEFReader} from '../WebNfcReader';

export interface ConformanceResult {
  name: string;
  passed: boolean;
  error?: string;
}

export interface ConformanceCase {
  name: string;
  run: () => Promise<void>;
}

/**
 * The transport-independent behavioral assertions (§6c). Exported as plain
 * {name, run} cases so both Jest (conformance-suite.test.ts) and the example
 * app's Self-Test screen (§10) can drive them and report per-row pass/fail.
 */
export const conformanceCases: ConformanceCase[] = [
  {
    name: 'scan(): tag with zero records fires reading with message.records = [] (WPT scan.https.html:268-282)',
    async run() {
      const {reader, tagHandle} = createTagFixture(new EmptyTag());
      const client = new NfcClient(reader);
      await client.scan();
      const ev = await client.waitForReading();
      if (ev.message.records.length !== 0)
        throw new Error('expected zero records');
      void tagHandle;
    },
  },
  {
    name: 'scan(): a text tag delivers the expected NDEFMessage (round trip via InMemoryNfcTransport)',
    async run() {
      const {reader} = createTagFixture(
        new TextTag({text: 'hello', lang: 'en'}),
      );
      const client = new NfcClient(reader);
      await client.scan();
      const ev = await client.waitForReading();
      const expected = new NDEFMessage(
        createMessage([createTextRecord('hello', {lang: 'en'})]),
      );
      assertWebNDEFMessagesEqual(ev.message, expected);
    },
  },
  {
    name: 'scan(): a url tag delivers the expected NDEFMessage',
    async run() {
      const {reader} = createTagFixture(
        new UrlTag({url: 'https://example.com'}),
      );
      const client = new NfcClient(reader);
      await client.scan();
      const ev = await client.waitForReading();
      const expected = new NDEFMessage(
        createMessage([createUrlRecord('https://example.com')]),
      );
      assertWebNDEFMessagesEqual(ev.message, expected);
    },
  },
  {
    name: 'scan(): a smart-poster-bearing MultiRecordTag exposes toRecords() on the nested record',
    async run() {
      const posterRecord = encodeWebRecord({
        recordType: 'url',
        data: new TextEncoder().encode('https://x'),
      });
      const smartPoster = {
        tnf: 0x01,
        type: btoa('Sp'),
        id: '',
        payload: (() => {
          const typeBytes = new TextEncoder().encode('U');
          const payloadBytes = Uint8Array.from(atob(posterRecord.payload), c =>
            c.charCodeAt(0),
          );
          const header = 0x80 | 0x40 | 0x10 | 0x01;
          const bytes = new Uint8Array([
            header,
            typeBytes.length,
            payloadBytes.length,
            ...typeBytes,
            ...payloadBytes,
          ]);
          return btoa(String.fromCharCode(...bytes));
        })(),
      };
      const {reader} = createTagFixture(
        new MultiRecordTag({records: [smartPoster]}),
      );
      const client = new NfcClient(reader);
      await client.scan();
      const ev = await client.waitForReading();
      if (ev.message.records[0].recordType !== 'smart-poster')
        throw new Error('expected smart-poster');
      const nested = ev.message.records[0].toRecords?.();
      if (nested?.length !== 1 || nested[0].recordType !== 'url') {
        throw new Error('expected exactly one nested url record');
      }
    },
  },
  {
    name: 'scan(): a non-NDEF tag fires readingerror, not reading (WPT scan.https.html:248-266)',
    async run() {
      const {reader} = createTagFixture(new NonNdefTag());
      const client = new NfcClient(reader);
      await client.scan();
      await client.waitForReadingError();
    },
  },
  {
    name: 'scan(): same-reader re-scan rejects InvalidStateError (WPT scan.https.html:307-314)',
    async run() {
      const {reader} = createTagFixture(new EmptyTag());
      await reader.scan();
      await assertRejectsWithName(reader.scan(), 'InvalidStateError');
    },
  },
  {
    name: 'scan(): a second, independent NDEFReader can scan concurrently and both receive reading (broadcast, §5d)',
    async run() {
      // Two independent `new NDEFReader({mode: 'managed'})` instances only
      // share a transport via the global setNfcTransport() seam (unlike
      // every other case here, which uses createTagFixture()'s single-reader
      // shape) — so this case must touch the global override. Whatever the
      // host app (or a previous fixture) had installed there is saved and
      // restored, rather than force-reset to null, so running this suite
      // from inside a real app's Self-Test screen doesn't clobber that app's
      // own globally-installed demo transport as a side effect.
      const previousTransport = getNfcTransport();
      const {transport} = createTagFixture();
      setNfcTransport(transport);
      try {
        const readerA = new NDEFReader({mode: 'managed'});
        const readerB = new NDEFReader({mode: 'managed'});
        const clientA = new NfcClient(readerA);
        const clientB = new NfcClient(readerB);
        await clientA.scan();
        await clientB.scan();
        transport.addTag(new TextTag({text: 'broadcast'}));
        const [evA, evB] = await Promise.all([
          clientA.waitForReading(),
          clientB.waitForReading(),
        ]);
        if (
          evA.message.records.length !== 1 ||
          evB.message.records.length !== 1
        ) {
          throw new Error('expected both readers to receive the reading');
        }
      } finally {
        setNfcTransport(previousTransport);
      }
    },
  },
  {
    name: 'scan(): abort() before the operation starts rejects AbortError (WPT scan.https.html:110-115)',
    async run() {
      const {reader} = createTagFixture(new EmptyTag());
      const controller = new AbortControllerImpl();
      controller.abort();
      await assertRejectsWithName(
        reader.scan({signal: controller.signal}),
        'AbortError',
      );
    },
  },
  {
    name: 'scan(): abort() mid-operation rejects AbortError (WPT scan.https.html:117-124)',
    async run() {
      const {reader} = createTagFixture(new EmptyTag());
      const controller = new AbortControllerImpl();
      const client = new NfcClient(reader);
      const scanPromise = reader.scan({signal: controller.signal});
      await scanPromise;
      const errorPromise = client.waitForReadingError();
      controller.abort();
      await errorPromise;
    },
  },
  {
    name: 'write(): a bare string is coerced to a single text record (WPT write.https.html:350-367)',
    async run() {
      const tag = new EmptyTag();
      const {reader, tagHandle} = createTagFixture(tag);
      await reader.write('hello');
      if (!tagHandle) throw new Error('expected a tag handle');
      if (tagHandle.tag.lastWrite?.records[0].tnf !== 0x01)
        throw new Error('expected a well-known text record');
    },
  },
  {
    name: 'write(): overwrite:false on a tag with existing records rejects NotAllowedError (WPT write.https.html:466-472)',
    async run() {
      const existing = encodeWebRecord({
        recordType: 'text',
        data: new TextEncoder().encode('existing'),
      });
      const {reader} = createTagFixture(
        new MultiRecordTag({records: [existing]}),
      );
      await assertRejectsWithName(
        reader.write('new', {overwrite: false}),
        'NotAllowedError',
      );
    },
  },
  {
    name: 'write(): targeting a ReadOnlyTag rejects InvalidStateError (§6e)',
    async run() {
      const {reader} = createTagFixture(new ReadOnlyTag());
      await assertRejectsWithName(reader.write('x'), 'InvalidStateError');
    },
  },
  {
    name: 'write(): a second write() replaces the first, which rejects AbortError, not InvalidStateError (WPT write.https.html:389-412)',
    async run() {
      const {reader, transport} = createTagFixture(undefined, {
        requireExplicitTap: true,
      });
      const firstPromise = reader.write('first');
      const secondPromise = reader.write('second');
      const rejection = await assertRejectsWithName(firstPromise, 'AbortError');
      if ((rejection as {name: string}).name === 'InvalidStateError') {
        throw new Error('must not be InvalidStateError');
      }
      const tag = new EmptyTag();
      transport.addTag(tag);
      await secondPromise;
    },
  },
  {
    name: 'makeReadOnly(): on an already-read-only tag resolves as a no-op (§6e)',
    async run() {
      const {reader} = createTagFixture(new ReadOnlyTag());
      await reader.makeReadOnly();
    },
  },
  {
    name: 'write(): FlakyTag failing the first write rejects NetworkError, second write succeeds (§5f simulateDataTransferFails)',
    async run() {
      const tag = new FlakyTag({failOnAttempt: 1});
      const {reader} = createTagFixture(tag);
      await assertRejectsWithName(reader.write('x'), 'NetworkError');
      await reader.write('y');
    },
  },
  {
    name: 'write(): TagHandle.failNextWrite() rejects the next write with NetworkError',
    async run() {
      const tag = new EmptyTag();
      const {reader, tagHandle} = createTagFixture(tag);
      tagHandle?.failNextWrite();
      await assertRejectsWithName(reader.write('x'), 'NetworkError');
    },
  },
  {
    name: 'hardware disabled: scan()/write() reject NotReadableError',
    async run() {
      const {reader, transport} = createTagFixture(new EmptyTag());
      transport.setHardwareStatus('disabled');
      await assertRejectsWithName(reader.scan(), 'NotReadableError');
      await assertRejectsWithName(reader.write('x'), 'NotReadableError');
    },
  },
  {
    name: 'no hardware: scan()/write()/makeReadOnly() reject NotSupportedError',
    async run() {
      const {reader, transport} = createTagFixture(new EmptyTag());
      transport.setHardwareStatus('not-supported');
      await assertRejectsWithName(reader.scan(), 'NotSupportedError');
      await assertRejectsWithName(reader.write('x'), 'NotSupportedError');
      await assertRejectsWithName(reader.makeReadOnly(), 'NotSupportedError');
    },
  },
  {
    name: 'non-AbortSignal value passed as signal throws TypeError, not a DOMException',
    async run() {
      const {reader} = createTagFixture(new EmptyTag());
      let threw: unknown;
      try {
        await reader.scan({signal: 'not-a-signal' as never});
      } catch (err) {
        threw = err;
      }
      if (!(threw instanceof TypeError))
        throw new Error('expected a TypeError');
    },
  },
  {
    name: 'write() suspends an active scan and resumes it afterward (§5a/§5d RN policy)',
    async run() {
      const {reader, transport} = createTagFixture(undefined, {
        requireExplicitTap: true,
      });
      const client = new NfcClient(reader);
      await client.scan();
      const writePromise = reader.write('x');
      const tag = new EmptyTag();
      transport.addTag(tag);
      await writePromise;
      // Scan should have resumed; presenting (and tapping, since this
      // transport requires an explicit tap) a second tag should deliver a
      // reading event under the new post-write scan operation.
      const secondTag = new TextTag({text: 'resumed'});
      const secondHandle = transport.addTag(secondTag);
      secondHandle.tap();
      await client.waitForReading();
    },
  },
  {
    name: 'SlowTag: aborting mid-write while native is still working rejects AbortError promptly',
    async run() {
      const {reader} = createTagFixture(new SlowTag({delayMs: 5000}));
      const controller = new AbortControllerImpl();
      const writePromise = reader.write('x', {signal: controller.signal});
      // Abort in the very same tick, before write()'s internal
      // isSupported()/isEnabled() awaits have resolved and the abort
      // listener has even been attached — this exercises the
      // already-aborted-by-the-time-we-attach race explicitly.
      controller.abort();
      await assertRejectsWithName(writePromise, 'AbortError');
    },
  },
];

/**
 * Runs every conformance case and collects pass/fail per row — used by the
 * example app's Self-Test screen (§6c, §10) as well as the Jest wrapper.
 */
export async function runNfcConformance(): Promise<ConformanceResult[]> {
  const results: ConformanceResult[] = [];
  for (const testCase of conformanceCases) {
    try {
      await testCase.run();
      results.push({name: testCase.name, passed: true});
    } catch (err) {
      results.push({
        name: testCase.name,
        passed: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return results;
}
