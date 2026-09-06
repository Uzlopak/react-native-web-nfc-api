/**
 * createTagFromSpec() coverage (§6f). The CI test rig used to verify
 * --tag spec parsing only checked that the right SimulatedTag subclass was
 * picked; it didn't decode the wire payload, so the pre-fix bug (the
 * 'readonly:' branch skipping the NFC Forum Text RTD status byte) was
 * uncovered until a downstream reader tried to interpret the tag.
 */
import {bytesToString} from '../lib/ndef-wire';
import {decodeRecord} from '../lib/well-known-records';
import {
  EmptyTag,
  MultiRecordTag,
  ReadOnlyTag,
  SimulatedTag,
  TextTag,
  UrlTag,
} from '../testing/simulated-tag';
import {
  attachBridge,
  createTagFromSpec,
  exposeSimulatedTag,
  installInMemoryNfcTransport,
  parseBridgeArgs,
  type WebSocketServerLike,
  type WsLike,
} from './bridge';

describe('createTagFromSpec', () => {
  test('text:<value> produces a TextTag with the given text', () => {
    const tag = createTagFromSpec('text:hi');
    expect(tag).toBeInstanceOf(TextTag);
    const decoded = decodeRecord(tag.records[0]);
    expect(decoded.recordType).toBe('text');
    expect(bytesToString(decoded.data)).toBe('hi');
  });

  test('text: with no value uses the default text', () => {
    const tag = createTagFromSpec('text:');
    const decoded = decodeRecord(tag.records[0]);
    expect(bytesToString(decoded.data)).toBe('hello from a virtual tag');
  });

  test('url:<value> produces a UrlTag with the given URL', () => {
    const tag = createTagFromSpec('url:https://foo.example');
    expect(tag).toBeInstanceOf(UrlTag);
    const decoded = decodeRecord(tag.records[0]);
    expect(decoded.recordType).toBe('url');
    expect(bytesToString(decoded.data)).toBe('https://foo.example');
  });

  test('url: with no value uses the default URL', () => {
    const tag = createTagFromSpec('url:');
    const decoded = decodeRecord(tag.records[0]);
    expect(bytesToString(decoded.data)).toBe('https://example.com');
  });

  test('readonly:<value> produces a wire record whose text decodes back to the value (regression: finding #4)', () => {
    // Before the fix the 'readonly:' branch built the text payload as
    // btoa('en' + value), omitting the required leading status byte (lang
    // length + UTF-16 flag). well-known-records.ts's decodeTextPayload then
    // read 'e' (0x65) as the status byte, computed langLength = 0x65 &
    // 0x3f = 37, and threw "malformed text record" for any reader scanning
    // the tag. After the fix, encodeWebRecord() emits the status byte and
    // the round-trip decodes cleanly.
    const tag = createTagFromSpec('readonly:hello');
    expect(tag).toBeInstanceOf(ReadOnlyTag);
    expect(tag.writable).toBe(false);
    const decoded = decodeRecord(tag.records[0]);
    expect(decoded.recordType).toBe('text');
    expect(bytesToString(decoded.data)).toBe('hello');
    expect(decoded.lang).toBe('en');
  });

  test('readonly: with no value uses the default text', () => {
    const tag = createTagFromSpec('readonly:');
    const decoded = decodeRecord(tag.records[0]);
    expect(bytesToString(decoded.data)).toBe('read-only tag');
  });

  test('empty produces an EmptyTag with no records', () => {
    const tag = createTagFromSpec('empty');
    expect(tag).toBeInstanceOf(EmptyTag);
    expect(tag.records).toHaveLength(0);
  });

  test('json:<path> produces a MultiRecordTag from the file the injected readFile returns', () => {
    const records = [{tnf: 1, type: 'VA==', id: '', payload: 'AmVu'}];
    const readFile = jest.fn().mockReturnValue(JSON.stringify(records));
    const tag = createTagFromSpec('json:/tmp/tag.json', readFile);
    expect(readFile).toHaveBeenCalledWith('/tmp/tag.json');
    expect(tag).toBeInstanceOf(MultiRecordTag);
    expect(tag.records).toEqual(records);
  });

  test('json:<path> without an injected readFile throws', () => {
    expect(() => createTagFromSpec('json:/tmp/tag.json')).toThrow(
      'json: tag spec requires a readFile implementation',
    );
  });

  test('an unrecognized spec throws', () => {
    expect(() => createTagFromSpec('bogus:x')).toThrow(
      /unrecognized --tag spec "bogus:x"/,
    );
  });

  test('a spec with no colon at all is treated as the whole kind (and rejected unless it matches "empty")', () => {
    expect(() => createTagFromSpec('nocolon')).toThrow(
      /unrecognized --tag spec "nocolon"/,
    );
  });
});

