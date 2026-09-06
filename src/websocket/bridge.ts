/**
 * WebSocket bridge (§6f): exposes a SimulatedTag over a small JSON-over-ws
 * protocol so a real device/emulator/browser can be driven against a
 * simulated tag during manual QA, without physical NFC hardware.
 *
 * Deliberately free of any `ws` import at module top level — `ws` is an
 * optionalDependency (package.json), lazily loaded only inside
 * `exposeSimulatedTag()` so merely `require()`-ing this file (e.g. via the
 * `./websocket` export, always resolvable per §6's package.json `exports`
 * map) never fails when `ws` isn't installed.
 *
 * Protocol (JSON text frames both ways over one ws connection per tag):
 *   Server -> client, on connect and after every state change:
 *     {"type":"tagState","serialNumber":string,"records":NdefWireRecord[],
 *      "writable":boolean,"isNdef":boolean}
 *   Server -> client, whenever the tag is (re)discovered (tapped):
 *     {"type":"tagDiscovered","serialNumber":string,"records":NdefWireRecord[]}
 *   Server -> client, when the tag is removed from the field:
 *     {"type":"tagRemoved"}
 *   Server -> client, acknowledging a client command:
 *     {"type":"response","id":number,"error":string|null}
 *   Client -> server commands (JSON, {"type":"command","id":number,"command":...}):
 *     "tap"                          - re-trigger tagDiscovered
 *     "remove"                       - simulate the tag leaving the field
 *     "failNextWrite"                - next write against this tag rejects NetworkError
 *     "write"  {records}             - directly call tag.onWrite(records, true)
 *     "makeReadOnly"                 - directly call tag.onMakeReadOnly()
 *
 * This mirrors the sibling react-native-web-serial-api repo's
 * attachBridge()/parseBridgeArgs()/USAGE separation of concerns
 * (src/websocket/bridge.ts, bin/expose-serial.js), adapted from a
 * byte-stream serial port to a single stateful SimulatedTag.
 */
import {type NdefWireRecord, stringToBytes} from '../lib/ndef-wire';
import {encodeWebRecord} from '../lib/well-known-records';
import {setNfcTransport} from '../NfcModule';
import {InMemoryNfcTransport} from '../testing/in-memory-transport';
import {
  EmptyTag,
  MultiRecordTag,
  ReadOnlyTag,
  type SimulatedTag,
  TextTag,
  UrlTag,
} from '../testing/simulated-tag';

/** The subset of a `ws` WebSocket that the bridge uses. */
export interface WsLike {
  send(data: string): void;
  on(event: 'message', listener: (data: unknown) => void): void;
  on(event: 'close', listener: () => void): void;
  on(event: 'error', listener: (err: Error) => void): void;
}

/** The subset of the `ws` module's WebSocketServer that exposeSimulatedTag needs. */
export interface WebSocketServerLike {
  on(event: 'connection', listener: (ws: WsLike) => void): void;
  on(event: 'listening', listener: () => void): void;
  on(event: 'error', listener: (err: Error) => void): void;
  close(): void;
}

export type WebSocketServerCtor = new (opts: {
  host?: string;
  port: number;
}) => WebSocketServerLike;

const errMessage = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);

interface CommandMessage {
  type: 'command';
  id: number;
  command: string;
  args?: {records?: NdefWireRecord[]};
}

function parseCommandMessage(text: string): CommandMessage | null {
  try {
    const parsed = JSON.parse(text);
    if (
      parsed &&
      typeof parsed === 'object' &&
      parsed.type === 'command' &&
      typeof parsed.id === 'number' &&
      typeof parsed.command === 'string'
    ) {
      return parsed as CommandMessage;
    }
  } catch {
    // ignore malformed frames
  }
  return null;
}

function tagStateFrame(tag: SimulatedTag): unknown {
  return {
    type: 'tagState',
    serialNumber: tag.serialNumber,
    records: tag.records,
    writable: tag.writable,
    isNdef: tag.isNdef,
  };
}

/**
 * Wires a single WebSocket connection to a single SimulatedTag: the tag's
 * current state is sent on connect, tap/remove/write/makeReadOnly commands
 * from the client are applied to the tag via a dedicated InMemoryNfcTransport
 * created for this tag, and every resulting tagDiscovered/operationEnded is
 * forwarded to the client as a frame. Returns a teardown function.
 */
