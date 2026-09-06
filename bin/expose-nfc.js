#!/usr/bin/env node
/**
 * expose-nfc — serve a simulated NFC tag over a WebSocket so a real device,
 * emulator, or browser can be driven against it during manual QA, with no
 * physical NFC hardware needed (§6f).
 *
 * Thin Node wrapper: argument parsing and the per-connection protocol live
 * in the package's built `websocket/bridge` module (unit-tested with fakes);
 * here we just build the requested SimulatedTag, supply the real `ws`
 * WebSocketServer, and wire process signals.
 */

let bridge;
try {
  bridge = require('../lib/commonjs/websocket/bridge.js');
} catch (_e) {
  console.error(
    'Could not load the built bridge module. Build the package first ' +
      '(npm run prepare) and try again.',
  );
  process.exit(1);
}
const {exposeSimulatedTag, parseBridgeArgs, USAGE} = bridge;

let testing;
try {
  testing = require('../lib/commonjs/testing/index.js');
} catch (_e) {
  console.error(
    'Could not load the built testing module. Build the package first ' +
      '(npm run prepare) and try again.',
  );
  process.exit(1);
}
const {EmptyTag, MultiRecordTag, ReadOnlyTag, TextTag, UrlTag} = testing;

function requireOrExit(name) {
  try {
    return require(name);
  } catch (_e) {
    console.error(
      `Missing optional dependency "${name}". Install it on this host:\n` +
        `  npm install ${name}\n`,
    );
    process.exit(1);
  }
}

/** Builds a SimulatedTag from a `--tag`/`NFC_TAG` spec string (see USAGE). */
function createTagFromSpec(spec) {
  const sep = spec.indexOf(':');
  const kind = sep === -1 ? spec : spec.slice(0, sep);
  const value = sep === -1 ? '' : spec.slice(sep + 1);

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
          {
            tnf: 1,
            type: Buffer.from('T').toString('base64'),
            id: '',
            payload: Buffer.from(
              `en${value || 'read-only tag'}`,
              'binary',
            ).toString('base64'),
          },
        ],
      });
    case 'json': {
      const fs = require('node:fs');
      const path = require('node:path');
      const records = JSON.parse(
        fs.readFileSync(path.resolve(process.cwd(), value), 'utf8'),
      );
      return new MultiRecordTag({records});
    }
    default:
      throw new Error(
        `Unknown --tag kind "${kind}". Supported: text, url, empty, readonly, json.`,
      );
  }
}

function main() {
  const args = parseBridgeArgs(process.argv.slice(2), process.env);

  if (args.help) {
    console.log(USAGE);
    return;
  }

  let tag;
  try {
    tag = createTagFromSpec(args.tag);
  } catch (e) {
    console.error(`Error: ${e.message}\n`);
    console.error(USAGE);
    process.exit(1);
  }

  const {WebSocketServer} = requireOrExit('ws');

  const {close} = exposeSimulatedTag(tag, {
    port: args.wsPort,
    host: args.host,
    WebSocketServer,
    log: message => console.error(message),
  });

  console.log(
    `Simulated tag ("${args.tag}") exposed on ws://${args.host}:${args.wsPort}`,
  );
  console.log('Waiting for a client connection... (Ctrl+C to stop)');
  if (args.host === '0.0.0.0' || args.allowRemote) {
    console.warn(
      '⚠  Bound to a non-localhost address — your simulated tag is ' +
        'reachable from the network. Only do this on trusted networks.',
    );
  }

  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    console.log('\nshutting down…');
    try {
      close();
    } catch (_e) {
      // ignore
    }
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();
