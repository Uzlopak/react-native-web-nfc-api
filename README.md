# react-native-web-nfc-api

> The [W3C Web NFC API](https://w3c.github.io/web-nfc/) (`NDEFReader`, `NDEFMessage`, `NDEFRecord`) for React Native on Android and iOS, passing through to the browser's native `NDEFReader` on web (Chrome) by default.

Use the same API you already know from the browser — `new NDEFReader()`, `scan()`, `write()`, `makeReadOnly()`, `onreading`/`onreadingerror` — in a React Native app that talks to real NFC hardware, with a first-class in-memory simulator for testing and demos on every platform, including plain desktop web with no NFC hardware at all.

## At a glance

- Spec-shaped `NDEFReader` / `NDEFMessage` / `NDEFRecord` / `NDEFReadingEvent`
- New Architecture TurboModule (Android `NfcAdapter`/`Ndef`, iOS Core NFC)
- A fully in-memory `NfcTransport` simulator (`InMemoryNfcTransport` + canned `SimulatedTag`s) — no hardware, no mocking framework
- On web, passes through to the browser's real `NDEFReader` by default; an explicit `mode: 'managed'` opt-out runs the same simulatable implementation as native, in any browser
- A WebSocket bridge (`expose-nfc` CLI) for driving a real device/emulator/browser against a simulated tag during manual QA
- Native app-lifecycle integration: tag-tap launch/resume delivery and background/foreground scan suspension (§12 of `IMPLEMENTATION_PLAN.md`)

## Platform support

| Platform | Support | Notes |
| --- | --- | --- |
| Android | Yes | Native NFC support (`NfcAdapter`/`Ndef`) through the TurboModule. |
| iOS | Implemented, unverified | Core NFC (`ios/NfcModule.swift`), covering live scanning and background/App-Clip tag-launch delivery — see "iOS status" below before relying on this. |
| Web | Yes | Passes through to the browser's native `NDEFReader` (Chrome, HTTPS, Android) by default; `mode: 'managed'` runs the simulator in any browser. |

## iOS status

The iOS Swift TurboModule (`ios/NfcModule.swift`, `ios/NfcModule.mm`,
`ios/NfcPackage.swift`, `react-native-web-nfc-api.podspec`) exists and is
implemented against Core NFC, matching the completeness level of the Android
module — but it has been written and reviewed with **no Mac, no Xcode, and no
physical iPhone available**, so nothing about it has been compiled, linked,
or run.

- The native `Spec` (`src/NativeNfc.ts`) is **not frozen for iOS** per
  `IMPLEMENTATION_PLAN.md` §7c: the operation-oriented shape, the session
  type chosen in `ios/NfcModule.swift`, the `NSUserActivityTypeBrowsingWeb`
  launch-delivery check, and the backgrounding-detection strategy are all
  flagged `UNVERIFIED`/`DECISION POINT` comments at their exact locations in
  that file, pending empirical confirmation.
- The Swift/TurboModule bridging approach in `ios/NfcModule.mm` and
  `ios/NfcPackage.swift` is a best-understanding draft, not a confirmed
  pattern for RN 0.85 — see those files' own headers for the open questions
  (in particular, what RN 0.85's codegen actually generates for this
  package's `codegenConfig.name`, which has not been observed).
- There is no Xcode project, `Info.plist`, or `.entitlements` file anywhere
  in this repo yet (there's no `ios/*.xcodeproj` and no example-app iOS
  project) — the `com.apple.developer.nfc.readersession.formats` entitlement
  and the `NFCReaderUsageDescription` Info.plist key both need to be added by
  whoever integrates this into a real host app; they cannot ship from this
  library alone.
- **Blocked until real hardware validates it**: everything under "iOS" in
  the platform table above, the entire `ios/` implementation, and the
  `codegenConfig`/`Spec` freeze in `IMPLEMENTATION_PLAN.md` §13 step 7 are
  blocked on running
  [`docs/ios-feasibility-spike-checklist.md`](./docs/ios-feasibility-spike-checklist.md)
  on a Mac with a physical iPhone. Do not treat the iOS module as
  production-ready until that checklist has been run and its findings
  incorporated.

## Installation

```sh
npm install react-native-web-nfc-api
# or
yarn add react-native-web-nfc-api
```

This is a New Architecture (Turbo Modules + codegen) library — no old-bridge fallback. Make sure your app has the New Architecture enabled. No manual linking is required on Android/iOS; the module is autolinked.

## Quick start

```ts
import {NDEFReader} from 'react-native-web-nfc-api';

async function run() {
  const reader = new NDEFReader();

  reader.onreading = event => {
    console.log('serial number:', event.serialNumber);
    for (const record of event.message.records) {
      console.log(record.recordType, record.mediaType, record.data);
    }
  };
  reader.onreadingerror = () => console.log('tag is not NDEF-formatted');

  await reader.scan(); // resolves once the reader session is active, not once a tag is read
  await reader.write('hello'); // encoded as a "text" record — see "Writing", below
}
```

- On **Android/iOS**, this drives real NFC hardware.
- On **web**, `new NDEFReader()` (the default, `mode: 'passthrough'`) forwards every call straight to the browser's own `window.NDEFReader` — behaviorally identical to calling it yourself. Web NFC currently only works in Chrome on Android over HTTPS; in any other browser, methods reject with `NotSupportedError` at call time (see "The passthrough vs. managed split" below for why detection is per-call, not per-construction).

### Writing

`write()` accepts a `string`, `BufferSource`, or `NDEFMessageInit`:

```ts
await reader.write('hello'); // always a "text" record — strings are never auto-detected as URLs
await reader.write({records: [{recordType: 'url', data: 'https://example.com'}]});
await reader.write(new TextEncoder().encode('raw bytes'));
```

Every async method accepts an `AbortSignal`:

```ts
const controller = new AbortController();
await reader.scan({signal: controller.signal});
controller.abort(); // scan()'s pending promise rejects with AbortError
```

### Feature detection

Because this library always exports a working `NDEFReader` class (unlike a real unsupported browser, which simply has no global `NDEFReader` at all — see below), a non-spec static helper is provided for feature-detecting before construction:

```ts
if (NDEFReader.isSupported()) {
  const reader = new NDEFReader();
  // ...
}
```

`NDEFReader.isSupported(mode?)` mirrors `mode`'s own semantics: with the default `'passthrough'` on web it reflects whether `window.NDEFReader` exists; on native, or with `mode: 'managed'`, it's always `true` (whether real hardware/a transport is actually usable is an async, per-call concern answered by `scan()`/`write()` rejecting, not by this helper).

## The passthrough vs. managed split (web only)

On native there's exactly one implementation — a managed polyfill backed by native NFC hardware — and `mode` has no effect. On **web**, `NDEFReader` decides **at construction time** which of two strategies to use:

```ts
interface NDEFReaderOptions {
  mode?: 'passthrough' | 'managed'; // web only; ignored on native. Default: 'passthrough'.
}
```

- **`new NDEFReader()`** (default) — forwards every call directly to a real `window.NDEFReader`. No wire-format translation, no simulator, no transport in the path at all. If `window.NDEFReader` doesn't exist, methods reject with `NotSupportedError` **at call time**, not at construction/import time. This is a deliberate, documented divergence from a raw spec-compliant browser: real Chrome/other browsers simply don't define a global `NDEFReader` at all in an unsupported context, so bare spec-following app code gets a `ReferenceError` on `new NDEFReader()` itself. This library always exports a working class (so RN/web bundling has something concrete to import), so unsupported-browser detection necessarily happens per-method-call instead — use `NDEFReader.isSupported?.()` or a caught rejection.
- **`new NDEFReader({mode: 'managed'})`** — routes through the same managed implementation native uses, resolving to whatever transport was installed via `setNfcTransport()` (typically `InMemoryNfcTransport`, see below), or a `NotSupportedError`-throwing stub if none was installed. This is what makes simulation/testing possible on web, in any browser, without physical NFC hardware.

A per-instance option (rather than a module-level switch) means the same app can hold a real reader and a simulated one side by side — e.g. a live scan screen plus a demo/self-test screen — exactly as multiple concurrent `NDEFReader` instances are already supported on native.

## Permission model (RN platform divergence)

The Web NFC spec relies on the browser's Permissions API (`navigator.permissions.query({name: 'nfc'})`). **React Native has no such API**, and this library does not implement a `navigator.permissions` shim — there is no reliable way to report permission state RN itself can't observe. Instead:

- **Android**: `android.permission.NFC` is a *normal-protection* permission — there is no runtime prompt. The library instead checks whether the NFC adapter is present and enabled (surfaced as `NotSupportedError`/`NotReadableError` from `scan()`/`write()`/`makeReadOnly()`).
- **iOS**: an `NFCReaderUsageDescription` entry in `Info.plist` is required; the OS shows its own system permission prompt automatically the first time a Core NFC session starts. There is no separate JS-visible permission step — the first `scan()`/`write()` call triggers it.

Document this divergence in your own app's UX (e.g. don't build a pre-flight "permission granted?" screen backed by `navigator.permissions` — there's nothing to query). See `IMPLEMENTATION_PLAN.md` §2 for the full rationale.

### Detecting "NFC is off" (Android)

There is no standalone `isEnabled()` on the public `NDEFReader` API — the Web NFC spec has no such method either. Instead:

- On Android, the adapter being present but disabled (user turned NFC off in system settings) surfaces as `scan()`/`write()`/`makeReadOnly()` rejecting with `NotReadableError`. This is the only reliable, spec-faithful signal — checking `isEnabled()` ahead of time and then calling `scan()` would still race the user toggling the setting in between the two calls.
- The library does not poll the adapter state or expose a live "NFC toggled" event on the public API (native does register an `ACTION_ADAPTER_STATE_CHANGED` receiver internally, but it's reserved for internal use and not surfaced to JS) — an app that wants a live "NFC is off" banner should catch `NotReadableError` from its own `scan()`/`write()` calls and update its UI from that, rather than trying to observe the radio state independently. See `examples/nfc-rewriter/src/NfcProxy.ts`'s `setNotReadableHandler()` for a working example of this pattern.

## Testing & simulation

Everything above `lib/`'s codec layer is testable without hardware via `react-native-web-nfc-api/testing`:

```ts
import {NDEFReader, setNfcTransport} from 'react-native-web-nfc-api';
import {InMemoryNfcTransport, TextTag} from 'react-native-web-nfc-api/testing';

const transport = new InMemoryNfcTransport();
transport.addTag(new TextTag({text: 'hello from a virtual tag'}));
setNfcTransport(transport);

const reader = new NDEFReader({mode: 'managed'}); // works identically on Android, iOS, and web
reader.onreading = event => console.log(event.message.records);
await reader.scan();
```

This mirrors the example app's Virtual Tag demo screen (see `examples/self-test/App.tsx`). Canned tags cover the common cases: `TextTag`, `UrlTag`, `ReadOnlyTag`, `EmptyTag`, `MultiRecordTag`, `SlowTag` (cancellation testing), `FlakyTag` (Nth-write failure), `NonNdefTag` (`readingerror`, not `reading`).

**See [`TESTING.md`](./TESTING.md)** for the full design spec: the behavioral matrix, `InMemoryNfcTransport`/`SessionCoordinator` API reference, the `SimulatedTag` catalogue, `NfcClient`, the conformance suite, the WebSocket bridge, and lifecycle/Maestro testing.

## WebSocket bridge — manual device QA

`InMemoryNfcTransport` covers in-process simulation for unit tests, but exercising a **real device, emulator, or browser** against a simulated tag — without physical NFC hardware — needs the WebSocket bridge:

```sh
npx expose-nfc --tag "text:hello from the bridge" --port 8787
```

```
Simulated tag ("text:hello from the bridge") exposed on ws://127.0.0.1:8787
Waiting for a client connection... (Ctrl+C to stop)
```

`--tag` accepts `text:<value>`, `url:<value>`, `empty`, `readonly:<value>`, or `json:<path>` (a JSON file of `NdefWireRecord[]` for a `MultiRecordTag`). Run `npx expose-nfc --help` for the full option list. See TESTING.md for the wire protocol and a client-side usage sketch.

For CI/Maestro runs against the example app, `installInMemoryNfcTransport({enabled, tags})` (from `react-native-web-nfc-api/websocket`) does a flag-gated global install of a deterministic simulated transport at app startup — see TESTING.md's Maestro section.

## Native app lifecycle

Two RN-specific mechanisms, both normalized into the same `NDEFReader`/`reading` surface app code already uses — neither is part of the Web NFC spec, which has no app-lifecycle model at all:

1. **Launch/resume delivery** — a cold launch, warm resume, or App Clip invocation triggered by tapping a tag delivers that tag's data as an ordinary `reading` event on the first `scan()` call after the app starts/resumes, via `consumePendingLaunchTag()`/`launchTagReceived`.
2. **Background/foreground scan suspension** — a live `scan()` subscription survives the app losing and regaining the foreground: the physical native reader session is suspended (never surfaced to the caller as `AbortError`) and resumed automatically, with a fresh operation, once the app foregrounds again (assuming no exclusive write is in flight).

Both are fully testable via `InMemoryNfcTransport.simulateLaunchTag()`/`.simulateBackground()`/`.simulateForeground()` — see TESTING.md §"launch-delivery and background/foreground lifecycle testing" and the example app's Launch/lifecycle screen.

### Android manifest

To receive tag-tap launches, add an intent filter to your app's launcher activity:

```xml
<activity android:name=".MainActivity" ...>
  <intent-filter>
    <action android:name="android.nfc.action.NDEF_DISCOVERED" />
    <category android:name="android.intent.category.DEFAULT" />
    <data android:mimeType="text/plain" />
  </intent-filter>
</activity>
```

(This library cannot inject manifest entries into a consuming app — add this yourself if you need launch delivery.)

### iOS entitlements

Add the `com.apple.developer.nfc.readersession.formats` entitlement and an `NFCReaderUsageDescription` entry to `Info.plist`.

## Example apps

Two runnable RN apps under `examples/`:

- **`examples/self-test/`** — exercises the library's own API directly across four screens: Live mode, Virtual Tag demo, Self-Test (the shared conformance suite, on-device), and a Launch/lifecycle banner with manual background/foreground toggles. See `examples/self-test/.maestro/*.yaml` for scripted e2e flows.
- **`examples/nfc-rewriter/`** — a port of the community [react-native-nfc-rewriter](https://github.com/revtel/react-native-nfc-rewriter) app (originally built on `react-native-nfc-manager`) rebuilt against this library's `NDEFReader` API, demonstrating a more realistic app shape (scan, write text/URI/vCard/WiFi records, save/reopen records, tag detail view). Screens relying on raw tag-technology access (Custom Transceive, Tag Kit) were dropped — see that app's own README/comments for what changed and why.

Run either with:

```sh
cd examples/self-test    # or: cd examples/nfc-rewriter
npm install
npm run android   # or: npm run web
```

## Scope

This library implements the Web NFC spec's own surface: `NDEFReader`/`NDEFMessage`/`NDEFRecord`, i.e. NDEF-formatted tags only. Raw tag-technology access below the NDEF layer (Mifare Classic/Ultralight, IsoDep, FeliCa, ISO15693 as distinct tag types) is out of scope — the spec has no concept of these.

## License

MIT
