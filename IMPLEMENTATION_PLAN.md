# react-native-web-nfc-api — Implementation Plan

A React Native Turbo Module implementing the [W3C Web NFC API](https://w3c.github.io/web-nfc/) (`NDEFReader`, `NDEFMessage`, `NDEFRecord`) for Android and iOS, and passing through to the browser's native `NDEFReader` Web NFC implementation on web (Chrome only) by default, with an opt-out (`mode: 'managed'`, §4) for simulation/testing on web. (Web NFC has no `navigator.nfc` — unlike Web Serial's `navigator.serial`, the spec deliberately exposes only a global `NDEFReader` constructor, per `docs/web-nfc/EXPLAINER.md:245-249`; §4 already implements passthrough correctly via `window.NDEFReader`, this note is just correcting stale prose elsewhere in this document that referred to a `navigator.nfc` that doesn't exist.) Architecture is modeled on [`react-native-web-serial-api`](../react-native-web-serial-api) — transport abstraction, testing-first structure. Native NFC operations (Android `NfcAdapter`/`Ndef`, iOS Core NFC) reference [`react-native-nfc-manager`](../react-native-nfc-manager) for API calls only, not for architecture. Spec *behavior* (as opposed to just type shapes) is verified against the actual W3C Web Platform Tests checked into [`docs/webidl-nfc-api`](../webidl-nfc-api) — see §5e.

## 0. Goals & scope boundary

Every item below is required for v1 — nothing in this plan is optional or deferred; where earlier drafts used "optional tooling," that label is removed and the WebSocket bridge (§6f) is a required deliverable like everything else.

The scope boundary is the Web NFC spec's own surface: `NDEFReader`/`NDEFMessage`/`NDEFRecord`, i.e. NDEF-formatted tags only. Devices/tag technologies the spec itself doesn't address are out of scope entirely, not deferred to a later version:

- **Out of scope for this plan**: raw tag technology access below the NDEF layer (Mifare Classic/Ultralight, IsoDep, Felica, ISO15693 as distinct tag types) — the Web NFC spec has no concept of these; the scope boundary for this implementation is the spec's own NDEF surface, so supporting them is not part of this work. (Whether a future, separate effort adds native-only tag-tech APIs is a product decision outside this document's scope, not something this plan rules out or in.)
- **In scope**: how an NDEF tag reaches the app is still within the spec's surface even when the *trigger* is platform-specific — background/App-clip NFC tap launch on iOS, the Android equivalent (an `ACTION_NDEF_DISCOVERED` launch intent), and keeping a live `scan()` subscription alive across the app losing/regaining the foreground, are native lifecycle integration points for delivering NDEF data the app already knows how to consume via `NDEFReader`, not a new tag technology (§12).

Goals:
- `import {NDEFReader} from 'react-native-web-nfc-api'` behaves like the spec on Android/iOS (real NFC hardware) and, by default, passes through to the browser's native `NDEFReader` under react-native-web/Chrome — with an explicit per-instance opt-out (`mode: 'managed'`, §4) to run the managed/simulatable implementation on web too.
- Fully testable without hardware — an `NfcTransport` abstraction with an in-memory virtual tag implementation, injectable into `NDEFReader`, usable in Jest and in on-device demos.
- New Architecture only (Turbo Modules + codegen). No old bridge fallback.
- Background/App-clip NFC tap launch handling on iOS, the equivalent Android launch-intent delivery, and background/foreground scan suspension so a live `scan()` survives the app losing and regaining the foreground — all delivering into the same `NDEFReader`/`SessionCoordinator` surface (§12).
- A WebSocket bridge for exposing a simulated tag to a real device/emulator/browser during manual QA, with a CLI entry point (§6f).

## 1. Package layout

```
react-native-web-nfc-api/
  src/
    index.ts                 # single entry point on every platform: NDEFReader, NDEFMessage, NDEFRecord, NDEFReadingEvent, types
    NativeNfc.ts              # TurboModule Spec + TurboModuleRegistry.get
    NativeNfc.web.ts          # stub -> null, so TurboModuleRegistry is never touched on web
    WebNfcReader.ts           # NDEFReader/NDEFMessage/NDEFRecord classes; on web, branches per-instance into Passthrough vs Managed strategy (§4)
    SessionCoordinator.ts     # multiplexes NDEFReader instances onto the one physical native operation (Managed strategy only)
    NfcModule.ts              # NfcTransport-backed wrapper: getNfcTransport/setNfcTransport/resetNfcTransport
    transport.ts              # NfcTransport interface + event types (react-native-free, like serial's transport.ts)
    lib/
      event-target.ts         # EventTarget/Event shim (or reuse a tiny dependency)
      dom-exception.ts        # DOMException shim with spec error names
      abort-signal.ts         # AbortSignal/AbortController shim if RN runtime lacks one
      web-record.ts           # Web NFC NDEFRecordInit validation/coercion (string|BufferSource|NDEFMessageInit -> wire)
      ndef-wire.ts             # lossless TNF/type/id/payload <-> neutral wire representation (the native boundary type)
      well-known-records.ts   # text/url/smart-poster/mime helpers built on top of ndef-wire.ts
    testing/
      index.ts                # public testing subpath export
      in-memory-transport.ts  # InMemoryNfcTransport
      simulated-tag.ts        # SimulatedTag base class + canned tags (TextTag, UrlTag, ReadOnlyTag, EmptyTag, MultiRecordTag)
      fixtures.ts             # createTagFixture(), installGlobally option
      harness.ts              # assert/assertEqual/assertRejects/withTimeout (zero-dep) + WPT-ported helpers (assertWebNDEFMessagesEqual, createMessage/createRecord/*, §5f)
      client.ts               # NfcClient test helper (drive scan/write/readMessage with timeouts)
    websocket/
      bridge.ts                # attachBridge/parseBridgeArgs, exposeSimulatedTag() over ws (required, see §6f)
  android/
    build.gradle
    src/main/java/dev/webnfcapi/
      NfcModule.kt             # TurboModule impl wrapping NfcAdapter/Ndef
      NfcPackage.kt
  ios/
    WebNfcApi.xcodeproj/
    WebNfcApi/
      NfcModule.h/.mm          # TurboModule impl wrapping Core NFC (session type per §7b)
  bin/
    expose-nfc.js              # CLI wrapping websocket/bridge.ts, analogous to expose-serial.js
  example/
    ...                        # RN app (Android/iOS/web) with a virtual-tag demo screen + Maestro e2e
  TESTING.md
  README.md
  package.json
  tsconfig.json / tsconfig.build.json
  react-native.config.js
  babel.config.js
  jest.config.js
```

There is no package-level `nfc` singleton file, and no separate web entry point — `index.ts` exports only the `NDEFReader`/`NDEFMessage`/`NDEFRecord`/`NDEFReadingEvent` names on every platform. On web, `NDEFReader` itself decides per-instance whether to pass through to the browser's real NFC or run the managed/simulatable polyfill (§4).

## 2. Public API surface (from `docs/web-nfc/web-nfc.d.ts`)

Implement these shapes exactly, in `src/WebNfcReader.ts`:

```ts
class NDEFMessage {
  constructor(init: NDEFMessageInit);
  records: ReadonlyArray<NDEFRecord>;
}

class NDEFRecord {
  constructor(init: NDEFRecordInit);
  readonly recordType: string;
  readonly mediaType?: string;
  readonly id?: string;
  readonly data?: DataView;      // read side
  readonly encoding?: string;
  readonly lang?: string;
  toRecords?: () => NDEFRecord[]; // for recordType === 'smart-poster'
}

class NDEFReadingEvent extends Event {
  constructor(type: string, init: NDEFReadingEventInit);
  serialNumber: string;
  message: NDEFMessage;
}

class NDEFReader extends EventTarget {
  constructor();
  onreading: (ev: NDEFReadingEvent) => any;
  onreadingerror: (ev: Event) => any;
  scan(options?: NDEFScanOptions): Promise<void>;
  write(message: NDEFMessageSource, options?: NDEFWriteOptions): Promise<void>;
  makeReadOnly(options?: NDEFMakeReadOnlyOptions): Promise<void>;
}
```

