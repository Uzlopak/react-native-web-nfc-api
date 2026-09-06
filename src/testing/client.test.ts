/**
 * Direct coverage for NfcClient (§6b): every method wraps an NDEFReader call
 * (or event wait) in withTimeout(), so each needs both a success path and a
 * timeout path exercised — a bug in either wiring would make every
 * conformance test using NfcClient hang or falsely pass/fail.
 */
import {Event} from '../lib/event-target';
import {createTagFixture} from './fixtures';
import {EmptyTag, TextTag} from './simulated-tag';
import {NfcClient} from './client';
import {AssertionError} from './harness';

describe('NfcClient.scan()', () => {
  test('resolves once the underlying reader.scan() resolves', async () => {
    const {reader} = createTagFixture(new EmptyTag());
    const client = new NfcClient(reader);
    await expect(client.scan()).resolves.toBeUndefined();
  });

  test('rejects with AssertionError if scan() does not settle within the timeout', async () => {
    const reader = {
      scan: () => new Promise<void>(() => {}),
    } as unknown as ConstructorParameters<typeof NfcClient>[0];
    const client = new NfcClient(reader);
    await expect(client.scan({timeout: 5})).rejects.toThrow(AssertionError);
    await expect(client.scan({timeout: 5})).rejects.toThrow(
      'scan() timed out',
    );
  });
});

describe('NfcClient.write()', () => {
  test('resolves once the underlying reader.write() resolves', async () => {
    const {reader} = createTagFixture(new EmptyTag());
    const client = new NfcClient(reader);
    await expect(client.write('hello')).resolves.toBeUndefined();
  });

  test('rejects with AssertionError if write() does not settle within the timeout', async () => {
    const reader = {
      write: () => new Promise<void>(() => {}),
    } as unknown as ConstructorParameters<typeof NfcClient>[0];
    const client = new NfcClient(reader);
    await expect(client.write('x', {timeout: 5})).rejects.toThrow(
      'write() timed out',
    );
  });
});

describe('NfcClient.waitForReading()', () => {
  test('resolves with the reading event once one is dispatched', async () => {
    const {reader} = createTagFixture(new TextTag({text: 'hi'}));
    const client = new NfcClient(reader);
    const waitPromise = client.waitForReading();
    await reader.scan();
    const ev = await waitPromise;
    expect(ev.type).toBe('reading');
  });

  test('rejects with AssertionError if no reading event fires within the timeout', async () => {
    const {reader} = createTagFixture(); // no tag: nothing will ever be discovered
    const client = new NfcClient(reader);
    await expect(client.waitForReading({timeout: 5})).rejects.toThrow(
      'timed out waiting for a reading event',
    );
  });
});

describe('NfcClient.waitForReadingError()', () => {
  test('resolves with the readingerror event once one is dispatched', async () => {
    const {reader} = createTagFixture();
    const client = new NfcClient(reader);
    const waitPromise = client.waitForReadingError();
    reader.dispatchEvent(new Event('readingerror'));
    const ev = await waitPromise;
    expect(ev.type).toBe('readingerror');
  });

  test('rejects with AssertionError if no readingerror event fires within the timeout', async () => {
    const {reader} = createTagFixture();
    const client = new NfcClient(reader);
    await expect(client.waitForReadingError({timeout: 5})).rejects.toThrow(
      'timed out waiting for a readingerror event',
    );
  });
});

describe('NfcClient.expectNoReading()', () => {
  test('resolves when no reading event fires within the window', async () => {
    const {reader} = createTagFixture();
    const client = new NfcClient(reader);
    await expect(client.expectNoReading(5)).resolves.toBeUndefined();
  });

  test('throws AssertionError when a reading event does fire within the window', async () => {
    const {reader} = createTagFixture(new TextTag({text: 'hi'}));
    const client = new NfcClient(reader);
    const expectPromise = client.expectNoReading(200);
    await reader.scan();
    await expect(expectPromise).rejects.toThrow(
      'expected no reading event, but one occurred',
    );
  });
});

describe('NfcClient.close()', () => {
  test('is a callable no-op', () => {
    const {reader} = createTagFixture();
    const client = new NfcClient(reader);
    expect(() => client.close()).not.toThrow();
  });
});