export function attachBridge(
  tag: SimulatedTag,
  ws: WsLike,
  options: {log?: (message: string) => void} = {},
): () => void {
  const transport = new InMemoryNfcTransport({requireExplicitTap: true});
  const handle = transport.addTag(tag);

  const send = (payload: unknown): void => ws.send(JSON.stringify(payload));

  const discoverySub = transport.addEventListener('tagDiscovered', ev => {
    send({
      type: 'tagDiscovered',
      serialNumber: ev.serialNumber,
      records: ev.records,
    });
  });

  // Keep a live scan running so tap() always has somewhere to deliver to.
  void transport.beginScan('bridge-scan');

  const reply = (id: number, error: unknown): void =>
    send({type: 'response', id, error: error ? errMessage(error) : null});

  const handleCommand = (msg: CommandMessage): void => {
    switch (msg.command) {
      case 'tap':
        handle.tap();
        reply(msg.id, null);
        break;
      case 'remove':
        handle.remove();
        send({type: 'tagRemoved'});
        reply(msg.id, null);
        break;
      case 'failNextWrite':
        handle.failNextWrite();
        reply(msg.id, null);
        break;
      case 'write':
        try {
          tag.onWrite(msg.args?.records ?? [], true);
          send(tagStateFrame(tag));
          reply(msg.id, null);
        } catch (err) {
          reply(msg.id, err);
        }
        break;
      case 'makeReadOnly':
        try {
          tag.onMakeReadOnly();
          send(tagStateFrame(tag));
          reply(msg.id, null);
        } catch (err) {
          reply(msg.id, err);
        }
        break;
      default:
        reply(msg.id, new Error(`unknown command: ${msg.command}`));
    }
  };

  ws.on('message', data => {
    const text = typeof data === 'string' ? data : String(data);
    const msg = parseCommandMessage(text);
    if (msg) handleCommand(msg);
  });

  const teardown = (): void => {
    discoverySub.remove();
    void transport.cancelOperation('bridge-scan');
  };
  ws.on('close', teardown);
  ws.on('error', err => options.log?.(`ws error: ${errMessage(err)}`));

  // Initial state, sent once the connection handlers are wired.
  send(tagStateFrame(tag));

  return teardown;
}

export interface ExposeSimulatedTagOptions {
  /** TCP port to listen on (default 8787). */
  port?: number;
  /** Listen address (default '127.0.0.1'). */
  host?: string;
  /**
   * The `ws` module's `WebSocketServer` constructor. Passed in explicitly
   * (rather than imported at module top level) so this function works
   * without hard-depending on `ws` at import time — callers that already
   * have `ws` loaded (e.g. bin/expose-nfc.js) pass its export directly.
   */
  WebSocketServer: WebSocketServerCtor;
  log?: (message: string) => void;
}

/**
 * Serves `tag` over a small ws protocol (§6f) so a real device/emulator/
 * browser can exercise it without physical NFC hardware. `ws` itself is
 * lazy-loaded by the caller (bin/expose-nfc.js) and passed in as
 * `options.WebSocketServer` — this function never does `require('ws')`
 * itself, so importing this module never fails when `ws` isn't installed.
 *
 * Only one client is served at a time (mirrors real NFC's "one tag in the
 * field" constraint) — a second connection while one is active is closed
 * immediately.
 */
export function exposeSimulatedTag(
  tag: SimulatedTag,
  options: ExposeSimulatedTagOptions,
): {close: () => void} {
  const {WebSocketServer, port = 8787, host = '127.0.0.1', log} = options;
  const wss = new WebSocketServer({host, port});
  let active: WsLike | null = null;
  let detach: (() => void) | null = null;

  wss.on('connection', ws => {
    if (active) {
      // Best-effort: WsLike doesn't declare close(), so duck-type it.
      (
        ws as unknown as {close?: (code?: number, reason?: string) => void}
      ).close?.(1013, 'tag already in use');
      return;
    }
    active = ws;
    detach = attachBridge(tag, ws, {log});
    ws.on('close', () => {
      detach?.();
      detach = null;
      if (active === ws) active = null;
    });
  });

  wss.on('error', err => log?.(`WebSocket server error: ${errMessage(err)}`));

  return {
    close: () => {
      detach?.();
      wss.close();
    },
  };
}

// ── Tag spec parsing (pure, testable) ─────────────────────────────────────────

/**
 * Builds a SimulatedTag from the `--tag`/`NFC_TAG` spec string documented in
 * USAGE below: `text:<value>`, `url:<value>`, `empty`, `readonly:<value>`,
 * or `json:<path>` (a JSON file whose top-level array is an NdefWireRecord[]
 * for a MultiRecordTag). `readFile` is injected (rather than calling
 * `fs.readFileSync` directly) so this function stays pure/testable with
 * fakes — `bin/expose-nfc.js` passes the real `fs.readFileSync`.
 */