Behavioral notes:
- `write()` accepts `string | BufferSource | NDEFMessageInit` as its `NDEFMessageSource` message argument — coerce via `lib/web-record.ts` + `lib/well-known-records.ts` (§5b). A string is always encoded as a `"text"` record; strings are never auto-detected as URLs — callers set `recordType: 'url'` explicitly (spec-defined). `scan()` takes no message argument at all — only `NDEFScanOptions` (`{signal}`, §2's class shapes above) — so none of this coercion applies to it; an earlier draft of this plan incorrectly grouped `scan()` into this coercion rule.
- All async methods take an `AbortSignal`. `WebNfcReader.ts` wires `signal.addEventListener('abort', ...)` to cancellation (§5c) — every operation is cancellable (spec-defined).
- No dedicated error types in the `.d.ts` — reject with `DOMException` using spec names: `NotSupportedError`, `NotReadableError`, `NotAllowedError`, `NetworkError`, `AbortError`, `SyntaxError`, `InvalidStateError` (plus a plain `TypeError` for a malformed `signal` argument, not a `DOMException`) — see §8 for the full mapping, cross-checked against the actual WPT conformance suite in `docs/webidl-nfc-api/` (§5e), not just inferred from this trimmed `.d.ts`.
- Permission model: the spec relies on the browser's Permissions API (`navigator.permissions.query({name:'nfc'})`); RN has no equivalent (**RN platform adaptation**, not spec behavior). First `scan()`/`write()` call triggers the platform's native permission/settings flow: Android `android.permission.NFC` is normal-protection (no runtime prompt; just an adapter-enabled check), iOS's `NFCReaderUsageDescription` Info.plist entry drives the OS system prompt automatically on session start. Document this divergence in the README; do not implement a `navigator.permissions` shim that reports state RN can't actually observe.
- `constructor()` in the `.d.ts` is zero-arg, matching the spec. This library's `NDEFReader` accepts an additional library-specific optional options parameter (`new NDEFReader(options?: NDEFReaderOptions)`, see §4) for controlling passthrough vs. managed mode on web. Adding it doesn't change the zero-arg call shape spec code relies on — `new NDEFReader()` behaves identically to before.

## 3. Turbo Module spec (`src/NativeNfc.ts`)

Native exposes an **operation-oriented** API: every call that starts work takes an `operationId` chosen by JS, every native event carries that id, and a single `cancelOperation(id)` cancels any operation regardless of kind. This lets JS represent overlapping logical scan and write requests without ambiguity about which native event belongs to which caller; `SessionCoordinator` (§5a) is what actually serializes them onto the single physical NFC reader — native itself never runs two operations simultaneously.

```ts
export interface Spec extends TurboModule {
  isSupported(): Promise<boolean>;     // hardware + OS capability present
  isEnabled(): Promise<boolean>;       // NFC radio currently on (Android only meaningfully; iOS always true if supported)

  beginScan(operationId: string, options: {alertMessage?: string}): Promise<void>;
  beginWrite(operationId: string, records: NdefWireRecord[], options: {overwrite: boolean; alertMessage?: string}): Promise<void>;
  beginMakeReadOnly(operationId: string, options: {alertMessage?: string}): Promise<void>;
  cancelOperation(operationId: string): Promise<void>; // idempotent; no-op if already finished

  // Lifecycle delivery (§12) — drains one pending OS-level NFC activation (cold launch, warm resume,
  // or App Clip invocation), or null if none is pending. Each activation is delivered exactly once:
  // consuming it removes it from native's queue. See §12c for why this is "once per activation," not
  // "once per process" — a single process can receive multiple NFC activations over its lifetime
  // (e.g. background, then a second tag tap resumes the same process).
  consumePendingLaunchTag(): Promise<{activationId: string; serialNumber?: string; records: NdefWireRecord[]} | null>;

  addListener(eventName: string): void;
  removeListeners(count: number): void;
}
export default TurboModuleRegistry.get<Spec>('NativeNfc');
```

**Promise resolution semantics** (must hold for every `NfcTransport` implementation, not just native):
- `beginScan()` resolves once the native reader session is successfully active — it does **not** wait for a tag. Tag discoveries arrive only via `tagDiscovered` events, for as long as the scan operation remains active. The scan stays active until `cancelOperation(operationId)` is called; it has no implicit single-shot completion.
- `beginWrite()` / `beginMakeReadOnly()` resolve only once the operation has fully completed (a tag was found and the write/lock succeeded) — they are one-shot operations, not "started" acknowledgements. `operationEnded{reason:'success'}` is emitted at the same point the promise resolves; `operationEnded{reason:'error'|'cancelled'|'timeout'}` corresponds to the promise rejecting. This avoids a caller having to reconcile a resolved promise against a later contradicting `operationEnded` event.
- `consumePendingLaunchTag()` resolves immediately with whatever is at the front of native's activation queue (or `null` if empty); it is not a subscription and does not wait for an activation to occur. Calling it removes that entry from the queue — a second immediate call returns the *next* queued activation, or `null` once the queue is empty. Native enqueues one entry per distinct OS-level NFC activation (cold launch, warm resume via `onNewIntent`/re-activation, or App Clip invocation) — see §12c for how `SessionCoordinator` drains this queue so app code never tracks "did I already consume this."

Events emitted via `NativeEventEmitter(NativeNfc)`, every payload tagged with the `operationId` it belongs to (except the two lifecycle events below, which are process-wide), mirrored 1:1 onto `NfcTransport`:
- `tagDiscovered`: `{operationId: string, serialNumber: string, records: NdefWireRecord[]}` — scan operations only.
- `operationEnded`: `{operationId: string, reason: 'cancelled' | 'timeout' | 'error' | 'success', message?: string}` — terminal for every operation kind (a cancelled/timed-out/errored scan also gets this, even though scans don't resolve their own promise on it). A `reason: 'cancelled'` caused by app backgrounding (§12d) is indistinguishable at this layer from any other cancellation — `SessionCoordinator`, not native, is responsible for telling backgrounding-cancellation apart from user-abort-cancellation, the same way it already does for write-suspension-cancellation (§5a).
- `stateChanged` (Android only, mirrors nfc-manager's `NfcAdapter.ACTION_ADAPTER_STATE_CHANGED`): `{enabled: boolean}`
- `appStateChanged`: `{state: 'foreground' | 'background'}` — emitted whenever native observes an app-lifecycle transition (§12d); this is what `SessionCoordinator` uses to derive whether scanning should currently be physically active, rather than JS tracking foreground/background state through some other channel.
- `launchTagReceived`: `{activationId: string}` — emitted whenever native enqueues a new activation *while JS is already running* (the warm-resume case). This is a notification only — it does not carry the payload itself, to keep exactly one code path (`consumePendingLaunchTag()`) responsible for actually draining and returning activation data; a cold-launch activation has no corresponding event (JS wasn't running yet to receive it) and is instead picked up by `SessionCoordinator`'s own startup drain (§12c).

Native tracks only "which `operationId`(s) currently occupy the physical reader" — it has no notion of `NDEFReader` instances; that multiplexing is entirely a JS-side concern (§5a).

`NdefWireRecord` is the lossless native wire type (§5b). Native code never constructs or interprets `recordType`/`mediaType`/`encoding`/`lang` — it only moves raw NDEF Forum bytes.

**Note**: this `Spec`, including `consumePendingLaunchTag()`, is a draft until validated by the feasibility spikes in §7c — the spikes must exercise both the live-session path and the launch/lifecycle path (§12, §7c) before anything is frozen. See build order (§13).

**Codegen config** (`package.json`), same shape as the serial repo:
```json
"codegenConfig": {
  "name": "WebNfcApiSpec",
  "type": "modules",
  "jsSrcsDir": "src",
  "android": {"javaPackageName": "dev.webnfcapi"}
}
```

## 4. Platform resolution

On native platforms (Android/iOS) there is only one implementation — `WebNfcReader.ts`'s polyfill, backed by `SessionCoordinator` → `NfcTransport` → `NativeNfc`. There is no real OS-level "Web NFC" to pass through to, so `mode` (below) has no effect there.

On web, `NDEFReader` is a single class exported from `src/index.ts` (no separate `index.web.ts` — there is exactly one public entry point on every platform) that decides at **construction time**, not at import/bundle time, whether to delegate to the browser's native `NDEFReader` global (there is no `navigator.nfc` in the Web NFC spec — see the intro note) or to run the managed polyfill:

```ts
interface NDEFReaderOptions {
  mode?: 'passthrough' | 'managed'; // web only; ignored on native. Default: 'passthrough'.
}

class NDEFReader extends EventTarget {
  constructor(options?: NDEFReaderOptions);
  // ...same scan/write/makeReadOnly/onreading/onreadingerror surface as §2
}
```

- **`new NDEFReader()`** (or `new NDEFReader({mode: 'passthrough'})`, the default) — on web, every method call forwards directly to a real `window.NDEFReader` instance constructed internally; events forwarded 1:1. This is the "true browser passthrough" case: no `NdefWireRecord` translation, no `SessionCoordinator`, no `NfcTransport` in the path at all — behaviorally indistinguishable from calling `new window.NDEFReader()` yourself. If `window.NDEFReader` doesn't exist (non-Chrome browser), methods reject with `NotSupportedError` at call time, not at construction or import time. This is a deliberate, documented divergence from raw spec-compliant "unsupported browser" behavior: real Chrome/other browsers simply don't define a global `NDEFReader` at all, so app code written against the bare spec gets a `ReferenceError` on `new NDEFReader()` itself in an unsupported browser. This library always exports a working `NDEFReader` class (so RN/web bundling has something concrete to import), so unsupported-browser detection necessarily happens per-method-call instead of at the point of construction — apps that feature-detect via `if (window.NDEFReader)` before constructing should use `NDEFReader.isSupported?.()` (a small non-spec static helper) or a caught rejection instead, and this divergence should be called out explicitly in the README.
- **`new NDEFReader({mode: 'managed'})`** — on web, this constructs the same managed polyfill used on native: `SessionCoordinator` + `getNfcTransport()` (§5), which resolves to `InMemoryNfcTransport` if one was installed via `setNfcTransport()` (§6), or otherwise a `NotSupportedError`-throwing stub (there is no "native NFC transport" to fall back to on web — passthrough is the only way to reach a real browser radio, by design). This is what makes simulation/testing possible on web: an app's demo mode calls `setNfcTransport(new InMemoryNfcTransport())` once, then constructs every reader with `mode: 'managed'` to route through it, without needing a separate import path or a differently-shaped reader class.
- On native, `options?.mode` is accepted (so the same call site works unchanged across platforms) but has no effect — there is nothing to pass through to, and the managed polyfill is used regardless of the option's value.

Internally, `WebNfcReader.ts` implements this as a single class whose methods dispatch to one of two private strategies chosen once in the constructor — a `PassthroughStrategy` (web + `mode !== 'managed'`, thin forwarding to `window.NDEFReader`) or a `ManagedStrategy` (native, or web with `mode: 'managed'`, going through `SessionCoordinator`/`NfcTransport`). `src/NativeNfc.ts`/`NativeNfc.web.ts` (§3) and `src/NfcModule.ts` (§5) are unaffected by this — `NativeNfc.web.ts` still stubs to `null` since the managed strategy on web never touches a native module, only `NfcTransport` (satisfied by `InMemoryNfcTransport` or nothing).

**Why a constructor option rather than a module-level environment switch**: a per-instance option means the same app can hold both a real reader (for actual NFC UI) and a simulated one (for a demo/self-test screen) side by side on web, exactly as `SessionCoordinator` already allows multiple concurrent `NDEFReader` instances (§5a) — a global "simulation mode" flag would have forced a single process-wide choice instead. It also keeps `mode` visible at every call site that cares about it, rather than being an invisible ambient setting a reader's behavior silently depends on.

This mirrors the serial repo's underlying flexibility (an app can construct `new Serial(transport)` directly for a demo, alongside the ambient `navigator.serial`-backed `serial` singleton for real use) while giving NFC a tighter, single-class API surface rather than two differently-typed entry points.

## 5. Transport abstraction (`src/transport.ts`)

Zero react-native imports, zero DOM-only types — runs unchanged under Node/Jest, in Chrome, and on-device. Cancellation is expressed via `operationId`, not `AbortSignal` (§5c).

```ts
export interface NfcTransport {
  isSupported(): Promise<boolean>;
  isEnabled(): Promise<boolean>;
  beginScan(operationId: string, opts: {alertMessage?: string}): Promise<void>;
  beginWrite(operationId: string, records: NdefWireRecord[], opts: {overwrite: boolean; alertMessage?: string}): Promise<void>;
  beginMakeReadOnly(operationId: string, opts: {alertMessage?: string}): Promise<void>;
  cancelOperation(operationId: string): Promise<void>;
  consumePendingLaunchTag(): Promise<{activationId: string; serialNumber?: string; records: NdefWireRecord[]} | null>;
  addEventListener(
    type: 'tagDiscovered' | 'operationEnded' | 'stateChanged' | 'appStateChanged' | 'launchTagReceived',
    cb: (ev: any) => void,
  ): Subscription;
}
export type Subscription = {remove: () => void};
```

`appStateChanged` (`{state: 'foreground' | 'background'}`) and `launchTagReceived` (`{activationId: string}`) are the lifecycle events described in §12 — putting them directly on `NfcTransport` (rather than as some native-only side channel) is what keeps `InMemoryNfcTransport` and the real native transport genuinely interchangeable for `SessionCoordinator`: the coordinator only ever reacts to these events and calls `consumePendingLaunchTag()`, with no code path that knows or cares whether the transport underneath is real or simulated.

Injection seam, copy of `UsbSerial.ts`'s pattern:
```ts
export function getNfcTransport(): NfcTransport { /* override ?? lazily-built platform transport */ }
export function setNfcTransport(t: NfcTransport | null): void { override = t; }
export function resetNfcTransport(): void { override = null; instance = null; }
```

### 5a. Multiple `NDEFReader` instances — `SessionCoordinator.ts`

The Web NFC spec's surface is per-`NDEFReader`-instance, but both Android and iOS expose exactly one physical reader to the process at a time. A single process-wide `SessionCoordinator` sits between all `NDEFReader` instances and `NfcTransport`, and owns:

```ts
interface SessionCoordinatorState {
  scanSubscribers: Set<ReaderId>;                          // readers with an active scan() call
  scanOperationId: string | null;                          // the native operationId of the current scan, if any
  activeOperation: {kind: 'write' | 'makeReadOnly'; operationId: string; abort: () => void} | null; // `abort` is SessionCoordinator's OWN internal AbortController.abort, independent of any caller-supplied signal — see the replacement rule below
  appForeground: boolean;                                  // whether the app currently holds the foreground (§12d)
  internallyCancelledScans: Set<string>;                   // scanOperationIds cancelled by the coordinator itself, awaiting their operationEnded
}
```

Rather than track "why is scanning suspended" as persistent state — which cannot represent overlapping causes (a write in flight *and* the app backgrounded at once) — whether scanning should physically be running is a **derived** value, recomputed on every state change:

```ts
const shouldScan = scanSubscribers.size > 0 && activeOperation === null && appForeground;
```

This is a policy layer on top of §3's `Spec`. The exclusivity/replacement rules below are **not** an RN policy choice — they are spec-mandated and verified against the actual W3C Web Platform Tests in `docs/webidl-nfc-api/web-nfc/` (§5e); see §5d for the remaining parts of this section that genuinely are RN implementation policy (multi-reader scan broadcast, backgrounding).

- **`scan()` on a reader that already has an active `scan()`**: rejects immediately with `InvalidStateError` (WPT: `NDEFReader_scan.https.html:307-314`, *"NDEFReader.scan rejects if there is already an ongoing scan"* — this is a **per-reader** check the `NDEFReader` class itself must enforce before ever reaching `SessionCoordinator`, not something the coordinator arbitrates). A *different* reader calling `scan()` while another is already scanning is unaffected by this check and proceeds normally (broadcast model, §5d).
- **`scan()` (first call on this reader)**: adds the calling reader to `scanSubscribers`, then reconciles (below). Removing the reader from `scanSubscribers` (via abort) reconciles again.
- **`write()` / `makeReadOnly()` while one is already active (any reader, including the same one)**: does **not** reject. Per WPT (`NDEFReader_write.https.html:389-412`, *"NDEFReader.write should replace all previously configured write operations"*; same pattern for `makeReadOnly`, `NDEFReader_make-read-only.https.window.js:139`), the *new* call **replaces** the previous one — the coordinator calls the stored `activeOperation.abort()`, which rejects the previous operation's promise with `AbortError`, then proceeds to start the new operation under a fresh `operationId`. There is no `InvalidStateError` path for this case at all — an earlier draft of this plan had that backwards. **`activeOperation.abort` is `SessionCoordinator`'s own internally-created `AbortController`, one per operation, entirely separate from whatever `AbortSignal` (if any) the caller passed to `write()`/`makeReadOnly()`.** This distinction matters concretely: replacement must reject the previous operation with `AbortError` *even when the caller supplied no `signal` at all* — the WPT test at `:389-412` constructs neither `write()` call with a `signal` option, and the first one still rejects `AbortError` once the second replaces it. Every `beginWrite`/`beginMakeReadOnly` call therefore always creates its own internal `AbortController` regardless of whether the public API call included a `signal`; a caller-supplied `signal` is wired to *additionally* trigger that same internal controller (so user-abort and coordinator-replacement end up going through one mechanism), never the other way around.
- `write()` / `makeReadOnly()` (after any replacement above): sets `activeOperation` under a new `operationId` and reconciles (which will stop any running scan, since `shouldScan` becomes `false`), then calls `beginWrite`/`beginMakeReadOnly`. On completion, clears `activeOperation` and reconciles again (which restarts the scan if `shouldScan` is now `true`).
- `appForeground` is set directly from the transport's `appStateChanged` event (§3, §12d) and reconciles on every change.
- **Reconciliation** (one function, called after every state change above; must be serialized/idempotent — see the race note below):
  ```ts
  function reconcile() {
    if (shouldScan() && scanOperationId === null) {
      const id = newOperationId();
      scanOperationId = id;              // set BEFORE awaiting — see race note
      transport.beginScan(id, options).catch(error => {
        if (scanOperationId === id) scanOperationId = null;
        // surface `error` to scanSubscribers as appropriate (§8)
      });
    } else if (!shouldScan() && scanOperationId !== null) {
      const id = scanOperationId;
      internallyCancelledScans.add(id);
      scanOperationId = null;            // cleared BEFORE awaiting cancelOperation
      transport.cancelOperation(id);     // fire-and-forget; operationEnded confirms later
    }
  }
  ```
  `beginScan()`/`cancelOperation()` are `Promise<void>` — they don't return an operation id; `scanOperationId` is JS-generated and assigned synchronously before the native call is even issued. **This ordering matters**: if `scanOperationId` were only set after `beginScan()` resolves, two reconciliation passes triggered in quick succession (e.g. a `scan()` call and an `appStateChanged` event arriving back-to-back) could both see `scanOperationId === null` and both call `beginScan()`, starting two physical scans. Setting the id synchronously, before the `await`/promise chain, makes the second pass see a non-null `scanOperationId` and skip. Reconciliation itself must run as a single synchronous pass per invocation (no `await` before the `scanOperationId` assignment) precisely because lifecycle events, aborts, and operation completions can all arrive in rapid succession from independent sources (a `NDEFReader.scan()` call, a native `appStateChanged` event, a `write()` completing) and nothing else serializes them.
- `tagDiscovered` events (tagged with `scanOperationId`) are broadcast to every reader in `scanSubscribers`, **after a staleness check** (below).

**Stale-event invariant.** Because reconciliation can move on to a new operation before a native confirmation for the old one arrives, every incoming transport event must be checked against current state before acting on it: an event for an `operationId` that is neither the current `scanOperationId`, the current `activeOperation?.operationId`, nor present in `internallyCancelledScans` is **stale** and must be dropped without side effects. This is a general rule, not just the write-suspension case below — e.g. it also protects against the callback-race sequence "scan A cancelled → scan B starts → a late `tagDiscovered(A)` arrives after B is already active," which would otherwise get broadcast to B's subscribers as if it were a B discovery. `SessionCoordinator.test.ts` (§6b) gets a dedicated case for exactly this sequence.

**Internal suspension cancellation must not look like user cancellation, regardless of cause — including when the cause is a reader's own abort.** Every path that stops the native scan goes through the same reconciliation branch (§5a's pseudocode above), whether `shouldScan` became `false` because a write started, the app backgrounded, or the last reader in `scanSubscribers` called `scan({signal})` and that signal fired. In every one of these cases, reconciliation adds `scanOperationId` to `internallyCancelledScans` *before* calling `cancelOperation` — there is no separate "this cancellation doesn't need tracking" path. The distinction that matters is only about *what already happened on the JS side* versus *what native confirms afterward*: a reader's own `AbortSignal` firing already resolves that reader's `scan()` promise with `AbortError` synchronously in `WebNfcReader.ts` (§5c) — the reader doesn't wait for native's `operationEnded` to know it aborted. When `operationEnded{operationId, reason:'cancelled'}` for that same `scanOperationId` arrives afterward (possibly much later, given real hardware/OS latency), it is purely a native-side acknowledgement of a cancellation the coordinator already initiated — the coordinator matches it against `internallyCancelledScans`, removes the id, and swallows the event exactly as it would for a write-suspension or backgrounding cancellation. No reader is waiting to be notified by it, and no second error path is ever produced by it. This one mechanism handles every combination automatically, with no transitions between suspension "reasons" to track:
  - `scan()` → write starts → app backgrounds → write finishes (still backgrounded: `shouldScan` stays `false`, scan does **not** restart) → app foregrounds (`shouldScan` becomes `true`, scan restarts with a fresh `operationId`).
  - `scan()` → app backgrounds → a write starts while backgrounded → app foregrounds (write still active, so `shouldScan` stays `false`, scan does **not** restart) → write finishes (`shouldScan` becomes `true`, scan restarts).

**Debugging invariant.** `scanOperationId !== null` should eventually equal `shouldScan() === true`, except transiently while a `beginScan`/`cancelOperation` call is in flight — any state where this holds *and stays wrong* after all pending native calls settle indicates a reconciliation bug. Worth asserting in `SessionCoordinator.test.ts` after every test scenario's async operations have settled, and worth remembering when debugging lifecycle races on real hardware during the feasibility spikes (§7c) — this one-line invariant is the fastest way to tell "still converging" from "actually stuck."

`SessionCoordinator` is a pure-JS unit with dedicated tests (`SessionCoordinator.test.ts`, §6b) independent of both the `WebNfcReader` classes and any specific `NfcTransport` implementation.

### 5b. Lossless native wire format — `lib/ndef-wire.ts`

Native only ever produces/consumes a neutral, lossless NDEF wire representation — the shape an `NdefRecord` (Android) or `NFCNDEFPayload` (iOS) already has. Native code never interprets NDEF bytes into Web NFC semantics (deciding `"text"` vs `"mime"` vs `"unknown"`, decoding a text record's status byte, etc.) — that logic lives once, in JS.

```ts
// lib/ndef-wire.ts
export interface NdefWireRecord {
  tnf: number;        // NFC Forum Type Name Format (0-7): 0x01 well-known, 0x02 MIME, 0x04 external, ...
  type: string;        // base64-encoded type bytes
  id: string;           // base64-encoded id bytes (may be empty)
  payload: string;      // base64-encoded payload bytes
}
```

Interpretation is strictly layered:

```
native NDEF record (Android NdefRecord / iOS NFCNDEFPayload)
        │  native: TNF + type + id + payload only, no semantics
        ▼
NdefWireRecord  (lib/ndef-wire.ts — the native boundary type, also used by NfcTransport)
        │  JS: interpret TNF/type into RTD, decode text status byte, URI-prefix expansion, etc.
        ▼
well-known-records.ts  (text/url/smart-poster/mime decoders, ported from nfc-manager's ndef-lib/)
        │
        ▼
NDEFRecord  (Web NFC public shape: recordType/mediaType/id/data: DataView/encoding/lang)
```

and symmetrically in reverse for `write()`: `web-record.ts` validates/coerces the caller's `string | BufferSource | NDEFMessageInit` into `NDEFRecordInit`, `well-known-records.ts` encodes that into `NdefWireRecord`(s), which crosses the native boundary via `beginWrite()`. The three files are independently testable (§6a): `ndef-wire.ts` has no concept of `recordType` strings at all.

### 5c. Cancellation

`AbortSignal`/`AbortController` are Web API types owned by `WebNfcReader.ts`, not by `NfcTransport` — the transport boundary must stay portable to Node/Jest and to native, where no such type exists. `NfcTransport` only knows `operationId` + `cancelOperation(id)`.

```
caller's AbortSignal
        │  reader.scan({signal}) / reader.write(msg, {signal})
        ▼
WebNfcReader.ts:  signal.addEventListener('abort', () => coordinator.cancel(operationId))
        │
        ▼
SessionCoordinator.cancel(operationId)
        │
        ▼
transport.cancelOperation(operationId)  →  DOMException('AbortError') surfaced back to the caller's pending promise
```

Every `NfcTransport` implementation (native, in-memory) implements one cancellation primitive.

### 5d. Spec behavior vs. implementation policy

Web NFC leaves most concurrency/cancellation/timeout behavior unspecified — it defines a single-reader browser model, not a multi-reader native-session model. The table below marks which rows of this plan's behavior (§6e) come from the spec text itself versus from a policy this plan is choosing for RN:

| Behavior | Source |
|---|---|
| `abort()` before an operation starts rejects with `AbortError` | Web NFC spec, verified against WPT (`NDEFReader_scan.https.html:110-115`, `NDEFReader_write.https.html:181-189`) |
| `abort()` mid-operation rejects with `AbortError` | Web NFC spec, verified against WPT (`NDEFReader_scan.https.html:117-124`) |
| Coercion of `string`/`BufferSource`/`NDEFMessageInit` on write | Web NFC spec, verified against WPT (`NDEFReader_write.https.html:350-367`) |
| `scan()` on a reader that already has an active scan rejects with `InvalidStateError` | **Web NFC spec**, verified against WPT (`NDEFReader_scan.https.html:307-314`) — corrected from an earlier draft of this plan, which incorrectly had this as an RN-policy "idempotent no-op" |
| A second `write()`/`makeReadOnly()` call **replaces** (aborts) a previously in-flight one, rather than rejecting | **Web NFC spec**, verified against WPT (`NDEFReader_write.https.html:389-412`, `NDEFReader_make-read-only.https.window.js:139`) — corrected from an earlier draft of this plan, which incorrectly had this rejecting with `InvalidStateError` |
| `write()` with `overwrite:false` on a tag that already has records rejects with `NotAllowedError` (not `InvalidStateError`) | **Web NFC spec**, verified against WPT (`NDEFReader_write.https.html:466-472`) — corrected from an earlier draft's `InvalidStateError` |
| Two *different* `NDEFReader`s scanning both receive `reading` events (broadcast) | RN implementation policy (§5a) — the spec's mock-NFC test harness runs single-implementation-per-page tests and doesn't define multi-reader-on-one-native-radio semantics; this is genuinely an RN-specific multiplexing choice, not contradicted by WPT |
| A `write()` suspends an active scan and resumes it afterward | RN implementation policy (§5a) — WPT's mock NFC has no concept of a single shared physical radio, so this coexistence rule is RN-specific |
| `makeReadOnly()` on an already-read-only tag resolves as a no-op | RN implementation policy (§6b) — not covered by the WPT files present in `docs/webidl-nfc-api/` |
| iOS system session timeout / restart-polling behavior | Platform adaptation (Core NFC constraint, not spec or RN choice) |

Anything not explicitly marked "Web NFC spec" in the behavioral matrix (§6e) should be read as RN implementation policy, and is open to revision if it proves not to match real-world app expectations. The two rows marked "corrected from an earlier draft" reflect turning up the actual WPT suite (`docs/webidl-nfc-api/`) after the state-machine design was first written — always check §5e/the WPT files directly before asserting a new spec-conformance claim in this document, rather than inferring behavior from the `.d.ts` types alone.

### 5e. Source of truth: the WPT test suite (`docs/webidl-nfc-api/web-nfc/`)

`docs/webidl-nfc-api/` is a checkout of the actual W3C Web Platform Tests for Web NFC — not just the spec's IDL, but the executable conformance suite browsers are graded against. This is authoritative where the `.d.ts`/`EXPLAINER.md` files are silent (they define shapes, not behavior), and should be treated as the primary source for any question of the form "what does the spec actually require here":

- `web-nfc/NDEFReader_scan.https.html` — scan lifecycle, `InvalidStateError` on same-reader re-scan (line 307-314), `AbortError` semantics, `readingerror` on non-NDEF tags, embedded/smart-poster record decoding via `toRecords()`, and the exact error names for hardware-absent/disabled/permission-denied cases (`NotSupportedError`/`NotReadableError`/`NotAllowedError` — see §8).
- `web-nfc/NDEFReader_write.https.html` — write coercion (string/ArrayBuffer/ArrayBufferView/`NDEFMessageInit`), the "replace, don't reject" concurrency rule (line 389-412), `overwrite` semantics and its exact error name (`NotAllowedError`, line 466-472), and `NetworkError` on transfer failure (line 474-478).
- `web-nfc/NDEFReader_make-read-only.https.window.js` — mirrors `write()`'s replace-not-reject concurrency rule and error names.
- `web-nfc/NDEFRecord_constructor.https.window.js`, `NDEFMessage_constructor.https.window.js`, `NDEFMessage_recursion-limit.https.window.js`, `NDEFReadingEvent_constructor.https.window.js` — exact construction/validation rules for the record/message classes, useful for `lib/web-record.ts`'s codec tests (§6a) as additional vectors beyond hand-encoded NDEF Forum bytes.
- `web-nfc/idlharness.https.window.js` — the formal IDL conformance check; useful as a reference for exactly which members/attributes must exist on each class, beyond what's summarized in `web-nfc.d.ts`.
- `web-nfc/resources/nfc-helpers.js` — the mock-NFC test harness (`nfc_test`, `mockNFC`, `createMessage`/`createRecord`/`createTextRecord`/etc., `assertWebNDEFMessagesEqual`) that these tests are built on. This is a close structural analogue to this plan's own `InMemoryNfcTransport`/`SimulatedTag`/conformance-suite design (§6) — worth consulting directly when implementing §6's testing package, since it shows exactly what a spec-compliant browser implementation is expected to do in each scenario.
- The `*-manual.https.html`/`nfc-prompt-manual.https.html` files are manual (human-in-the-loop) tests for document-visibility and permission-prompt behavior — not automatable, but useful as a checklist for README-documented platform-permission divergences (§2's permission-model note).

### 5f. Adapting WPT tests to Jest

The WPT files can't run as-is — they're `testharness.js`-based browser tests (`.https.html`/`.https.window.js`), assume a real DOM/`window`, and drive a Chromium-specific Mojo mock (`mockNFC`) rather than this project's `NfcTransport`. Porting them into `src/__tests__/conformance-suite.ts` (§6c) means translating each WPT primitive to its Jest/`InMemoryNfcTransport` equivalent, not copy-pasting the files:

| WPT primitive (`resources/nfc-helpers.js` unless noted) | Jest/this-project equivalent |
|---|---|
| `nfc_test(func, name, properties)` | A plain Jest `test(name, async () => {...})`, with `func`'s body adapted below. `properties` (WPT's timeout/flags metadata) has no equivalent — drop it, or fold a timeout into Jest's own `test(name, fn, timeout)` third argument if a specific case needs one. |
| `initialize_nfc_tests()` / `new WebNFCTest()` / `NFCTest.getMockNFC()` | `createTagFixture(tag \| tag[], opts)` (§6b) — construct the `InMemoryNfcTransport` + managed-mode `NDEFReader` for the test directly, instead of initializing a global mock. |
| `t.add_cleanup(() => NFCTest.reset())` | Either rely on `createTagFixture` producing a fresh, disposable `InMemoryNfcTransport` per test (no shared global state to reset), or an explicit `afterEach(() => transport.dispose())` if a fixture-teardown hook proves necessary. |
| `mockNFC.setReadingMessage(message)` | `tagHandle.tap()` after `transport.addTag(new SomeSimulatedTag(message))`, or a purpose-built `SimulatedTag` subclass if the WPT test's `message` shape doesn't map cleanly onto an existing canned tag (§6b) — add one rather than contorting an existing tag class. |
| `mockNFC.setHWStatus(NFCHWStatus.DISABLED \| NOT_SUPPORTED \| ENABLED)` | `InMemoryNfcTransport` constructor option or a `transport.setHardwareStatus(...)` method (add this method — §6b's option list doesn't currently include it, and this WPT case is exactly why it's needed) driving `isSupported()`/`isEnabled()` and the `NotSupportedError`/`NotReadableError` paths (§8). |
| `mockNFC.simulateClosedPipe()` | Same `setHardwareStatus`-style seam, modeling "no platform NFC implementation at all" → `NotSupportedError`. |
| `mockNFC.simulateNonNDEFTagDiscovered()` | `tagHandle.tap()` on a tag that reports a non-NDEF technology — a new canned `NonNdefTag` `SimulatedTag` subclass (§6b) whose discovery should surface as `readingerror`, not `reading`. |
| `mockNFC.simulateDataTransferFails()` | `TagHandle.failNextWrite()` (already in §6b's `TagHandle` API) mapped to reject with `NetworkError`, matching WPT's exact case. |
| `mockNFC.setIsFormattedTag(true)` | Use a `SimulatedTag` already populated with records (i.e. non-empty `records: NdefWireRecord[]` at construction) to exercise the `overwrite:false` → `NotAllowedError` case (§8). |
| `mockNFC.pushedMessage()` / `mockNFC.writeOptions()` | `tagHandle`/`SimulatedTag` exposing what was actually written (e.g. `simulatedTag.lastWrite: {records, overwrite}`) for the test to assert against — add this to `SimulatedTag`'s base class (§6b) since several ported tests need it. |
| `test_driver.set_permission({name:'nfc'}, 'denied')` | No direct equivalent — RN has no Permissions API (§2's permission-model note). Model as `InMemoryNfcTransport`/native transport rejecting with `NotAllowedError` directly (a `transport.simulatePermissionDenied()`-style seam, or simply constructing the fixture with a tag/transport preconfigured to reject that way), since "permission denied" and "OS declined the NFC prompt" collapse to the same observable behavior in this design. |
| `new EventWatcher(t, ndef, ["reading", "readingerror"])` / `.wait_for("reading")` | `NfcClient.waitForReading({timeout})` (§6b) — already designed for exactly this purpose. |
| `promise_rejects_dom(t, 'ErrorName', promise)` | Jest: `await expect(promise).rejects.toMatchObject({name: 'ErrorName'})` (or a small `assertRejectsWithName(promise, name)` helper in `testing/harness.ts`, §1 — add one if this pattern repeats often enough across ported tests, which it will). |
| `promise_rejects_js(t, TypeError, promise)` | `await expect(promise).rejects.toBeInstanceOf(TypeError)`. |
| `assert_true(x instanceof NDEFReadingEvent)` / other `assert_*` | Plain Jest `expect()` assertions — `assert_equals` → `.toBe()`, `assert_array_equals` → `.toEqual()`, etc. |
| `assertWebNDEFMessagesEqual(message, expectedMessage)` | Port this helper directly into `testing/harness.ts` (§1) — its record-by-record field comparison (`recordType`/`mediaType`/`id`/`encoding`/`lang`/byte-equal `data`) is exactly the assertion this project's own conformance suite needs, and there's no reason to reinvent it. |
| `createMessage`/`createRecord`/`createTextRecord`/`createMimeRecord`/`createUrlRecord`/`createUnknownRecord` | Port these directly into `testing/harness.ts` or `lib/__tests__/` fixtures (§6a) too — they're small, dependency-free factory functions for building `NDEFMessageInit`/`NDEFRecordInit` test data, equally useful for the codec vectors (§6a) as for the conformance suite. |
| The iframe-context tests (`NDEFReader_scan_iframe.https.html`, and the inline iframe cases in `NDEFReader_scan.https.html`/`_write.https.html`) | **Not ported** — RN has no iframe/document concept, so "reject with `InvalidStateError` when called from an iframe" has no meaningful RN analogue. Note this exclusion explicitly in `TESTING.md` (§11) so it's a documented decision, not an oversight. |
| The `*-manual.https.html` files | **Not ported** — these are human-in-the-loop only even in the original WPT suite; treat as a manual QA checklist (already noted in §5e), not conformance-suite input. |

This table is the concrete answer to "how do the WPT scenarios actually become Jest tests" — when porting a specific WPT test not covered by a row above, extend this table rather than improvising a one-off translation, so the mapping stays a single source of truth as more scenarios get ported.

## 6. Testing package (`src/testing/`)

`package.json` `exports` map: `"."`, `"./testing"`, `"./websocket"`, `"./package.json"` — test-only code (and its `ws` dependency) never ships in the production bundle. Testing is layered: codec correctness is verified independently of any transport/simulator.

### 6a. Codec-level tests (`lib/__tests__/`)

Test `ndef-wire.ts`/`well-known-records.ts`/`web-record.ts` in isolation — no `NfcTransport`, no `NDEFReader`, no simulator.

- **Codec vectors**: given known raw NDEF Forum bytes (TNF + type + id + payload, hand-encoded per the NFC Forum RTD specs, not generated by our own encoder), assert the exact `NDEFRecord` fields produced, and the reverse for `write()`'s encode path. Cover well-known RTDs (text with various language/encoding status bytes, URI with prefix-abbreviation table, smart poster with nested records), MIME records, external/unknown TNF values, empty records, and malformed input (truncated payload, invalid TNF, missing type where required). Additionally port the record-shape assertions from the WPT suite's `NDEFRecord_constructor.https.window.js`, `NDEFMessage_constructor.https.window.js`, and `NDEFMessage_recursion-limit.https.window.js` (§5e) directly as extra vectors — these are the actual browser-conformance construction/validation rules, not this plan's own interpretation of them.
- **Round trips**: `Web record → wire → Web record` and `wire → Web record → wire`, asserting equality wherever the spec guarantees losslessness, and a documented transformation wherever it doesn't (e.g. URI prefix compression is invisible to the Web NFC `data`/`recordType` shape).
- **Platform fixtures**: real `NdefRecord` byte dumps from an Android device and real `NFCNDEFPayload` byte dumps from an iOS device, captured from the same physical tag, checked into `lib/__tests__/fixtures/` as raw hex. Assert both produce identical `NDEFRecord` output through the shared JS codec — this is the test class most likely to catch real interoperability bugs.

### 6b. Transport-level tests

- **`InMemoryNfcTransport implements NfcTransport`**: holds zero-or-one "tag in field" at a time (NFC's real-world constraint). Options: `{tapDelayMs, autoEnabled, requireExplicitTap}`. `addTag(tag: SimulatedTag): TagHandle` places a tag in range; `TagHandle.remove()` simulates removal; `TagHandle.tap()` explicitly triggers `tagDiscovered` when `requireExplicitTap` is set. All discovery/write payloads crossing this boundary are `NdefWireRecord[]` (§5b), so the simulator exercises the same codec path a real device would. `setHardwareStatus('enabled' | 'disabled' | 'not-supported')` drives `isSupported()`/`isEnabled()` and the corresponding `NotSupportedError`/`NotReadableError` rejection paths (§8) — this exists specifically to port the WPT `NFCHWStatus`-driven test cases (§5f).
- **`SimulatedTag`** base class: `serialNumber`, `records: NdefWireRecord[]`, `writable: boolean`, `lastWrite: {records: NdefWireRecord[]; overwrite: boolean} | null` (records what was actually written, for assertions — the equivalent of WPT's `mockNFC.pushedMessage()`/`.writeOptions()`, §5f), hooks `onWrite(records)`, `onMakeReadOnly()`. Canned subclasses: `TextTag`, `UrlTag`, `ReadOnlyTag`, `EmptyTag`, `MultiRecordTag`, `SlowTag` (delays, to test cancellation), `FlakyTag` (fails Nth write), `NonNdefTag` (discovery surfaces as `readingerror`, not `reading` — ports WPT's `simulateNonNDEFTagDiscovered()`, §5f). `ReadOnlyTag` behavior (rejects `write()`; `makeReadOnly()` resolves as a no-op) matches the behavioral matrix (§6e), not simulator-invented behavior.
- **`TagHandle`** fault injection: `tap()`, `remove()`, `failNextWrite()` (rejects the next write with `NetworkError`, porting WPT's `simulateDataTransferFails()`, §5f), `emitOperationError(reason)`, `whenScanned()`.
- **`createTagFixture(tag | tag[], opts)`** → `{transport, reader, tagHandle, whenScanned, whenWritten}`; `reader` is constructed with `new NDEFReader({mode: 'managed'})` internally so the fixture behaves identically on native and on web; `opts.installGlobally` calls `setNfcTransport()` so app code constructing its own `new NDEFReader({mode: 'managed'})` picks up the same transport.
- **`SessionCoordinator.test.ts`**: unit tests for §5a against a fake minimal `NfcTransport` — two readers both scanning both get `reading` events; stopping one doesn't stop the other; a same-reader `scan()` while already scanning rejects with `InvalidStateError`; a second `write()` while one is in flight **replaces** it (the first's promise rejects `AbortError`, the second proceeds — §5d/§5e), never `InvalidStateError`; a `write()` drives `shouldScan` to `false` and back to `true`, restarting an active scan with a fresh `operationId`. **Dedicated case**: `reader.scan()` → native scan A active → `reader.write()` → reconciliation adds `A` to `internallyCancelledScans` and calls `cancelOperation(A)` → fake transport emits `operationEnded{A, 'cancelled'}` → assert the scanning reader receives **no** `readingerror`/abort-visible event from this, and `A` is removed from `internallyCancelledScans` → write completes → reconciliation starts scan C (new id, distinct from A) → assert the same reader keeps receiving `tagDiscovered`/`reading` for tags surfacing under C, proving internal cancellation was swallowed rather than treated as a user-initiated scan stop. **Also cover `appForeground` toggling and its overlap with an active `write()`/`makeReadOnly()`** (both drive `shouldScan` independently — test that `shouldScan` only becomes true again once *both* conditions clear) — see §12d's dedicated test list for the full lifecycle-suspension cases, which extend this same file rather than living in a separate suite.
- **`NfcClient`** test helper wrapping a live `NDEFReader`: `scan({timeout})`, `waitForReading({timeout})`, `write(message, {timeout})`, `expectNoReading(ms)`, `close()`.

### 6c. Conformance suite

The conformance suite is split by what it can validate, since fault injection and exact timing control don't transfer to arbitrary physical tags:

- **`src/__tests__/conformance-suite.ts`** — transport-independent behavioral assertions from §6e that hold for any correct `NfcTransport`: scan lifecycle, write coercion, multi-reader/concurrent-write policy (§5a), abort semantics (§5c), error propagation as `DOMException`. Each test builds its own `createTagFixture` against `InMemoryNfcTransport` and runs under Jest. Directly port the scenario structure of the WPT suite's `NDEFReader_scan.https.html` and `NDEFReader_write.https.html` (§5e) into this suite — same test names/intent, mechanically translated per the primitive-by-primitive mapping in §5f — rather than re-deriving equivalent test cases from the behavioral matrix alone; the WPT files are the authoritative enumeration of the scenarios a spec-compliant implementation must handle.
- **Fault-injection tests** (in-memory only) — `SlowTag`/`FlakyTag` scenarios, deterministic delays, forced Nth-write failure, exact timeout control. These require the simulator's fault-injection hooks and cannot run against arbitrary real hardware.
- **Real-device compatibility tests** — an exported `runNfcConformance()` runs the transport-independent subset against real hardware from the example app's Self-Test screen. Hardware setup (which physical tags are presented, in what order) necessarily differs from the in-memory suite; this validates the native implementation against the same behavioral assertions, not against the same test script.

### 6d. Coverage target

No blanket 100% coverage target is set for this package, and none should be inferred from "testing is first-class." Coverage is a proxy, not the goal — the goal is that every row of the behavioral matrix (§6e below) and every codec vector (§6a) has a corresponding assertion. Concretely:

- `lib/` (codec: `ndef-wire.ts`, `well-known-records.ts`, `web-record.ts`) and `SessionCoordinator.ts` are pure logic with no native/platform branching — these are held to a high bar (effectively 100% line/branch coverage is achievable and expected) precisely because nothing else exercises their edge cases; an untested branch here is untested, full stop.
- `WebNfcReader.ts`'s `ManagedStrategy` is covered by the conformance suite (§6c) against `InMemoryNfcTransport` — expect near-complete coverage of the public API surface, since every method/error path is enumerable and small.
- `WebNfcReader.ts`'s `PassthroughStrategy` (§4) and native `NfcModule.kt`/`NfcModule.mm` are **not** held to a coverage percentage — they're thin forwarding/glue code validated by the real-device compatibility tests (§6c) and the feasibility spikes (§7c), where "does it work against real hardware/a real browser" is the meaningful bar, not line coverage of forwarding calls.
- CI should enforce coverage thresholds only on `lib/` and `SessionCoordinator.ts` (e.g. via Jest's `coverageThreshold` scoped to those paths); do not add a repo-wide coverage gate that would either be trivially satisfiable by testing glue code or block on native-adjacent code that can't be meaningfully unit-tested at all.

**No coverage-ignore directives, ever.** `/* istanbul ignore next */`, `/* c8 ignore */`, or equivalent Jest coverage-exclusion comments are not permitted anywhere in `lib/` or `SessionCoordinator.ts`. If a branch there is hard to reach in a test, that is a signal the branch is unreachable dead code (delete it) or that the test setup needs work (write the test) — not a reason to hide the gap from the coverage report. A real coverage gap must show up as a red number in CI, not be silently suppressed.

### 6e. Behavioral matrix

Concurrency, cancellation, and edge-case semantics are pinned down here before implementation; `SessionCoordinator`, `WebNfcReader`, and the conformance suite (§6c) are written against this table. See §5d for which rows are spec-mandated versus RN policy.

| Operation / state | Expected result |
|---|---|
| `scan()` while already scanning (same reader) | **Rejects with `InvalidStateError`** (WPT `NDEFReader_scan.https.html:307-314` — see §5d/§5e) |
| `scan()` on a second `NDEFReader` while first is scanning | Both resolve; both receive subsequent `reading` events (RN broadcast policy, §5d) |
| `write()` while a `write()`/`makeReadOnly()` is already in flight (any reader) | **Replaces** the in-flight one — the earlier operation's promise rejects with `AbortError`, the new one proceeds (WPT `NDEFReader_write.https.html:389-412` — see §5d/§5e); no `InvalidStateError` for this case |
| `write()` while only `scan()`(s) are active | Allowed; scan is suspended for the duration of the write, then resumes (RN policy, §5d — WPT's mock has no shared-radio concept) |
| Stopping one reader's scan while another reader is still scanning | Native scan stays alive; only the stopped reader stops receiving events |
| `abort()` before the native operation starts | Rejects with `AbortError`, native `beginX` is never called |
| `abort()` while the native operation is in flight | `cancelOperation` invoked; pending promise rejects with `AbortError` |
| Tag removed mid-read or mid-write | Rejects/emits with `NetworkError` |
| `write()` targeting a `ReadOnlyTag` | Rejects with `InvalidStateError` |
| `makeReadOnly()` on an already-read-only tag | Resolves (no-op success) |
| `write()` with `overwrite:false` on a tag that already has records | **Rejects with `NotAllowedError`** (WPT `NDEFReader_write.https.html:466-472` — not `InvalidStateError`) |
| Tag discovered with zero records (`EmptyTag`) | `reading` fires with `message.records = []` (WPT `NDEFReader_scan.https.html:268-282`) |
| Tag exposes a non-NDEF technology | `readingerror` fires, not `reading` (WPT `NDEFReader_scan.https.html:248-266`) |
| NFC radio disabled | `scan()`/`write()`/`makeReadOnly()` reject with `NotReadableError` (WPT — not `NotAllowedError`; see §8) |
| No NFC hardware / no platform implementation | `scan()`/`write()`/`makeReadOnly()` reject with `NotSupportedError` |
| User/OS denies NFC permission | `scan()`/`write()`/`makeReadOnly()` reject with `NotAllowedError` (WPT `NDEFReader_scan.https.html:38-42`) |
| Session times out with no tag presented | `operationEnded{reason:'timeout'}` maps to `NotAllowedError`; a bare scan has no inherent timeout (only write/makeReadOnly one-shot operations time out) — not directly covered by the WPT files present, flagged as an RN-platform-adaptation guess pending real-device validation (§7c) |

### 6f. WebSocket bridge

`InMemoryNfcTransport` covers in-process simulation for the conformance suite and unit tests (§6a-6c), but manual/device QA — exercising a real device, emulator, or browser against a simulated tag without physical NFC hardware — requires the bridge described here. This is a required deliverable of v1 (see build order, §13).

- `src/websocket/bridge.ts` + `bin/expose-nfc.js`: `exposeSimulatedTag(tag, {port, WebSocketServer})` serves a `SimulatedTag` over a small ws protocol. `ws` is lazy-loaded, not a hard dependency.
- `installInMemoryNfcTransport({enabled, tags})`: flag-gated global install for Maestro/emulator e2e runs against the example app.

## 7. Native implementation

The `Spec` in §3 is a draft until both platforms have a working feasibility spike (§7c). The iOS native session model in particular is unsettled going in — see §7b.

### 7a. Android (`android/src/main/java/dev/webnfcapi/NfcModule.kt`)

Reference `NfcManager.java` from `react-native-nfc-manager` for the concrete API calls; implement as a genuine Kotlin TurboModule (extend the codegen'd `NativeNfcSpec` base class, not `ReactContextBaseJavaModule`). `NfcAdapter`/`Ndef` maps onto the operation-oriented `Spec` cleanly since `enableReaderMode`'s callback delivers one tag at a time and reads/writes are naturally single-shot:

- `NfcAdapter.getDefaultAdapter(context)` for `isSupported()`/`isEnabled()`.
- `beginScan(operationId, options)` → `nfcAdapter.enableReaderMode(activity, readerCallback, flags, extras)`, remembering the active scan's `operationId`. On `onTagDiscovered(tag)`: if a `beginWrite`/`beginMakeReadOnly` is pending (per §5a's suspend policy), service that instead of emitting a read; otherwise `Ndef.get(tag)` → `ndef.cachedNdefMessage` (or `ndef.ndefMessage`) → convert each `NdefRecord` to `NdefWireRecord` (raw TNF/type/id/payload, no interpretation) → emit `tagDiscovered{operationId, ...}`.
- `beginWrite(operationId, records, options)` → record pending-write state keyed by `operationId`; on the next tag, `ndef.writeNdefMessage(NdefMessage(records.map(toAndroidNdefRecord)))`; enforce `overwrite:false` by checking `ndef.cachedNdefMessage` first; emit `operationEnded{operationId, reason:'success'}`.
- `beginMakeReadOnly(operationId, options)` → `ndef.makeReadOnly()` on next tag.
- `cancelOperation(operationId)` → if it's the active scan, `nfcAdapter.disableReaderMode(activity)`; if it's a pending write/makeReadOnly, clear the pending state; always emit `operationEnded{operationId, reason:'cancelled'}`.
- Listen for `NfcAdapter.ACTION_ADAPTER_STATE_CHANGED` → emit `stateChanged`.
- `consumePendingLaunchTag()` → dequeues and returns the front of an internal activation queue (or `null`), converting via the same `NdefRecord`→`NdefWireRecord` path as `beginScan`'s tag-discovered path (§12b).
- The activation queue is populated from two places, both required (§12b): `Activity.getIntent()` read once at Activity creation (cold launch), and `onNewIntent(intent)` (warm resume — the Activity already exists) — each successfully-parsed `Intent.EXTRA_NDEF_MESSAGES` payload enqueues one activation; `onNewIntent`'s enqueue additionally emits `launchTagReceived` since JS is already running to hear it, while the cold-launch enqueue is simply drained by `SessionCoordinator`'s startup call to `consumePendingLaunchTag()` (§12c).
- A small Activity `LifecycleEventListener` (registered by `NfcModule.kt`, not tied to any single `beginScan` call — the same standard RN mechanism `react-native-nfc-manager` uses for `onHostResume`/`onHostPause`) emits `appStateChanged{state:'foreground'|'background'}` on Activity resume/pause so `SessionCoordinator` can drive the reconciliation behavior in §12d — this is separate from, and does not use, Android's `enableForegroundDispatch()` API (§12b explains why that API is deliberately not used here).
- `build.gradle`: no external dependency needed — `android.nfc` is part of the Android SDK.

### 7b. iOS — open design questions

`NfcManager.m`'s delegate pattern is the reference, but the session model here is not prescribed:

- **Session type**: `NFCNDEFReaderSession` is simpler but doesn't hand back a connectable/writable tag reference — only the decoded `NFCNDEFMessage`. `NFCTagReaderSession` (polling `.iso14443`/`.iso15693`/`.felica`/`.iso18092`, filtering for `NFCNDEFTag`-conforming results) supports connect/query-status/write/lock. Whether `beginScan()` should always use `NFCTagReaderSession` uniformly, or pick per-operation, is decided by the feasibility spike (§7c), not here.
- **Session lifecycle**: `NFCTagReaderSession` requires an explicit `connect(to:completionHandler:)` per discovered tag and `restartPolling()` to continue detecting after one tag — `NFCNDEFReaderSession` with `invalidateAfterFirstRead: NO` behaves differently. Which delivers the "keep scanning across multiple taps" semantics from §5a with the least native-side state needs empirical verification.
- **Entitlements**: `com.apple.developer.nfc.readersession.formats` is required for `NFCTagReaderSession` polling non-NDEF formats and must list specific formats — confirm the exact entitlement/Info.plist combination for the chosen session type.
- **Timeout/session window**: Core NFC sessions have a system-controlled alert UI and timeout that don't map 1:1 onto "scan indefinitely until aborted" — verify against real device behavior.
- **Background/App-Clip launch delivery** (§12a): confirm `NSUserActivity.ndefMessagePayload` is actually populated the way `react-native-nfc-manager` assumes, on both a normal background-tag-read launch and an App Clip invocation, and confirm the RN bridge initializes early enough in the App Clip launch sequence to capture it (§12a) before `consumePendingLaunchTag()` is first called from JS.
- **Backgrounding a live session** (§12d): whether an active `NFCTagReaderSession`/`NFCNDEFReaderSession` can be meaningfully resumed after the app backgrounds (as opposed to always being invalidated by the OS, which is the conservative assumption in §12d) is unknown until tested — this determines whether iOS's `app-backgrounded` suspension is ever "resume the same conceptual session" or always "start a fresh one after an OS-forced invalidation."

### 7c. Feasibility spikes — required before freezing `NativeNfc.ts`

Before writing production Kotlin/Swift against the `Spec` in §3, build a throwaway iOS-only proof of concept (a plain Swift file driven from a test host app, outside the TurboModule scaffolding) that exercises the full **live-session** lifecycle:

```
begin session → detect an ordinary NDEF tag → connect → query NDEF status
→ read → write → lock (makeReadOnly) → invalidate session
```

and, separately, the full **launch/lifecycle** path (§12a, §12d):

```
tap a tag while app is backgrounded/not running → app launches/resumes
→ NSUserActivity carries the NDEF payload → consumePendingLaunchTag() returns it correctly
---
app has an active scan → app backgrounds → observe what iOS actually does
to the session → app foregrounds → attempt to resume scanning
```

Only once this is proven — including what a second tap looks like, what a user-cancel looks like, and what a read-only tag's status query returns — is §7b resolved and `NativeNfc.ts`'s `Spec` frozen for codegen. If the spike shows the operation-oriented `Spec` doesn't fit Core NFC well, revise §3/§5 at this point, before Android, the in-memory transport, and the conformance suite are built around a fixed shape.

Do the same lightweight validation for Android (§7a), even though its fit is more obvious, so both platforms get an empirical check before `Spec` is locked.

## 8. Error mapping

Central `lib/dom-exception.ts` (own shim, no dependency) + a mapping table in `WebNfcReader.ts` from native error codes/reasons to `DOMException` names. This table is now cross-checked against the actual WPT suite (§5e) rather than inferred solely from `web-nfc.d.ts` — every row below cites the WPT test that pins it down where one exists, and the two `overwrite`/`scan`-reentrancy corrections from §5d/§6e apply here too:

| Condition | DOMException name | WPT reference |
|---|---|---|
| No NFC hardware / no platform NFC implementation at all | `NotSupportedError` | `NDEFReader_scan.https.html:44-50`, `:58-62` |
| NFC radio present but switched off at the OS level | `NotReadableError` | `NDEFReader_scan.https.html:52-56` — **note this is distinct from, and easy to conflate with, `NotSupportedError`/`NotAllowedError`**; "hardware exists but is turned off" gets its own error name |
| User/OS denies NFC permission | `NotAllowedError` | `NDEFReader_scan.https.html:38-42` |
| `scan()` called on a reader that already has an active scan | `InvalidStateError` | `NDEFReader_scan.https.html:307-314` |
| `write()`/`makeReadOnly()` called while one is already in flight | *(not an error — replaces the prior operation, which itself then rejects with `AbortError`)* | `NDEFReader_write.https.html:389-412` |
| Write attempted with `overwrite:false` on a tag that already has NDEF records | `NotAllowedError` (**not** `InvalidStateError`) | `NDEFReader_write.https.html:466-472` |
| Tag removed / data transfer fails mid-read/write | `NetworkError` | `NDEFReader_write.https.html:474-478` |
| Tag discovered without NDEF technology | *(not an error on the promise — `readingerror` event fires instead of `reading`)* | `NDEFReader_scan.https.html:248-266` |
| `abort()` fires before or during an operation | `AbortError` | `NDEFReader_scan.https.html:110-124`, `NDEFReader_write.https.html:181-214` |
| Invalid `NDEFRecordInit`/`NDEFMessageInit` (bad `recordType`, non-coercible `data`, malformed dictionary) | `SyntaxError` | `NDEFReader_write.https.html:136-144` |
| Non-`AbortSignal` value passed as `signal` | `TypeError` (not a `DOMException` at all) | `NDEFReader_scan.https.html:13-36`, `NDEFReader_write.https.html:191-199` |
| Calling `scan()`/`write()`/`makeReadOnly()` from an iframe context | `InvalidStateError` | `NDEFReader_scan.https.html:64-94`, `NDEFReader_write.https.html:228-259` — not directly applicable to RN (no iframe concept), included for completeness since it's the same error name as the re-scan case above and worth not confusing with it |

## 9. Build tooling

Same toolchain as the serial repo:
- `react-native-builder-bob` for `lib/commonjs` + `lib/typescript` output.
- `biome.json` for lint/format (copy config as-is).
- Jest (`jest.config.js`) with a React Native preset; `example/jest.config.js` separately for app-level tests.
- `tsconfig.json` / `tsconfig.build.json` split (dev vs. publish).
- `react-native.config.js`: unlike serial (Android-only), this lib supports both platforms — no `ios: null` override needed.

**No lint/format-suppression directives.** `// biome-ignore`, `// eslint-disable`, `// eslint-disable-next-line`, or any equivalent suppression comment is not permitted anywhere in `src/`, `android/`, or `ios/` source. A rule violation must be fixed (rewrite the code so it satisfies the rule) or the rule itself must be changed in `biome.json` for the whole codebase (a deliberate, visible config change, reviewed as such) — never silenced at a single call site. The same applies to coverage-ignore directives (§6d): gaps and violations must surface in CI output, not be hidden inline.

## 10. Example app & E2E

`example/App.tsx` has four screens/states, one per platform-independent way of exercising the library:

1. **Live mode** — real scan/write against actual NFC hardware, backed by the default `new NDEFReader()` on Android/iOS and by `new NDEFReader()` (real passthrough) on web. This is the only screen that needs a physical device with NFC and a physical tag to test anything.
2. **Virtual Tag demo mode** — the reference implementation of "how do you simulate an NFC device on a real device," runnable on **Android, iOS, and web alike**, with no physical NFC tag required at any point:
   ```ts
   import {InMemoryNfcTransport, TextTag, UrlTag, ReadOnlyTag, SlowTag} from 'react-native-web-nfc-api/testing';

   const transport = new InMemoryNfcTransport();
   transport.addTag(new TextTag({text: 'hello from a virtual tag'}));
   // ...UrlTag, ReadOnlyTag, SlowTag, a smart-poster MultiRecordTag for toRecords()

   installInMemoryNfcTransport({enabled: true, tags: [...]}); // wires setNfcTransport() at app startup
   const demoReader = new NDEFReader({mode: 'managed'}); // works identically on Android, iOS, and web
   ```
   This screen is the concrete, runnable answer to "how do I develop/demo NFC flows without holding a physical tag up to a physical reader" — walk through it (§11 TESTING.md links here) rather than reconstructing the pattern from the `testing/` API reference alone. It exercises `TagHandle.tap()`/`.remove()` from a UI (buttons to simulate presenting/removing a tag), so it doubles as a manual QA tool during development, on any of the three platforms, including in a plain desktop browser.
3. **Self-Test screen** — calls `runNfcConformance()` (§6c) against whatever reader is active (live or demo), surfacing pass/fail per behavioral-matrix row (§6e), including the lifecycle rows (§12f), in the UI.
4. **Launch/lifecycle banner** (§12e) — a persistent banner showing "app was launched by a tag" when the normalized launch delivery (§12c) fires, plus manual "simulate background" / "simulate foreground" buttons (wired to `InMemoryNfcTransport.simulateBackground()`/`.simulateForeground()`, §12e) so scan-suspension behavior (§12d) is directly observable without physically backgrounding the app or holding a real tag to the device.

`example/.maestro/*.yaml`: scripted flows for all four screens above, run in CI against an emulator (no physical NFC hardware needed for the demo-mode, self-test, and lifecycle flows, since they only depend on `InMemoryNfcTransport`).

`example/index.web.js` + Vite config: the web build target. Live mode there needs real Chrome-on-Android for `NDEFReader` passthrough (informational only in a desktop dev browser — Web NFC requires HTTPS + Android Chrome), but Virtual Tag demo mode works in **any** browser, including a plain desktop dev server, since `mode: 'managed'` never touches the browser's native `NDEFReader` global.

## 11. TESTING.md outline

Write up front, before finishing code — it doubles as the design spec for `src/testing/`. Sections: the passthrough vs. managed split on web and `mode: 'managed'` (§4), injection priority (`setNfcTransport()` override → lazily-built platform transport; codec tests below the transport layer per §6a), the behavioral matrix (§6e) and its lifecycle additions (§12f), the spec-vs-policy table (§5d) as the canonical reference, the WPT-to-Jest adapter mapping (§5f) — including the explicit note that iframe-context and manual tests are deliberately not ported — the coverage policy (§6d), `InMemoryNfcTransport`/`SessionCoordinator` API reference, `SimulatedTag` catalogue, `NfcClient` reference, conformance suite usage split by layer (§6c), platform-fixture comparison testing (§6a), the example app's tag-simulation walkthrough (§10), WebSocket bridge usage (§6f), launch-delivery and background/foreground lifecycle testing (§12e), Maestro e2e usage.

## 12. Native app lifecycle: launch delivery and background/foreground

Required in v1 (§0). Two distinct mechanisms, both handled by `SessionCoordinator`, not by app code.

**Remark — no spec/WPT conflict here, by design.** Everything in this section (`activationId`, the launch-activation queue, `appStateChanged`/`launchTagReceived`, the drain-until-null and deduplication rules below) is RN-only machinery with no Web NFC spec counterpart to check against: the actual WPT suite (`docs/webidl-nfc-api/web-nfc/`, §5e) was searched for `activationId`, `launchTagReceived`, `consumePendingLaunchTag`, and `onNewIntent` and contains none of these terms — confirming the spec has no app-lifecycle model at all (browsers don't get backgrounded/relaunched the way native mobile apps do). This is consistent with, not contradicted by, the correction noted in §5d: those two corrections were genuine spec-behavior bugs caught by WPT; everything in §12 is a different category — RN-specific design with no spec to be right or wrong *about*, only internally consistent or not.

1. **Launch/resume delivery** — the app is started or resumed *because of* an NFC tap (cold launch, warm resume, App Clip invocation). Covered in §12a-12c.
2. **Background/foreground scan suspension** — a *live* `scan()` subscription must survive the app losing and regaining the foreground, even though the physical native reader session cannot itself run in the background. Covered in §12d.

Neither is a new tag technology (§0) — both are alternate ways an already-in-scope NDEF payload reaches the app, and both terminate in the same public `NDEFReader`/`reading` surface. App code never manually constructs an `NDEFMessage`/`NDEFReadingEvent` for either case — `SessionCoordinator` normalizes both into ordinary `reading` events (or the ordinary suspend/resume behavior already defined for exclusive operations in §5a), so there is exactly one code path (`onreading`) for "a tag was read," regardless of cause.

### 12a. iOS — background tag reading & App Clip launch

- **Background tag reading** (iOS 13+, requires the `com.apple.developer.nfc.readersession.formats` entitlement and `NFCReaderUsageDescription`): when the app is backgrounded or not running, iOS itself can present the system NFC UI on tag detection and deliver the result via `UIApplicationDelegate`'s `application(_:continue:restorationHandler:)` / `NSUserActivity.ndefMessagePayload` on launch. `react-native-nfc-manager`'s `ios/NfcManager.m` demonstrates this working, but only reads `ndefMessagePayload` after checking `userActivity.activityType == NSUserActivityTypeBrowsingWeb` — the feasibility spike (§7c) must confirm this is actually the activity type carried by an NFC-triggered background/App-Clip launch (rather than assuming any `NSUserActivity` delivery implies an NDEF payload is present) before `consumePendingLaunchTag()`'s iOS implementation is written against it.
- **App Clip launch**: an App Clip invoked via an NFC tap carries the same `NSUserActivity`-delivered NDEF payload as a background read — same delivery path, just an earlier/lighter app lifecycle; the only extra requirement is that the RN bridge/TurboModule initializes early enough in the App Clip's launch sequence to capture it before JS asks.
- Native captures this payload at `AppDelegate`/scene-lifecycle level (before JS runs) and holds it until `consumePendingLaunchTag()` (§3) is called.

### 12b. Android — launch-intent delivery

- An `<intent-filter>` for `android.nfc.action.NDEF_DISCOVERED` (declared in the consuming app's manifest, documented in README — this library cannot inject manifest entries) delivers a tapped tag as an `Intent` in two distinct situations, both of which must be handled:
  - **Cold launch**: the Activity doesn't exist yet — native reads `Intent.EXTRA_NDEF_MESSAGES` from `Activity.getIntent()` once the Activity is created.
  - **Warm resume**: the Activity already exists (backgrounded or otherwise) and Android delivers the new NFC intent via `onNewIntent(intent)` instead of recreating the Activity — native must read `Intent.EXTRA_NDEF_MESSAGES` from *that* intent, not from `getIntent()` (which still holds the original launch intent). Both paths enqueue an activation the same way (below); `onNewIntent` additionally emits `launchTagReceived` since JS is already running to hear it.
- Either path converts each `NdefMessage`/`NdefRecord` to `NdefWireRecord` (§5b) — same codec, same lossless representation as the live-scan path, no separate interpretation logic — and enqueues it as one activation for `consumePendingLaunchTag()` (§3) to drain.
- This is deliberately a **separate mechanism from `enableReaderMode()`** (§7a, §12d) — `enableReaderMode()` only ever acquires tags while an Activity is in the foreground with an active logical scan; it has no bearing on how the app is started or resumed by a tag tap. The two do not overlap: the launch-activation queue only ever answers "did an OS-level NFC intent start or resume this app," and `tagDiscovered` (via `enableReaderMode()`) only ever fires while a foreground `SessionCoordinator` scan is genuinely active. There is no "foreground dispatch enabled automatically by an active scan" mechanism in this design — `enableReaderMode()` already owns foreground tag acquisition on its own, so Android's separate `enableForegroundDispatch()` API is not used at all, avoiding two overlapping acquisition mechanisms.

### 12c. Normalizing launch delivery into `NDEFReader` — `SessionCoordinator`'s role

Each queued activation is a one-shot native record, not an event stream — there is no live `operationId` for an activation that happened before (or independently of) any `scan()` call. `SessionCoordinator` is what turns queue draining into the same `reading` events every other code path produces, so app code never synthesizes an `NDEFReadingEvent` itself:

- At JS module-load time (inside `NfcModule.ts`, §5), `SessionCoordinator` calls a `drainLaunchTags()` helper (below) once to consume whatever was queued before JS started (the cold-launch case), and subscribes to the `launchTagReceived` event (§3) for the lifetime of the process to catch warm-resume activations that arrive while JS is already running.
- **Drain until empty, not one item per notification.** `launchTagReceived` is treated as edge-triggered — "there is at least one activation available to consume" — rather than assumed to correspond 1:1 with exactly one queued entry:
  ```ts
  async function drainLaunchTags() {
    while (true) {
      const activation = await transport.consumePendingLaunchTag();
      if (!activation) break;
      if (consumedActivationIds.has(activation.activationId)) continue; // dedup, see below
      consumedActivationIds.add(activation.activationId);
      deliverOrQueue(activation);
    }
  }
  ```
  The same function runs both at startup and on every `launchTagReceived` event, so the design doesn't depend on native and JS agreeing on exactly how many notifications correspond to exactly how many queued items — it only depends on `consumePendingLaunchTag()` eventually returning `null` once the queue is empty, which is already part of its contract (§3).
- Each drained activation is delivered as one `tagDiscovered`-equivalent event to every reader currently in `scanSubscribers` at the moment it's consumed. If `scanSubscribers` is empty when an activation is available, `SessionCoordinator` holds it (in a small pending queue, mirroring native's) and delivers it to the **next** reader that calls `scan()`, so a cold launch before any reader exists still reaches the first subsequent scan — matching the spec's model where reading only ever happens as a result of `scan()`, just applied to a payload that arrived slightly before the call.
- **Deduplication by `activationId`**: `SessionCoordinator` keeps a bounded set (`consumedActivationIds`, evicted oldest-first past some small cap — exact size TBD, this only needs to survive plausible double-delivery windows, not the whole process lifetime) of activation ids it has already delivered, and skips any activation whose id it has seen before. This is required, not just defensive: `consumePendingLaunchTag()` is a plain method call that could in principle be invoked more than once concurrently (e.g. RN bridge reload/reinitialization, or `drainLaunchTags()` running both from the startup call and a rapid-fire `launchTagReceived` at the same time), and the invariant this protects is explicit — **`activationId` is unique per native-process NFC activation, and `SessionCoordinator` never emits a `reading` event twice for the same `activationId`**, even under concurrent or duplicate drain calls. `SessionCoordinator.test.ts` (§6b) gets a dedicated case simulating a duplicate `consumePendingLaunchTag()` resolution (or a duplicate `launchTagReceived` for an already-drained id) and asserting only one `reading` event results.

### 12d. Background/foreground scan suspension

A logical `scan()` subscription must outlive a temporary loss of the native foreground reader session. This is handled by the derived `shouldScan` model in §5a — backgrounding is simply one of the two independent conditions (`appForeground`) that `shouldScan` depends on, alongside `activeOperation` — so there is nothing background-specific to add to the state machine itself, only to how `appForeground` gets set:

- **Android — foreground → background**: `NfcModule.kt` registers a small Activity/`LifecycleEventListener` (the same standard RN mechanism `react-native-nfc-manager` already uses for its own `onHostResume`/`onHostPause`) and emits `appStateChanged{state:'background'}` on pause. `SessionCoordinator` sets `appForeground = false` and reconciles (§5a) — if a scan was active, this cancels it via the `internallyCancelledScans` mechanism, which guarantees it is never surfaced as `AbortError` to any subscribed reader, **without** removing any reader from `scanSubscribers`.
- **Android — background → foreground**: `appStateChanged{state:'foreground'}` on resume sets `appForeground = true` and reconciles — if `scanSubscribers` is still non-empty and no exclusive operation is active, this restarts the scan with a **new** `operationId` (never the cancelled one). If a write/makeReadOnly was also in flight, reconciliation naturally waits for `activeOperation` to clear too, since `shouldScan` requires both conditions — backgrounding never cancels an in-flight write, and an in-flight write is unaffected by a foreground transition.
- **User abort while backgrounded**: removing a reader from `scanSubscribers` (via that reader's own `AbortSignal`) is independent of `appForeground` — it simply shrinks the subscriber set through the same `scan()`-abort path used everywhere else. If it empties `scanSubscribers` entirely, `shouldScan` is `false` regardless of `appForeground`, so there is nothing to resume on foregrounding.
- **App process destroyed while backgrounded**: all in-memory `SessionCoordinator` state disappears with the process — a fresh process starts with empty state and drains any queued cold-launch activation via §12c normally if relaunched via a tap.
- **iOS**: the desired *JS-visible* behavior is identical to Android — a confirmed lifecycle-driven session termination should be normalized into `appForeground = false` (an internal suspension) rather than a caller-visible `AbortError`, and `appForeground = true` on return to foreground should attempt to restart scanning if subscribers remain. What native detection actually looks like is genuinely open going in: whether Core NFC reports a plain backgrounding as a distinct, catchable event before invalidating, or only ever reports invalidation after the fact via `didInvalidateWithError:` with no separate "about to background" signal, and whether a fresh session started on foregrounding is indistinguishable from one that could have been "resumed," are exactly the questions the feasibility spike (§7c) must answer empirically. Regardless of which callbacks turn out to be available, `NfcModule.mm`'s job is to translate whatever iOS actually reports into the same `appStateChanged` event Android emits, so `SessionCoordinator`'s reconciliation logic (§5a) needs no iOS-specific branch at all.

### 12e. Testing

Everything in §12 is testable without a real device, because the lifecycle signals are explicit events on `NfcTransport` (§5), not something bolted onto native only:

- `InMemoryNfcTransport` (§6b) gets `simulateLaunchTag(records: NdefWireRecord[])` to enqueue a simulated activation (firing `launchTagReceived` if a reader is already subscribed and JS is "already running" in the simulated sense, or held for cold-start-style draining otherwise), and `simulateBackground()`/`simulateForeground()` methods that emit `appStateChanged` — driving `SessionCoordinator`'s reconciliation logic (§5a, §12d) purely in Jest, through the exact same event types the real native transport emits.
- `SessionCoordinator.test.ts` (§6b) is extended, not duplicated, with lifecycle cases — see the behavioral matrix additions below for the exact list.
- Real-device validation (actually cold-launching the example app via a physical tag, warm-resuming it via a second tap, an App Clip on iOS, and backgrounding/foregrounding the app mid-scan) is part of the feasibility spikes (§7c) and the example app (§10), which gets a fourth screen state: "app was launched by a tag" banner driven by the normalized launch delivery (§12c), plus manual background/foreground toggling to observe scan suspension in the Virtual Tag demo mode.

### 12f. Behavioral matrix additions

These extend the table in §6e; see §5d for the spec-vs-policy split (all of these are RN/native platform adaptation, not Web NFC spec behavior — the spec has no concept of app lifecycle at all):

| Lifecycle case | Expected behavior |
|---|---|
| Cold launch with NDEF tag, then `scan()` | Queued activation delivered as one `reading` event to the first scanning reader; consumed exactly once |
| Normal launch (no tag) | `consumePendingLaunchTag()` resolves `null` at startup; no synthetic `reading` event |
| Warm resume via a second NFC tap while the process is still alive | A **new**, independent activation is enqueued and delivered via `launchTagReceived` — not blocked by an earlier activation already having been consumed |
| Activation already consumed, another reader scans later in the same process | No further delivery for that activation — each activation is removed from the queue on consumption; a *different* activation (e.g. from a later warm resume) is unaffected and still delivered |
| Active scan + foreground tag tap | Normal `tagDiscovered`/`reading` event via `enableReaderMode()` (Android) / active session (iOS) — unrelated to the launch-activation queue |
| App Clip launch via tag | Same normalization path as iOS background launch (§12a, §12c) |
| Scan active → app backgrounds | `appForeground` becomes `false`; `shouldScan` becomes `false`; physical scan cancelled via `internallyCancelledScans`; `scanSubscribers` unchanged |
| App foregrounds again with subscribers remaining and no active exclusive operation | `appForeground` becomes `true`; `shouldScan` becomes `true`; scan restarts with a **new** `operationId` |
| `scan()` aborted while app is backgrounded | That reader removed from `scanSubscribers`; `shouldScan` stays `false` regardless of `appForeground`; does not resume on foreground |
| Backgrounding while a write is in flight | `activeOperation` keeps `shouldScan` false independent of `appForeground`; write completes/fails on its own operation; scan restarts only once **both** `activeOperation` is null and `appForeground` is true |
| Foregrounding while a write is in flight (started during backgrounding) | Same as above — `shouldScan` doesn't depend on ordering, only current values of both conditions |
| iOS reports a lifecycle-driven session termination (exact native signal TBD by §7c) | Normalized to `appStateChanged{state:'background'}` — never surfaced as caller `AbortError`, identical downstream handling to Android |

## 13. Build order

The native `Spec` (§3, including `consumePendingLaunchTag()`) and wire format (§5b) are not treated as final until both an Android and an iOS feasibility spike have exercised **both the live-session path and the launch/lifecycle path** (§12) against real hardware — everything downstream (codegen, the in-memory transport, the conformance suite) is comparatively cheap to build and adjust; the native contract is expensive to change late.

1. Scaffold package (bob, tsconfig, biome, `package.json` with `exports` map; hold off on finalizing `codegenConfig` until step 7).
2. Write the behavioral matrix (§6e) including its lifecycle additions (§12f), spec-vs-policy table (§5d), and the neutral wire representation (`ndef-wire.ts`, §5b) — the contracts everything else is built against. Cross-check every spec-behavior claim in these tables against the actual WPT suite (`docs/webidl-nfc-api/web-nfc/`, §5e) before writing it down — do not infer behavior from `web-nfc.d.ts`/`EXPLAINER.md` alone, since they define shapes, not behavior, and can be (and were, in an earlier draft — §5d) silently wrong on exactly the scenarios that matter.
3. Codec tests (§6a): `ndef-wire.ts` / `well-known-records.ts` / `web-record.ts` implementations plus vectors and round-trip tests, entirely in Node/Jest.
4. `transport.ts` + `SessionCoordinator.ts` + `WebNfcReader.ts`, built and tested against a hand-written fake `NfcTransport` — validates the JS API surface, concurrency policy (§5a), cancellation (§5c), launch-delivery normalization (§12c), and background/foreground suspension (§12d) before touching native.
5. `testing/` package (`InMemoryNfcTransport`, `SimulatedTag`, fixtures, harness) + conformance suite (§6c) running against the in-memory transport, including the lifecycle cases from §12e/§12f.
6. Android feasibility spike (§7c) — throwaway POC on a real device exercising **both** the live-session path (`enableReaderMode()`) and the launch-intent/backgrounding path (§12b, §12d) — followed by production `NfcModule.kt` once confirmed.
7. iOS feasibility spike (§7c) — resolves the open questions in §7b, **and** validates `consumePendingLaunchTag()`'s background/App-Clip delivery (§12a) and whether/how a backgrounded Core NFC session can be resumed (§12d). Only after this does `NativeNfc.ts`'s `Spec` get frozen and `codegenConfig` finalized. If the spike shows the `Spec` needs to change shape, revise §3/§5/§12 now.
8. Production iOS `NfcModule.mm`/Swift against the frozen `Spec`; re-run the conformance suite (§6c) against real Android and iOS hardware, including lifecycle cases; add platform fixtures (§6a) captured from both.
9. `WebNfcReader.ts`'s web `PassthroughStrategy` (§4) — validate `new NDEFReader()` (default passthrough) against real Chrome-on-Android, and `new NDEFReader({mode: 'managed'})` against `InMemoryNfcTransport` in the same browser.
10. `websocket/bridge.ts` + `bin/expose-nfc.js` + example app virtual-tag demo + Maestro e2e (§6f), including the example app's launch-tag banner and background/foreground toggling (§12e).
11. README + TESTING.md polish, publish prep.
