# Testing react-native-web-nfc-api

This document is the design spec for `src/testing/` as well as the reference
for how this repo tests itself. It corresponds to §6/§11/§12 of
`IMPLEMENTATION_PLAN.md` — see that file for the authoritative design
rationale; this document is the practical, example-driven companion.

Status: covers build-order steps 1-5 (codec, `SessionCoordinator`,
`WebNfcReader`, the `testing/` package, and the conformance suite against
`InMemoryNfcTransport`) and steps 10-11 (the WebSocket bridge, the example
app, Maestro flows, and this document/README's own polish). **Native
(`android/`, `ios/`) is still not implemented** — the native `Spec` remains a
draft pending the feasibility spikes (§7c) — see "Known gaps" at the end of
this document for the full list of what's real vs. stubbed.

## 1. Passthrough vs. managed mode on web (§4)

On native (Android/iOS) there is only one implementation: the managed
polyfill (`SessionCoordinator` + `NfcTransport` + `NativeNfc`). `mode` has no
effect there.

On web, `NDEFReader` decides **at construction time** which of two internal
strategies to use:

- **`new NDEFReader()`** (default, `mode: 'passthrough'`) — forwards every
  call directly to the browser's real `window.NDEFReader`. No
  `NdefWireRecord` translation, no `SessionCoordinator`, no `NfcTransport` in
  the path. If `window.NDEFReader` doesn't exist, methods reject with
  `NotSupportedError` at call time (not at construction/import time — see
  §4's note on why this is a deliberate, documented divergence from a raw
  spec-compliant browser, which simply wouldn't define `NDEFReader` at all).
- **`new NDEFReader({mode: 'managed'})`** — routes through
  `SessionCoordinator` + `getNfcTransport()`, exactly like native. This is
  what makes simulation/testing possible on web: install an
  `InMemoryNfcTransport` via `setNfcTransport()`, then construct every
  reader with `mode: 'managed'`.

## 2. Injection priority

`getNfcTransport()` (in `src/NfcModule.ts`) resolves in this order:

1. Whatever was passed to `setNfcTransport(transport)` — the override always
   wins, for the lifetime of the process (or until `resetNfcTransport()` /
   another `setNfcTransport()` call).
2. Otherwise, a lazily-built platform transport wrapping `NativeNfc` (the
   TurboModule). On web, or wherever the native module isn't linked, every
   method on this fallback transport rejects with `NotSupportedError` — there
   is nothing to fall back to besides an explicitly injected transport.

Codec correctness (`lib/ndef-wire.ts`, `lib/well-known-records.ts`,
`lib/web-record.ts`) is tested **below** the transport layer entirely — no
`NfcTransport`, no `NDEFReader`, no simulator involved (§6a). This is
deliberate layering: a codec bug should never require a `SessionCoordinator`
or transport fixture to reproduce.

## 3. Behavioral matrix (§6e)

Concurrency, cancellation, and edge-case semantics are pinned down here
*before* implementation, and `SessionCoordinator`, `WebNfcReader`, and the
conformance suite are written against this table. See §4 (spec-vs-policy)
below for which rows are spec-mandated vs. RN-specific policy.

| Operation / state | Expected result | Test |
|---|---|---|
| `scan()` while already scanning (same reader) | Rejects with `InvalidStateError` | `SessionCoordinator.test.ts`, conformance suite |
| `scan()` on a second `NDEFReader` while first is scanning | Both resolve; both receive subsequent `reading` events | `SessionCoordinator.test.ts` (broadcast), conformance suite |
| `write()` while a `write()`/`makeReadOnly()` is already in flight (any reader) | Replaces the in-flight one — earlier promise rejects `AbortError`, new one proceeds; never `InvalidStateError` | `SessionCoordinator.test.ts`, conformance suite |
| `write()` while only `scan()`(s) are active | Allowed; scan suspended for the duration, then resumes with a new operationId | `SessionCoordinator.test.ts`, conformance suite |
| Stopping one reader's scan while another is still scanning | Native scan stays alive; only the stopped reader stops receiving events | `SessionCoordinator.test.ts` |
| `abort()` before the native operation starts | Rejects with `AbortError`, native `beginX` never called | `SessionCoordinator.test.ts`, conformance suite |
| `abort()` while the native operation is in flight | `cancelOperation` invoked; pending promise rejects with `AbortError` | conformance suite |
| Tag removed mid-read or mid-write | Rejects/emits with `NetworkError` | `TagHandle.failNextWrite()`/`FlakyTag` tests |
| `write()` targeting a `ReadOnlyTag` | Rejects with `InvalidStateError` | conformance suite |
| `makeReadOnly()` on an already-read-only tag | Resolves (no-op success) | conformance suite |
| `write()` with `overwrite:false` on a tag that already has records | Rejects with `NotAllowedError` (not `InvalidStateError`) | conformance suite |
| Tag discovered with zero records (`EmptyTag`) | `reading` fires with `message.records = []` | conformance suite |
| Tag exposes a non-NDEF technology | `readingerror` fires, not `reading` | conformance suite |
| NFC radio disabled | `scan()`/`write()`/`makeReadOnly()` reject with `NotReadableError` | conformance suite |
| No NFC hardware / no platform implementation | reject with `NotSupportedError` | conformance suite |
| User/OS denies NFC permission | reject with `NotAllowedError` | (native-only; not yet exercised in-memory) |
| Session times out with no tag presented | `operationEnded{reason:'timeout'}` maps to `NotAllowedError` | `SessionCoordinator.test.ts` |

### Lifecycle additions (§12f)

| Lifecycle case | Expected behavior | Test |
|---|---|---|
| Cold launch with NDEF tag, then `scan()` | Queued activation delivered as one `reading` event to the first scanning reader; consumed exactly once | `SessionCoordinator.test.ts` |
| Normal launch (no tag) | `consumePendingLaunchTag()` resolves `null` at startup; no synthetic `reading` event | `SessionCoordinator.test.ts` |
| Warm resume via a second NFC tap while the process is still alive | A new, independent activation is enqueued and delivered via `launchTagReceived` | `SessionCoordinator.test.ts` |
| Activation already consumed, another reader scans later | No further delivery for that activation; a different activation is unaffected | `SessionCoordinator.test.ts` |
| Active scan + foreground tag tap | Normal `tagDiscovered`/`reading` via the live scan path — unrelated to the launch-activation queue | `SessionCoordinator.test.ts` |
| Scan active → app backgrounds | `appForeground` false; `shouldScan` false; physical scan cancelled via `internallyCancelledScans`; `scanSubscribers` unchanged | `SessionCoordinator.test.ts` |
| App foregrounds again, subscribers remain, no active exclusive op | `shouldScan` true; scan restarts with a **new** operationId | `SessionCoordinator.test.ts` |
| `scan()` aborted while app is backgrounded | Reader removed from `scanSubscribers`; `shouldScan` stays false regardless of `appForeground`; no resume on foreground | `SessionCoordinator.test.ts` |
| Backgrounding while a write is in flight | `activeOperation` keeps `shouldScan` false independent of `appForeground`; scan restarts only once **both** clear | `SessionCoordinator.test.ts` |
| Foregrounding while a write started during backgrounding | Same as above — order-independent | `SessionCoordinator.test.ts` |
| iOS lifecycle-driven session termination (native signal TBD) | Normalized to `appStateChanged{state:'background'}`, never a caller `AbortError` | native (not yet implemented) |

## 4. Spec behavior vs. implementation policy (§5d)

| Behavior | Source |
|---|---|
| `abort()` before/mid-operation rejects with `AbortError` | Web NFC spec (WPT `NDEFReader_scan.https.html:110-124`, `NDEFReader_write.https.html:181-189`) |
| Coercion of `string`/`BufferSource`/`NDEFMessageInit` on write | Web NFC spec (WPT `NDEFReader_write.https.html:350-367`) |
| `scan()` on a reader that already has an active scan rejects `InvalidStateError` | Web NFC spec (WPT `NDEFReader_scan.https.html:307-314`) |
| A second `write()`/`makeReadOnly()` **replaces** a previously in-flight one | Web NFC spec (WPT `NDEFReader_write.https.html:389-412`, `NDEFReader_make-read-only.https.window.js:139`) |
| `write()` with `overwrite:false` on a tag with existing records rejects `NotAllowedError` (not `InvalidStateError`) | Web NFC spec (WPT `NDEFReader_write.https.html:466-472`) |
| Two different `NDEFReader`s scanning both receive `reading` events (broadcast) | RN implementation policy — the spec has no multi-reader-on-one-radio concept |
| A `write()` suspends an active scan and resumes it afterward | RN implementation policy — WPT's mock has no shared-physical-radio concept |
| `makeReadOnly()` on an already-read-only tag resolves as a no-op | RN implementation policy |
| Launch-delivery queue, `activationId`, background/foreground suspension (all of §12) | RN-only machinery — no Web NFC spec counterpart at all (browsers have no app lifecycle) |
| iOS system session timeout / restart-polling behavior | Platform adaptation (Core NFC constraint) |

Anything not explicitly marked "Web NFC spec" above is RN implementation
policy, open to revision if it proves not to match real-world app
expectations.

## 5. WPT-to-Jest adapter mapping (§5f)

The WPT test suite (`docs/webidl-nfc-api/web-nfc/`) is `testharness.js`-based
and drives a Chromium-specific Mojo mock (`mockNFC`), so it can't run as-is.
The table below is the mapping used when porting scenarios into
`src/__tests__/conformance-suite.ts`:

| WPT primitive | This project's equivalent |
|---|---|
| `nfc_test(func, name, properties)` | A plain Jest `test(name, async () => {...})` |
| `initialize_nfc_tests()` / mock setup | `createTagFixture(tag \| tag[], opts)` |
| `mockNFC.setReadingMessage(message)` | `transport.addTag(new SomeSimulatedTag(...))`, then `tagHandle.tap()` if `requireExplicitTap` |
| `mockNFC.setHWStatus(...)` | `transport.setHardwareStatus('enabled' \| 'disabled' \| 'not-supported')` |
| `mockNFC.simulateNonNDEFTagDiscovered()` | `new NonNdefTag()` |
| `mockNFC.simulateDataTransferFails()` | `tagHandle.failNextWrite()` |
| `mockNFC.setIsFormattedTag(true)` | A `SimulatedTag` constructed with non-empty `records` |
| `mockNFC.pushedMessage()` / `.writeOptions()` | `simulatedTag.lastWrite: {records, overwrite} \| null` |
| `test_driver.set_permission(...)` | No direct equivalent — model via a transport that rejects `NotAllowedError` |
| `new EventWatcher(...).wait_for("reading")` | `NfcClient.waitForReading({timeout})` |
| `promise_rejects_dom(t, 'ErrorName', promise)` | `assertRejectsWithName(promise, 'ErrorName')` |
| `assertWebNDEFMessagesEqual(a, b)` | Ported directly into `testing/harness.ts` |
| `createMessage`/`createRecord`/`createTextRecord`/etc. | Ported directly into `testing/harness.ts` |

**Explicitly not ported**, and this is a documented decision, not an
oversight:

- The iframe-context tests (`NDEFReader_scan_iframe.https.html` and the
  inline iframe cases elsewhere) — RN has no iframe/document concept.
- The `*-manual.https.html` files — human-in-the-loop only, even in the
  original WPT suite. Useful as a manual QA checklist, not conformance-suite
  input.

## 6. Coverage policy (§6d)

No blanket 100% target is set for the whole package. Coverage is a proxy —
the goal is that every row of the behavioral matrix above and every codec
vector has a corresponding assertion. Concretely:

- **`src/lib/**` (the codec: `ndef-wire.ts`, `well-known-records.ts`,
  `web-record.ts`, plus the `EventTarget`/`DOMException`/`AbortSignal`
  shims) and `SessionCoordinator.ts`** are pure logic with no
  native/platform branching — held to **100% line/branch coverage**,
  enforced by `jest.config.js`'s `coverageThreshold`. **No coverage-ignore
  directives are permitted anywhere in these files** — an untested branch
  here is either dead code (delete it) or a missing test (write it).
- **`WebNfcReader.ts`'s `ManagedStrategy`** is covered by the conformance
  suite against `InMemoryNfcTransport` — near-complete coverage of the
  public API surface is expected, but not gated in CI.
- **`WebNfcReader.ts`'s `PassthroughStrategy`**, `NativeNfc.ts`,
  `NfcModule.ts`'s native-transport glue, and (once written) native
  `NfcModule.kt`/`NfcModule.mm` are **not** held to a coverage percentage —
  they're thin forwarding/glue code whose meaningful bar is "does it work
  against real hardware/a real browser," not line coverage of forwarding
  calls.

Run `npm run test:coverage` to see the current numbers; CI enforces the
threshold only on the two paths named above (see `jest.config.js`).

**No lint-suppression comments anywhere in `src/`** — `// biome-ignore` or
equivalent is never used to silence a rule violation; the code is rewritten
to satisfy the rule, or the rule itself is changed in `biome.json` as a
deliberate, visible config change.

## 7. `InMemoryNfcTransport` API reference

```ts
import {InMemoryNfcTransport} from 'react-native-web-nfc-api/testing';

const transport = new InMemoryNfcTransport({
  tapDelayMs?: number;        // default 0 — delay before a tap's tagDiscovered/write fires
  autoEnabled?: boolean;      // default true — false starts hardwareStatus 'disabled'
  requireExplicitTap?: boolean; // default false — if true, addTag() alone doesn't fire discovery for scan()
});

const handle = transport.addTag(someSimulatedTag); // returns a TagHandle
transport.setHardwareStatus('enabled' | 'disabled' | 'not-supported');

// Lifecycle simulation (§12e):
transport.simulateLaunchTag(records, {serialNumber?});
transport.simulateBackground();
transport.simulateForeground();
```

`TagHandle`:

```ts
handle.tap();               // explicitly trigger tagDiscovered (when requireExplicitTap is set)
handle.remove();             // simulate the tag leaving the field
handle.failNextWrite();      // next write against this tag rejects NetworkError
handle.emitOperationError('error' | 'timeout', message?); // fail whichever op is servicing this tag
handle.isRemoved();
handle.whenScanned(): Promise<void>;
```

Notes on semantics:

- `requireExplicitTap` only gates **scan-side discovery** — a pending
  `write()`/`makeReadOnly()` is still serviced as soon as a tag is
  physically present (`addTag()`), matching how a real device would
  service a pending write the instant a tag enters the field, tap
  notification or not.
- Discovery is always delivered asynchronously (a macrotask), even with
  `tapDelayMs: 0` — real hardware discovery is never synchronous with
  `beginScan()`'s own resolution, and this matters concretely: callers
  (including `NfcClient`) legitimately attach their `'reading'` listener
  only *after* `await reader.scan()` resolves.

## 8. `SimulatedTag` catalogue

| Class | Behavior |
|---|---|
| `SimulatedTag` | Base class: `serialNumber`, `records`, `writable`, `lastWrite`, `onWrite()`, `onMakeReadOnly()` |
| `TextTag({text, lang?})` | A single well-known text record |
| `UrlTag({url})` | A single well-known URI record |
| `ReadOnlyTag({records?})` | `writable: false` — `write()` rejects `InvalidStateError`; `makeReadOnly()` no-ops |
| `EmptyTag()` | Zero records |
| `MultiRecordTag({records})` | Arbitrary pre-built `NdefWireRecord[]` (e.g. a smart-poster) |
| `SlowTag({delayMs})` | Delays discovery/write servicing by `delayMs` — for cancellation testing |
| `FlakyTag({failOnAttempt})` | Fails the Nth write attempt with `NetworkError`, succeeds otherwise |
| `NonNdefTag()` | `isNdef = false` — discovery surfaces `readingerror`, not `reading` |

## 9. `NfcClient` reference

```ts
import {NfcClient} from 'react-native-web-nfc-api/testing';

const client = new NfcClient(reader);
await client.scan({timeout?});
await client.write(message, {overwrite?, signal?, timeout?});
const ev = await client.waitForReading({timeout?});       // NDEFReadingEvent
const errEv = await client.waitForReadingError({timeout?});
await client.expectNoReading(ms);                           // throws if a reading fires within ms
client.close();
```

## 10. Conformance suite usage (§6c)

`src/__tests__/conformance-suite.ts` exports:

- `conformanceCases: ConformanceCase[]` — `{name, run}` pairs, each a
  transport-independent behavioral assertion from the matrix above, built
  against `InMemoryNfcTransport` via `createTagFixture`.
- `runNfcConformance(): Promise<ConformanceResult[]>` — runs every case and
  collects `{name, passed, error?}`, intended for the example app's
  Self-Test screen (not yet built) as well as `conformance-suite.test.ts`
  (the actual Jest entry point in this repo, which runs each case as its
  own `test()`).

Layering, per §6c:

- **Transport-independent assertions** (this suite) — scan lifecycle, write
  coercion, concurrency policy, abort semantics, error mapping. Hold for
  any correct `NfcTransport`.
- **Fault-injection tests** (in-memory only) — `SlowTag`/`FlakyTag`
  scenarios requiring exact timing/failure control that can't transfer to
  arbitrary physical hardware.
- **Real-device compatibility tests** — running the transport-independent
  subset against real hardware from the example app (not yet built).

## 11. Platform-fixture comparison testing (§6a)

Not yet implemented. The plan calls for real `NdefRecord` byte dumps from an
Android device and real `NFCNDEFPayload` byte dumps from an iOS device,
captured from the same physical tag, checked into `lib/__tests__/fixtures/`
as raw hex, asserting both produce identical `NDEFRecord` output through the
shared JS codec. This requires physical devices and is deferred until the
native feasibility spikes (build-order step 6/7) produce real capture
tooling — tracked as a **TODO**, not silently dropped.

## 12. Example app walkthrough / WebSocket bridge / Maestro e2e

Status: **implemented** (build-order step 10). `examples/self-test/` is a runnable RN
app (Android/iOS/web) with four screens, one per platform-independent way of
exercising the library (§10). This section is the practical walkthrough; the
example app's own `App.tsx` is the executable reference.

### 12.1 The example app's four screens

- **Live mode** (`live-screen` / tab `tab-live`) — the default
  `new NDEFReader()`: real passthrough on web, real native NFC on
  Android/iOS. `NDEFReader.isSupported()` is shown so the feature-detection
  helper (§ "Feature detection" in README.md) is visible in context.
- **Virtual Tag demo** (`demo-screen` / tab `tab-demo`) — the concrete answer
  to "how do I develop/demo NFC flows without a physical tag." A single
  `InMemoryNfcTransport` is created once (`createDemoTransport()` in
  `App.tsx`) and installed globally via `setNfcTransport()`, seeded with a
  `TextTag`, `UrlTag`, `ReadOnlyTag`, `SlowTag`, and a `MultiRecordTag`
  (smart-poster-shaped, for `toRecords()`). Every screen in the app that
  constructs `new NDEFReader({mode: 'managed'})` shares this same transport,
  mirroring how a real device has exactly one physical radio. The "Tap first
  tag" button adds a fresh `TextTag` to the field, triggering a `reading`
  event logged in the UI.
- **Self-Test** (`selftest-screen` / tab `tab-selftest`) — calls this
  package's own `runNfcConformance()` (§6c, §10) directly from
  `src/__tests__/conformance-suite.ts` and renders pass/fail per row, exactly
  the "real-device compatibility tests" layer described in §6c — the same
  suite Jest runs via `conformance-suite.test.ts` gets an on-device UI here.
  No new export was needed: `runNfcConformance()` was already exported for
  exactly this purpose.
- **Launch / lifecycle** (`lifecycle-screen` / tab `tab-lifecycle`) — a
  persistent banner (`launch-banner`) that appears once a queued launch
  activation is delivered as a `reading` event (driven here by
  `transport.simulateLaunchTag()`, §12e), plus manual "Simulate background" /
  "Simulate foreground" buttons wired to
  `InMemoryNfcTransport.simulateBackground()`/`.simulateForeground()`, making
  scan-suspension behavior (§12d) directly observable without physically
  backgrounding the app or holding a real tag.

### 12.2 WebSocket bridge (§6f)

`src/websocket/bridge.ts` exposes a single `SimulatedTag` over a small
JSON-over-WebSocket protocol, for exercising a **real** device, emulator, or
browser against a simulated tag without physical NFC hardware. `ws` (an
`optionalDependency`) is lazy-loaded only inside `exposeSimulatedTag()` —
merely importing `react-native-web-nfc-api/websocket` never fails when `ws`
isn't installed.

**CLI** (`bin/expose-nfc.js`, package.json `bin: {"expose-nfc": ...}`):

```sh
npx expose-nfc --tag "text:hello from the bridge" --port 8787
# or
npx expose-nfc --tag url:https://example.com
npx expose-nfc --tag empty
npx expose-nfc --tag readonly:"a locked tag"
npx expose-nfc --tag-json ./my-smart-poster.json   # NdefWireRecord[] -> MultiRecordTag
npx expose-nfc --help
```

Flags: `-t/--tag <spec>` (see above; env `NFC_TAG`), `--tag-json <path>`
(shorthand for `--tag json:<path>`; env `NFC_TAG_JSON`), `-w/--port <n>`
(default 8787; env `WS_PORT`), `--host <addr>` (default `127.0.0.1`; env
`HOST`), `--allow-remote` (binds `0.0.0.0` — only on trusted networks).

**Protocol** (one WebSocket connection per tag; JSON text frames both ways):

| Direction | Frame | When |
|---|---|---|
| server → client | `{"type":"tagState", serialNumber, records, writable, isNdef}` | On connect, and after every write/makeReadOnly |
| server → client | `{"type":"tagDiscovered", serialNumber, records}` | Whenever the tag is (re)tapped |
| server → client | `{"type":"tagRemoved"}` | When the tag leaves the field |
| server → client | `{"type":"response", id, error}` | Acknowledges a client command |
| client → server | `{"type":"command", id, command: "tap"}` | Re-trigger `tagDiscovered` |
| client → server | `{"type":"command", id, command: "remove"}` | Simulate tag removal |
| client → server | `{"type":"command", id, command: "failNextWrite"}` | Next write rejects `NetworkError` |
| client → server | `{"type":"command", id, command: "write", args: {records}}` | Apply a write directly |
| client → server | `{"type":"command", id, command: "makeReadOnly"}` | Lock the tag |

Only one client is served at a time — mirrors real NFC's "one tag in the
field" constraint; a second connection while one is active is closed
immediately (`attachBridge`/`exposeSimulatedTag` in `src/websocket/bridge.ts`).

**Programmatic usage** (e.g. from a test harness or a custom tool):

```ts
import {WebSocketServer} from 'ws';
import {exposeSimulatedTag} from 'react-native-web-nfc-api/websocket';
import {TextTag} from 'react-native-web-nfc-api/testing';

const {close} = exposeSimulatedTag(new TextTag({text: 'hello'}), {
  port: 8787,
  WebSocketServer, // passed in explicitly — bridge.ts never imports `ws` itself
});
// ...
close();
```

**Flag-gated global install for Maestro/emulator e2e** (also §6f):

```ts
import {installInMemoryNfcTransport} from 'react-native-web-nfc-api/websocket';

installInMemoryNfcTransport({
  enabled: process.env.E2E === '1',
  tags: [new TextTag({text: 'e2e tag'})],
});
```

This wires `setNfcTransport()` under the hood, so every subsequent
`new NDEFReader({mode: 'managed'})` in the app picks up a deterministic
simulated transport — the mechanism CI would use to drive the example app's
Maestro flows against known tag state without physical hardware.

### 12.3 Launch-delivery and background/foreground lifecycle testing (§12e)

Already covered end-to-end above in §3 ("Lifecycle additions") and §7
(`InMemoryNfcTransport` API reference, `simulateLaunchTag`/
`simulateBackground`/`simulateForeground`) — those sections cover the
`SessionCoordinator`/Jest layer. What's new here is the **on-device** version:
the example app's Launch/lifecycle screen (§12.1 above) exercises the exact
same `InMemoryNfcTransport` methods from a real UI, so the behavior is
observable interactively, not just asserted in a test file. Real-device
validation (an actual cold tag-launch, warm resume via a second tap, an App
Clip on iOS, backgrounding/foregrounding mid-scan) remains part of the native
feasibility spikes (§7c) and is not yet performed — this library's native
Android/iOS code (`android/`, `ios/`) has not been implemented yet (see Known
gaps below).

### 12.4 Maestro e2e usage

**Prerequisites**: an Android emulator or device with the example app's debug
build installed (`cd examples/self-test && npm install && npm run android`), then
[Maestro](https://maestro.mobile.dev/) installed on the host machine.

```sh
cd examples/self-test
npm run e2e                       # runs every flow in .maestro/
maestro test .maestro/self-test.yaml   # or run one flow directly
```

Four flows, one per screen (`examples/self-test/.maestro/*.yaml`):

- **`live-mode.yaml`** — opens Live mode and asserts the feature-detection
  label and scan button render; does not assert a specific scan outcome,
  since no CI emulator has a physical NFC radio.
- **`virtual-tag-demo.yaml`** — taps the demo screen's "Tap first tag" button
  and asserts a `reading:` log line appears — fully deterministic, no
  hardware needed, since it only depends on `InMemoryNfcTransport`.
- **`self-test.yaml`** — runs the on-device conformance suite and asserts
  every row passes (`.*passed.*` visible, no `✗`).
- **`lifecycle.yaml`** — simulates a cold-launch tag tap (asserts the launch
  banner appears), then toggles background/foreground and asserts the
  app-state label updates — fully deterministic, no hardware needed.

All four flows are plausible, well-formed Maestro specs reviewed as such;
none have actually been run against a live emulator in this sandbox (no
emulator/Maestro available here) — they are reviewable specs, not yet
CI-verified execution.

## Known gaps (tracked, not accidental)

These are called out explicitly so a reader of this document doesn't mistake
"not yet done" for "forgotten":

- **Native implementation** (`android/`, `ios/`) — Android is implemented per
  `NfcModule.kt`. **iOS now has a Swift implementation
  (`ios/NfcModule.swift`, `ios/NfcModule.mm`, `ios/NfcPackage.swift`) written
  against Core NFC, but it is implemented-per-spec and UNVERIFIED — it has
  never been compiled, linked, or run, since no Mac/Xcode/physical iPhone was
  available while writing it.** The native `Spec` in `src/NativeNfc.ts`
  remains a draft per the plan (§3, §7c) until the iOS feasibility spike in
  [`docs/ios-feasibility-spike-checklist.md`](./docs/ios-feasibility-spike-checklist.md)
  is actually run on real hardware — session-type choice, the
  `NSUserActivityTypeBrowsingWeb` launch-delivery assumption, backgrounding
  detection, and the Swift/TurboModule bridging shape in `ios/NfcModule.mm`
  are all open questions flagged inline in those files pending that spike.
  See the README's "iOS status" section for a summary.
- **Example app's `android/`/`ios/` projects** — `examples/self-test/android/` is a
  minimal stub (settings.gradle/build.gradle/gradle.properties/app build.gradle
  only — no Gradle wrapper, manifest, or Kotlin sources; see
  `examples/self-test/android/README-STUB.md`); `examples/self-test/ios/` has no Xcode project at
  all (see `examples/self-test/ios/README-STUB.md`). Both are placeholders per this
  build step's explicit scope boundary ("full native project generation is
  out of scope") — the example app's *JS/TS* side (App.tsx, Metro/Babel/Vite
  config) is complete and typechecks against the library's real exports.
- **Platform byte-dump fixtures** (§6a) — requires physical devices; see
  §11 above.
- **iOS/Android feasibility spikes** (§7c) — not started; several §12
  behaviors (exact iOS backgrounding signal, App Clip launch timing) are
  explicitly marked TBD in the plan pending these spikes.
- **Maestro flows are unexecuted** — reviewed as well-formed specs (§12.4
  above), not run against a live emulator, since no Android emulator/Maestro
  binary is available in this environment.
