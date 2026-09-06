/**
 * createTagFixture (§6b): builds an InMemoryNfcTransport + managed-mode
 * NDEFReader in one call, so conformance-suite tests don't repeat the same
 * boilerplate.
 */
import {getNfcTransport, setNfcTransport} from '../NfcModule';
import {NDEFReader} from '../WebNfcReader';
import {
  InMemoryNfcTransport,
  type InMemoryNfcTransportOptions,
  type TagHandle,
} from './in-memory-transport';
import type {SimulatedTag} from './simulated-tag';

export interface CreateTagFixtureOptions extends InMemoryNfcTransportOptions {
  /** Installs the transport globally via setNfcTransport() (§6b). */
  installGlobally?: boolean;
}

export interface TagFixture {
  transport: InMemoryNfcTransport;
  reader: NDEFReader;
  /** The handle for the first tag passed in (undefined if none was given). */
  tagHandle: TagHandle | undefined;
  /** Handles for every tag passed in, in order. */
  tagHandles: TagHandle[];
}

export function createTagFixture(
  tag?: SimulatedTag | SimulatedTag[],
  opts: CreateTagFixtureOptions = {},
): TagFixture {
  const transport = new InMemoryNfcTransport(opts);
  const tags = tag === undefined ? [] : Array.isArray(tag) ? tag : [tag];
  const tagHandles = tags.map(t => transport.addTag(t));

  if (opts.installGlobally) {
    setNfcTransport(transport);
  }

  const reader = opts.installGlobally
    ? new NDEFReader({mode: 'managed'})
    : createManagedReaderForTransport(transport);

  return {transport, reader, tagHandle: tagHandles[0], tagHandles};
}

/**
 * Builds a managed-mode NDEFReader bound to a specific transport without
 * installing it globally — used when a test wants an isolated fixture that
 * doesn't affect setNfcTransport()'s global override.
 *
 * NDEFReader's ManagedStrategy captures the NfcTransport reference once, at
 * construction time (it never re-queries getNfcTransport() later), so it's
 * safe to install the transport only transiently here and restore the
 * override to whatever it was immediately beforehand — the constructed
 * reader keeps its own reference regardless. Restoring the *prior* value
 * (rather than unconditionally clearing to "no override") matters when this
 * conformance suite runs inside a real host app (e.g. an example app's
 * Self-Test screen, §6c) that has already globally installed its own demo
 * transport via setNfcTransport() before the suite runs — an isolated
 * fixture must not permanently clobber that as a side effect of running.
 */
function createManagedReaderForTransport(
  transport: InMemoryNfcTransport,
): NDEFReader {
  const previousTransport = getNfcTransport();
  setNfcTransport(transport);
  const reader = new NDEFReader({mode: 'managed'});
  setNfcTransport(previousTransport);
  return reader;
}