describe('parseBridgeArgs', () => {
  test('defaults when no args or env are given', () => {
    const args = parseBridgeArgs([]);
    expect(args).toEqual({
      tag: 'text:hello from a virtual tag',
      wsPort: 8787,
      host: '127.0.0.1',
      allowRemote: false,
      help: false,
    });
  });

  test('-t/--tag, -w/--port, --host, --allow-remote, -h/--help are all parsed', () => {
    expect(parseBridgeArgs(['-t', 'empty']).tag).toBe('empty');
    expect(parseBridgeArgs(['--tag', 'url:https://x']).tag).toBe(
      'url:https://x',
    );
    expect(parseBridgeArgs(['-w', '9999']).wsPort).toBe(9999);
    expect(parseBridgeArgs(['--port', '1234']).wsPort).toBe(1234);
    expect(parseBridgeArgs(['--host', '0.0.0.0']).host).toBe('0.0.0.0');
    expect(parseBridgeArgs(['--allow-remote']).allowRemote).toBe(true);
    expect(parseBridgeArgs(['-h']).help).toBe(true);
    expect(parseBridgeArgs(['--help']).help).toBe(true);
  });

  test('--allow-remote defaults host to 0.0.0.0 when --host is not given', () => {
    expect(parseBridgeArgs(['--allow-remote']).host).toBe('0.0.0.0');
  });

  test('--tag-json is shorthand for tag: "json:<path>"', () => {
    expect(parseBridgeArgs(['--tag-json', '/tmp/x.json']).tag).toBe(
      'json:/tmp/x.json',
    );
  });

  test('env vars (NFC_TAG, WS_PORT, HOST, NFC_TAG_JSON) are used when no matching arg is given', () => {
    const args = parseBridgeArgs([], {
      NFC_TAG: 'empty',
      WS_PORT: '4321',
      HOST: '192.168.1.1',
    });
    expect(args).toMatchObject({
      tag: 'empty',
      wsPort: 4321,
      host: '192.168.1.1',
    });

    const jsonArgs = parseBridgeArgs([], {NFC_TAG_JSON: '/tmp/y.json'});
    expect(jsonArgs.tag).toBe('json:/tmp/y.json');
  });

  test('explicit CLI args take precedence over env vars', () => {
    const args = parseBridgeArgs(['-t', 'url:https://cli'], {
      NFC_TAG: 'empty',
    });
    expect(args.tag).toBe('url:https://cli');
  });
});

/** Minimal in-memory WsLike double that records every sent frame. */
class FakeWs implements WsLike {
  sent: unknown[] = [];
  private handlers: {
    message: Array<(data: unknown) => void>;
    close: Array<() => void>;
    error: Array<(err: Error) => void>;
  } = {message: [], close: [], error: []};
  closeArgs: unknown[] | null = null;

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }

  on(event: 'message' | 'close' | 'error', listener: any): void {
    this.handlers[event].push(listener);
  }

  emitMessage(data: unknown): void {
    for (const cb of this.handlers.message) cb(data);
  }

  emitClose(): void {
    for (const cb of this.handlers.close) cb();
  }

  emitError(err: Error): void {
    for (const cb of this.handlers.error) cb(err);
  }

  close(code?: number, reason?: string): void {
    this.closeArgs = [code, reason];
  }
}

