/**
 * NfcClient (§6b): test helper wrapping a live NDEFReader — drive
 * scan/write/readMessage with timeouts, wait for reading events, and assert
 * no reading occurs within a window.
 */
import type {Event} from '../lib/event-target';
import type {NDEFMessageSource} from '../lib/web-record';
import type {
  NDEFMessage,
  NDEFReader,
  NDEFReadingEvent,
  NDEFWriteOptions,
} from '../WebNfcReader';
import {AssertionError, withTimeout} from './harness';

const DEFAULT_TIMEOUT_MS = 1000;

export class NfcClient {
  private readonly reader: NDEFReader;

  constructor(reader: NDEFReader) {
    this.reader = reader;
  }

  async scan(opts: {timeout?: number} = {}): Promise<void> {
    await withTimeout(
      this.reader.scan(),
      opts.timeout ?? DEFAULT_TIMEOUT_MS,
      'scan() timed out',
    );
  }

  async write(
    message: NDEFMessageSource,
    opts: NDEFWriteOptions & {timeout?: number} = {},
  ): Promise<void> {
    await withTimeout(
      this.reader.write(message, opts),
      opts.timeout ?? DEFAULT_TIMEOUT_MS,
      'write() timed out',
    );
  }

  /** Waits for the next `reading` event and resolves with its message. */
  async waitForReading(
    opts: {timeout?: number} = {},
  ): Promise<NDEFReadingEvent> {
    let listener!: (ev: Event) => void;
    try {
      return await withTimeout(
        new Promise<NDEFReadingEvent>(resolve => {
          listener = ev => resolve(ev as NDEFReadingEvent);
          this.reader.addEventListener('reading', listener);
        }),
        opts.timeout ?? DEFAULT_TIMEOUT_MS,
        'timed out waiting for a reading event',
      );
    } finally {
      // Also runs on the timeout path — without this, a timed-out wait
      // would leave its listener registered on the reader forever.
      this.reader.removeEventListener('reading', listener);
    }
  }

  async waitForReadingError(opts: {timeout?: number} = {}): Promise<Event> {
    let listener!: (ev: Event) => void;
    try {
      return await withTimeout(
        new Promise<Event>(resolve => {
          listener = ev => resolve(ev);
          this.reader.addEventListener('readingerror', listener);
        }),
        opts.timeout ?? DEFAULT_TIMEOUT_MS,
        'timed out waiting for a readingerror event',
      );
    } finally {
      this.reader.removeEventListener('readingerror', listener);
    }
  }

  /** Asserts no `reading` event fires within `ms`. */
  async expectNoReading(ms: number): Promise<void> {
    let listener!: () => void;
    let timer!: ReturnType<typeof setTimeout>;
    const result = await Promise.race([
      new Promise<'reading'>(resolve => {
        listener = () => resolve('reading');
        this.reader.addEventListener('reading', listener);
      }),
      new Promise<'timeout'>(resolve => {
        timer = setTimeout(() => resolve('timeout'), ms);
      }),
    ]);
    // Whichever branch lost the race left something dangling (an
    // unfired timer, or a listener still registered for a "reading" the
    // window has already passed) — clean up both regardless of outcome.
    clearTimeout(timer);
    this.reader.removeEventListener('reading', listener);
    if (result === 'reading') {
      throw new AssertionError('expected no reading event, but one occurred');
    }
  }

  close(): void {
    // NDEFReader has no explicit close(); callers abort via their own
    // signal if they started scan()/write() with one. This method exists
    // for symmetry with other test clients and as a hook for future
    // teardown needs.
  }
}

export type {NDEFMessage};
