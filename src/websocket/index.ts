/**
 * Public websocket subpath export (§1, §6f):
 * react-native-web-nfc-api/websocket. Test/tooling-only code (and its `ws`
 * optionalDependency) — never imported from the main entry point, so it (and
 * its consumers) never ships as part of the production app bundle path.
 */
export {
  attachBridge,
  type BridgeArgs,
  createTagFromSpec,
  type ExposeSimulatedTagOptions,
  exposeSimulatedTag,
  type InstallInMemoryNfcTransportOptions,
  installInMemoryNfcTransport,
  parseBridgeArgs,
  USAGE,
  type WebSocketServerCtor,
  type WebSocketServerLike,
  type WsLike,
} from './bridge';