describe('attachBridge', () => {
  test('sends the initial tagState frame on attach', () => {
    const tag = new TextTag({text: 'hi'});
    const ws = new FakeWs();
    attachBridge(tag, ws);
    expect(ws.sent[0]).toMatchObject({
      type: 'tagState',
      serialNumber: tag.serialNumber,
      writable: true,
      isNdef: true,
    });
  });

  test('"tap" command re-triggers tagDiscovered and acks with a null-error response', async () => {
    const tag = new TextTag({text: 'hi'});
    const ws = new FakeWs();
    attachBridge(tag, ws);
    ws.emitMessage(JSON.stringify({type: 'command', id: 1, command: 'tap'}));
    // Discovery delivery goes through InMemoryNfcTransport's setTimeout-based
    // scheduling (even at 0ms delay), so it needs a real macrotask tick.
    await new Promise(resolve => setTimeout(resolve, 0));

    const discovered = ws.sent.find((f: any) => f.type === 'tagDiscovered');
    expect(discovered).toMatchObject({serialNumber: tag.serialNumber});
    const response = ws.sent.find((f: any) => f.type === 'response');
    expect(response).toEqual({type: 'response', id: 1, error: null});
  });

  test('"remove" command sends tagRemoved and acks', () => {
    const tag = new EmptyTag();
    const ws = new FakeWs();
    attachBridge(tag, ws);
    ws.emitMessage(
      JSON.stringify({type: 'command', id: 2, command: 'remove'}),
    );
    expect(ws.sent).toContainEqual({type: 'tagRemoved'});
    expect(ws.sent).toContainEqual({type: 'response', id: 2, error: null});
  });

  test('"failNextWrite" command acks without sending any other frame', () => {
    const tag = new EmptyTag();
    const ws = new FakeWs();
    attachBridge(tag, ws);
    const before = ws.sent.length;
    ws.emitMessage(
      JSON.stringify({type: 'command', id: 3, command: 'failNextWrite'}),
    );
    expect(ws.sent.slice(before)).toEqual([
      {type: 'response', id: 3, error: null},
    ]);
  });

  test('"write" command writes the records, sends the new tagState, and acks', () => {
    const tag = new EmptyTag();
    const ws = new FakeWs();
    attachBridge(tag, ws);
    const records = [{tnf: 1, type: 'VA==', id: '', payload: 'AQID'}];
    ws.emitMessage(
      JSON.stringify({
        type: 'command',
        id: 4,
        command: 'write',
        args: {records},
      }),
    );
    expect(tag.records).toEqual(records);
    const stateFrame: any = [...ws.sent]
      .reverse()
      .find((f: any) => f.type === 'tagState');
    expect(stateFrame.records).toEqual(records);
    expect(ws.sent).toContainEqual({type: 'response', id: 4, error: null});
  });

  test('"write" with no args.records defaults to an empty record list', () => {
    const tag = new EmptyTag();
    const ws = new FakeWs();
    attachBridge(tag, ws);
    ws.emitMessage(
      JSON.stringify({type: 'command', id: 5, command: 'write'}),
    );
    expect(tag.records).toEqual([]);
    expect(ws.sent).toContainEqual({type: 'response', id: 5, error: null});
  });

  test('"write" against a read-only tag replies with the thrown error message', () => {
    const tag = new ReadOnlyTag();
    const ws = new FakeWs();
    attachBridge(tag, ws);
    ws.emitMessage(
      JSON.stringify({type: 'command', id: 6, command: 'write', args: {records: []}}),
    );
    const response: any = ws.sent.find((f: any) => f.type === 'response');
    expect(response.id).toBe(6);
    expect(response.error).toMatch(/read-only/);
  });

  test('"makeReadOnly" command flips writable, sends tagState, and acks', () => {
    const tag = new EmptyTag();
    const ws = new FakeWs();
    attachBridge(tag, ws);
    ws.emitMessage(
      JSON.stringify({type: 'command', id: 7, command: 'makeReadOnly'}),
    );
    expect(tag.writable).toBe(false);
    const stateFrame: any = [...ws.sent]
      .reverse()
      .find((f: any) => f.type === 'tagState');
    expect(stateFrame.writable).toBe(false);
    expect(ws.sent).toContainEqual({type: 'response', id: 7, error: null});
  });

  test('"makeReadOnly" against a tag whose onMakeReadOnly() throws replies with the error message', () => {
    class ThrowingMakeReadOnlyTag extends SimulatedTag {
      override onMakeReadOnly(): void {
        throw new Error('cannot make read-only');
      }
    }
    const tag = new ThrowingMakeReadOnlyTag();
    const ws = new FakeWs();
    attachBridge(tag, ws);
    ws.emitMessage(
      JSON.stringify({type: 'command', id: 9, command: 'makeReadOnly'}),
    );
    const response: any = ws.sent.find((f: any) => f.type === 'response');
    expect(response).toEqual({
      type: 'response',
      id: 9,
      error: 'cannot make read-only',
    });
  });

  test('an unknown command replies with an error and no state change', () => {
    const tag = new EmptyTag();
    const ws = new FakeWs();
    attachBridge(tag, ws);
    ws.emitMessage(
      JSON.stringify({type: 'command', id: 8, command: 'frobnicate'}),
    );
    const response: any = ws.sent.find((f: any) => f.type === 'response');
    expect(response).toMatchObject({id: 8});
    expect(response.error).toMatch(/unknown command: frobnicate/);
  });

  test('malformed / non-command frames are silently ignored', () => {
    const tag = new EmptyTag();
    const ws = new FakeWs();
    attachBridge(tag, ws);
    const before = ws.sent.length;
    ws.emitMessage('not json at all');
    ws.emitMessage(JSON.stringify({type: 'notACommand'}));
    ws.emitMessage(JSON.stringify({type: 'command', id: 'not-a-number', command: 'tap'}));
    expect(ws.sent.length).toBe(before);
  });

  test('a Buffer-like (non-string) message is coerced via String()', () => {
    const tag = new EmptyTag();
    const ws = new FakeWs();
    attachBridge(tag, ws);
    const before = ws.sent.length;
    // Something whose String() doesn't happen to produce valid JSON is
    // simply ignored, exercising the `String(data)` coercion branch.
    ws.emitMessage({toString: () => 'not json'});
    expect(ws.sent.length).toBe(before);
  });

  test('"error" event forwards to the provided log callback', () => {
    const tag = new EmptyTag();
    const ws = new FakeWs();
    const log = jest.fn();
    attachBridge(tag, ws, {log});
    ws.emitError(new Error('boom'));
    expect(log).toHaveBeenCalledWith('ws error: boom');
  });

  test('"error" event is a no-op when no log callback is provided', () => {
    const tag = new EmptyTag();
    const ws = new FakeWs();
    attachBridge(tag, ws);
    expect(() => ws.emitError(new Error('boom'))).not.toThrow();
  });

  test('a non-Error thrown from a "error" event is stringified via String()', () => {
    const tag = new EmptyTag();
    const ws = new FakeWs();
    const log = jest.fn();
    attachBridge(tag, ws, {log});
    ws.emitError('just a string' as unknown as Error);
    expect(log).toHaveBeenCalledWith('ws error: just a string');
  });

  test('teardown (returned function, also wired to ws "close") removes the discovery subscription', () => {
    const tag = new EmptyTag();
    const ws = new FakeWs();
    const teardown = attachBridge(tag, ws);
    teardown();
    // After teardown, tapping the underlying handle no longer reaches this
    // ws — verified indirectly: calling teardown twice (once explicitly,
    // once via emitClose) must not throw.
    expect(() => ws.emitClose()).not.toThrow();
  });
});