export function createTagFromSpec(
  spec: string,
  readFile: (path: string) => string = () => {
    throw new Error('json: tag spec requires a readFile implementation');
  },
): SimulatedTag {
  const colon = spec.indexOf(':');
  const kind = colon === -1 ? spec : spec.slice(0, colon);
  const value = colon === -1 ? '' : spec.slice(colon + 1);

  switch (kind) {
    case 'text':
      return new TextTag({text: value || 'hello from a virtual tag'});
    case 'url':
      return new UrlTag({url: value || 'https://example.com'});
    case 'empty':
      return new EmptyTag();
    case 'readonly':
      return new ReadOnlyTag({
        records: [
          // Use encodeWebRecord so the NFC Forum Text RTD status byte
          // (UTF-8/UTF-16 flag | lang length) is emitted before the lang
          // bytes — hand-rolling `btoa("en" + value)` here would skip the
          // status byte and well-known-records.ts's decodeTextPayload would
          // then read 'e' (0x65) as the status byte, treating 0x65 & 0x3f =
          // 37 as the lang length and throwing "malformed text record".
          encodeWebRecord({
            recordType: 'text',
            data: stringToBytes(value || 'read-only tag'),
          }),
        ],
      });
    case 'json': {
      const raw = readFile(value);
      const records = JSON.parse(raw) as NdefWireRecord[];
      return new MultiRecordTag({records});
    }
    default:
      throw new Error(
        `unrecognized --tag spec "${spec}" (expected text:, url:, empty, readonly:, or json:)`,
      );
  }
}

// ── CLI argument parsing (pure, testable) ────────────────────────────────────

export type BridgeArgs = {
  /** 'text:<value>' | 'url:<value>' | 'empty' | 'readonly' | 'json:<path>' */
  tag: string;
  wsPort: number;
  host: string;
  allowRemote: boolean;
  help: boolean;
};

/** Parse `expose-nfc` CLI args + env into a normalised options object. */
export function parseBridgeArgs(
  argv: readonly string[],
  env: Record<string, string | undefined> = {},
): BridgeArgs {
  const args: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const take = () => argv[++i];
    switch (a) {
      case '-t':
      case '--tag':
        args.tag = take();
        break;
      case '--tag-json':
        args.tagJson = take();
        break;
      case '-w':
      case '--port':
        args.wsPort = take();
        break;
      case '--host':
        args.host = take();
        break;
      case '--allow-remote':
        args.allowRemote = true;
        break;
      case '-h':
      case '--help':
        args.help = true;
        break;
    }
  }

  const allowRemote = args.allowRemote === true;
  const host =
    (args.host as string) ??
    env.HOST ??
    (allowRemote ? '0.0.0.0' : '127.0.0.1');

  const tagJson = (args.tagJson as string | undefined) ?? env.NFC_TAG_JSON;
  const tag =
    (args.tag as string) ??
    env.NFC_TAG ??
    (tagJson ? `json:${tagJson}` : 'text:hello from a virtual tag');

  return {
    tag,
    wsPort: Number(args.wsPort ?? env.WS_PORT ?? 8787),
    host,
    allowRemote,
    help: args.help === true,
  };
}

export const USAGE = `expose-nfc — expose a simulated NDEF tag over a WebSocket

Usage:
  expose-nfc [--tag <spec>] [--port 8787] [--host 127.0.0.1] [--allow-remote]

Tag spec (--tag / env NFC_TAG), one of:
  text:<value>          A TextTag with the given text        (default)
  url:<value>            A UrlTag with the given URL
  empty                  An EmptyTag (zero records)
  readonly:<value>       A ReadOnlyTag with a single text record
  json:<path>            A MultiRecordTag loaded from a JSON file of
                          NdefWireRecord[] (also settable via --tag-json
                          <path> or env NFC_TAG_JSON)

Options:
  -t, --tag <spec>       Tag to expose (see above)             [env NFC_TAG]
      --tag-json <path>  Shorthand for --tag json:<path>       [env NFC_TAG_JSON]
  -w, --port <n>          WebSocket port (default 8787)         [env WS_PORT]
      --host <addr>       Listen address (default 127.0.0.1)    [env HOST]
      --allow-remote      Bind 0.0.0.0 (exposes the tag to the network!)
  -h, --help              Show this help

Connect from the app/example with a small ws client speaking the JSON
protocol documented at the top of src/websocket/bridge.ts, or use the
example app's "Virtual Tag demo" screen pointed at ws://<host>:<port>.
`;

// ── Maestro/emulator e2e flag-gated global install (§6f) ─────────────────────

export interface InstallInMemoryNfcTransportOptions {
  /** If false (or omitted with no tags), this is a no-op — real transport stays active. */
  enabled?: boolean;
  tags?: SimulatedTag[];
  transportOptions?: ConstructorParameters<typeof InMemoryNfcTransport>[0];
}

/**
 * Flag-gated global install of an InMemoryNfcTransport, for Maestro/emulator
 * e2e runs against the example app (§6f) — the example app calls this once
 * at startup, gated on a build-time/env flag, so CI can run the demo-mode,
 * self-test, and lifecycle Maestro flows against a deterministic simulated
 * transport without any physical NFC hardware.
 *
 * Returns the installed transport (so the caller can also add tags later,
 * simulate launch, etc.), or null if `enabled` was false.
 */
export function installInMemoryNfcTransport(
  options: InstallInMemoryNfcTransportOptions = {},
): InMemoryNfcTransport | null {
  if (!options.enabled) return null;
  const transport = new InMemoryNfcTransport(options.transportOptions);
  for (const tag of options.tags ?? []) {
    transport.addTag(tag);
  }
  setNfcTransport(transport);
  return transport;
}