/** Minimal in-memory WebSocketServerLike double. */
class FakeWebSocketServer implements WebSocketServerLike {
  private handlers: {
    connection: Array<(ws: WsLike) => void>;
    listening: Array<() => void>;
    error: Array<(err: Error) => void>;
  } = {connection: [], listening: [], error: []};
  closed = false;

  on(event: 'connection' | 'listening' | 'error', listener: any): void {
    this.handlers[event].push(listener);
  }

  emitConnection(ws: WsLike): void {
    for (const cb of this.handlers.connection) cb(ws);
  }

  emitError(err: Error): void {
    for (const cb of this.handlers.error) cb(err);
  }

  close(): void {
    this.closed = true;
  }
}

describe('exposeSimulatedTag', () => {
  function FakeCtor(server: FakeWebSocketServer) {
    return jest.fn(() => server) as unknown as new (opts: {
      host?: string;
      port: number;
    }) => WebSocketServerLike;
  }

  test('the first connection is attached and receives the initial tagState frame', () => {
    const server = new FakeWebSocketServer();
    const tag = new EmptyTag();
    exposeSimulatedTag(tag, {WebSocketServer: FakeCtor(server)});
    const ws = new FakeWs();
    server.emitConnection(ws);
    expect(ws.sent[0]).toMatchObject({type: 'tagState'});
  });

  test('a second concurrent connection is closed immediately (one tag in the field)', () => {
    const server = new FakeWebSocketServer();
    const tag = new EmptyTag();
    exposeSimulatedTag(tag, {WebSocketServer: FakeCtor(server)});
    const first = new FakeWs();
    server.emitConnection(first);
    const second = new FakeWs();
    server.emitConnection(second);
    expect(second.closeArgs).toEqual([1013, 'tag already in use']);
    // The second connection was never attached, so it got no tagState frame.
    expect(second.sent).toHaveLength(0);
  });

  test('after the active connection closes, a new connection is accepted', () => {
    const server = new FakeWebSocketServer();
    const tag = new EmptyTag();
    exposeSimulatedTag(tag, {WebSocketServer: FakeCtor(server)});
    const first = new FakeWs();
    server.emitConnection(first);
    first.emitClose();

    const second = new FakeWs();
    server.emitConnection(second);
    expect(second.sent[0]).toMatchObject({type: 'tagState'});
  });

  test('a stale close from a superseded connection does not clear the new active connection', () => {
    const server = new FakeWebSocketServer();
    const tag = new EmptyTag();
    exposeSimulatedTag(tag, {WebSocketServer: FakeCtor(server)});
    const first = new FakeWs();
    server.emitConnection(first);
    first.emitClose(); // frees `active`, per the normal path.

    const second = new FakeWs();
    server.emitConnection(second); // becomes the new `active`.

    // `first`'s close handler fires again (a duplicate/out-of-order event,
    // as real ws libraries can produce) — since `active` is now `second`,
    // this must not null out the still-active `second` connection.
    first.emitClose();

    const third = new FakeWs();
    server.emitConnection(third);
    // Rejected: `second` is still active, proving the stale close from
    // `first` didn't clear it.
    expect(third.closeArgs).toEqual([1013, 'tag already in use']);
  });

  test('server "error" event forwards to the log callback', () => {
    const server = new FakeWebSocketServer();
    const tag = new EmptyTag();
    const log = jest.fn();
    exposeSimulatedTag(tag, {WebSocketServer: FakeCtor(server), log});
    server.emitError(new Error('listen failed'));
    expect(log).toHaveBeenCalledWith(
      'WebSocket server error: listen failed',
    );
  });

  test('close() tears down the active connection (if any) and closes the server', () => {
    const server = new FakeWebSocketServer();
    const tag = new EmptyTag();
    const {close} = exposeSimulatedTag(tag, {WebSocketServer: FakeCtor(server)});
    const ws = new FakeWs();
    server.emitConnection(ws);
    close();
    expect(server.closed).toBe(true);
  });

  test('close() with no active connection still closes the server', () => {
    const server = new FakeWebSocketServer();
    const tag = new EmptyTag();
    const {close} = exposeSimulatedTag(tag, {WebSocketServer: FakeCtor(server)});
    expect(() => close()).not.toThrow();
    expect(server.closed).toBe(true);
  });

  test('uses default port/host when not specified (constructor receives the defaults)', () => {
    const server = new FakeWebSocketServer();
    const ctor = FakeCtor(server);
    const tag = new EmptyTag();
    exposeSimulatedTag(tag, {WebSocketServer: ctor});
    expect(ctor).toHaveBeenCalledWith({host: '127.0.0.1', port: 8787});
  });
});

describe('installInMemoryNfcTransport', () => {
  test('returns null and installs nothing when enabled is false/omitted', () => {
    expect(installInMemoryNfcTransport()).toBeNull();
    expect(installInMemoryNfcTransport({enabled: false})).toBeNull();
  });

  test('installs a transport with the given tags when enabled', () => {
    const tag = new EmptyTag();
    const transport = installInMemoryNfcTransport({
      enabled: true,
      tags: [tag],
    });
    expect(transport).not.toBeNull();
  });

  test('installs a transport with no tags when enabled and tags is omitted', () => {
    const transport = installInMemoryNfcTransport({enabled: true});
    expect(transport).not.toBeNull();
  });
});
