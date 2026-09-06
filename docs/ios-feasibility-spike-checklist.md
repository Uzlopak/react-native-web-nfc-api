# iOS feasibility spike checklist (§7c)

This is the literal, step-by-step manual procedure for someone with a **Mac +
Xcode + a physical iPhone with NFC (iPhone 7 or later, iOS 13+ recommended)**
to run the feasibility spike that `IMPLEMENTATION_PLAN.md` §7c requires before
`ios/NfcModule.swift` and the `Spec` in `src/NativeNfc.ts` can be considered
frozen for iOS. Nothing in `ios/` has been compiled or run — this checklist is
the single most valuable deliverable of the iOS work in this repo, since it is
what actually unblocks finishing it.

Follow it top to bottom. Each step names the exact Core NFC API expected to be
involved and what to observe/report. Do not skip the "report back" template at
the end — fill it in as you go, not from memory afterward.

Simulators cannot be used for any of this — Core NFC reading/writing requires
real hardware; the simulator has no NFC radio.

---

## 0. Prerequisites

- A Mac with a recent Xcode (matching whatever iOS SDK you're targeting).
- An Apple Developer account enrolled in the paid Apple Developer Program —
  the `com.apple.developer.nfc.readersession.formats` entitlement requires a
  provisioning profile from a paid account; it is not available to a free
  personal-team profile. Confirm this before starting (this is a documented
  Apple constraint, not something this repo's scaffolding can work around).
- A physical iPhone 7 or later, NFC-capable, on a recent iOS version, with a
  Lightning/USB-C cable for on-device debugging.
- At least 2-3 real NDEF-formatted NFC tags (NTAG213/215/216 are cheap and
  common) — some blank/writable, at least one you don't mind locking
  read-only permanently during step 3g (locking is irreversible).
- This repo checked out locally, with network access for `pod install`.

## 1. Get the package to compile inside a throwaway host app

This is more valuable to do FIRST, before touching real NFC hardware, because
`ios/NfcModule.swift` and `ios/NfcModule.mm` were written without any Swift
compiler or Xcode available — the very first useful signal is simply whether
this code compiles at all against a real RN 0.85 New Architecture project.

1. Create a fresh RN 0.85.x app: `npx @react-native-community/cli init NfcSpike --version 0.85.3` (or use `example/` in this repo if its `ios/` stub has been fleshed out by then — check `example/ios/README-STUB.md` first, it may still be a placeholder).
2. Ensure New Architecture is enabled (RN 0.85 defaults to it, but confirm `RCT_NEW_ARCH_ENABLED=1` is effectively set, e.g. check `ios/Podfile` for `:new_arch_enabled`).
3. Add this package as a local dependency: in the throwaway app's `package.json`, `"react-native-web-nfc-api": "file:../path/to/react-native-web-nfc-api"`, then `npm install`.
4. In the throwaway app's `ios/Podfile`, confirm the pod resolves (`react-native-web-nfc-api` should appear after `pod install` — run `cd ios && pod install`).
5. **Report**: did `pod install` succeed? If not, paste the exact CocoaPods error — likely candidates given this scaffold's open questions: `install_modules_dependencies` signature mismatch (see the podspec's own inline comment), or a missing `React-Core` version constraint.
6. Open `ios/NfcSpike.xcworkspace` in Xcode and build (`Cmd+B`) for a real device target (not simulator — CoreNFC frameworks may still be linkable for simulator builds, but there's no reason to burn time there).
7. **Report**: does it compile? If not, paste every compiler error. Likely candidates given this scaffold's flagged uncertainty:
   - The `#import "react_native_web_nfc_api-Swift.h"` / `"WebNfcApi-Swift.h"` guess in `ios/NfcModule.mm` may not match the actual generated header name — find the real one in Xcode's build products (`DerivedData/.../Build/Products/Debug-iphoneos/react-native-web-nfc-api/react-native-web-nfc-api-Swift.h` or similar) and fix the `#import` in `NfcModule.mm`.
   - `RCT_EXTERN_REMAP_MODULE` may not be the correct/sufficient mechanism for a New-Architecture-only Swift TurboModule — if codegen expects `NfcModule` to conform to a generated `NativeNfcSpec` Objective-C protocol and the compiler complains about missing/mismatched protocol methods, that is the exact signal needed to correct `ios/NfcModule.swift`'s method signatures (parameter order, block types, etc.) to match codegen's actual output. Find the generated protocol at `ios/build/generated/ios/...` or wherever this project's codegen output lands (check `DerivedData` or run `RCT_NEW_ARCH_ENABLED=1 npx react-native codegen-ios` or whatever this RN version's equivalent invocation is) and diff it against `NfcModule.swift`'s method signatures by hand.
   - `RCTPromiseResolveBlock`/`RCTPromiseRejectBlock` may not be visible to Swift without an explicit bridging header import — if so, add one and note it here for `NfcModule.swift`'s bridging comment to be corrected.
8. Once it compiles: add a minimal test screen calling `NativeModules.NativeNfc.isSupported()` (or the codegen'd typed equivalent) and confirm it resolves `true` on your test device without crashing. This alone validates the addListener/removeListeners plumbing isn't fatally broken.
9. **Report**: paste the exact diffs you had to make to get to a green build. This is the most valuable single artifact from this whole checklist for someone maintaining this repo afterward.

## 2. Entitlements and Info.plist

1. In Xcode, select the app target → Signing & Capabilities → "+ Capability" → add **Near Field Communication Tag Reading**. Confirm this writes `com.apple.developer.nfc.readersession.formats` into a generated `.entitlements` file, with at least `NDEF` (and `TAG` if you plan to test the `NFCTagReaderSession` alternative — see step 3's open question) in the array.
2. In `Info.plist`, add `NFCReaderUsageDescription` with a user-facing string (e.g. "This app uses NFC to read and write NDEF tags."). Without this, `NFCNDEFReaderSession.begin()` should fail immediately or the OS permission prompt won't show the right text — confirm which.
3. **Report**: exact final contents of the generated `.entitlements` file and the `NFCReaderUsageDescription` value you used, so these can be copied into this repo's documentation (there is currently no `ios/*.entitlements` file or `Info.plist` in this repo at all, since there's no Xcode project — see `IMPLEMENTATION_PLAN.md` §12a and this repo's `README.md` "iOS entitlements" section, which currently just describes these requirements in prose).

## 3. Core NFC session spike — the exact §7c sequence

This is the heart of the spike: begin session → detect tag → connect → query
NDEF status → read → write → lock → invalidate, run as a real, throwaway,
minimal Swift snippet (does not need to go through this library's
`NfcModule.swift` at all for this step — a bare `NFCNDEFReaderSessionDelegate`
implementation in a scratch view controller is faster to iterate on and
isolates Core NFC's actual behavior from any bugs in this repo's bridging
code). Once each step's behavior is confirmed, cross-check it against
`ios/NfcModule.swift`'s corresponding implementation and correct any
divergence.

**a. Begin session.**
```swift
let session = NFCNDEFReaderSession(delegate: self, queue: nil, invalidateAfterFirstRead: false)
session.alertMessage = "Hold near tag"
session.begin()
```
- **Report**: does the system NFC sheet ("Ready to Scan") appear immediately? Is there any completion signal that session "became active" (the way `NFCTagReaderSessionDelegate.tagReaderSessionDidBecomeActive` exists for the tag-session variant) — or is `begin()` fire-and-forget with no confirmation? `ios/NfcModule.swift`'s `beginScan` currently resolves its promise immediately after calling `.begin()` with no such confirmation — confirm whether this is actually safe (i.e. `begin()` can't silently no-op) or whether it needs to wait for some other signal.

**b. Detect tag.** Tap a tag to the phone.
- Expected callback (iOS 13+, tag-based path — the path this scaffold's `NfcModule.swift` implements): `func readerSession(_ session: NFCNDEFReaderSession, didDetectTags tags: [NFCNDEFTag])`.
- **Report**: does this exact method get called? (Confirm the exact selector — Core NFC's delegate protocol shape has been documented inconsistently across sources consulted while writing this scaffold; this is one of the least certain parts of `ios/NfcModule.swift`.) Does `didDetectNDEFs:` (the older, non-tag-based callback also implemented in `NfcModule.swift` for broad-compatibility) fire instead, in addition, or not at all on your iOS version?

**c. Connect.**
```swift
session.connect(to: tag) { error in ... }
```
- **Report**: typical latency for `connect(to:)` to complete. Does it ever legitimately fail requiring `session.restartPolling()` (as `NfcModule.swift` does on error) under normal conditions, or only on tag-removed-too-fast scenarios?

**d. Query NDEF status.**
```swift
tag.queryNDEFStatus { status, capacity, error in ... }
```
- **Report**: for a blank/writable tag, what does `status` read as (`.notSupported` / `.readOnly` / `.readWrite`)? For a tag already containing records, does `status` alone distinguish "has records" from "empty but writable" — or, as `NfcModule.swift`'s `serviceWrite` comment flags, does distinguishing "has existing records" (needed for the `overwrite: false` → `NotAllowedError` case, §5d/§8) actually require a read-before-write step that isn't currently implemented? This is a concrete gap to fix based on your answer.

**e. Read.**
```swift
tag.readNDEF { message, error in ... }
```
- **Report**: confirm `message.records` gives `NFCNDEFPayload` objects with `.typeNameFormat`/`.type`/`.identifier`/`.payload` populated as expected. Cross-check one tag's raw bytes (use another tool, e.g. NFC Tools on Android or a hex-dump utility, to independently read the same physical tag) against what this session reports, to sanity-check the TNF/type/id/payload mapping in `ios/NfcModule.swift`'s `payloadToWireRecord`/`tnfToCoreNFC`.
- **Also verify the base64 wire-format claim**: in a Swift scratch file/playground, run `Data([0x54]).base64EncodedString()` and confirm it prints `"VA=="` — this is the worked example in `ios/NfcModule.swift`'s `WireCodec` doc-comment; confirming it closes out the one part of the wire-format fidelity requirement (§5b of the plan) that could not be checked without a real Swift runtime.

**f. Write.**
```swift
let message = NFCNDEFMessage(records: [/* NFCNDEFPayload */])
tag.writeNDEF(message) { error in ... }
```
- **Report**: write a small text record, then read it back (power-cycle the tag — tap away and re-tap — to rule out any session-level caching) to confirm round-trip fidelity, including through this library's actual `beginWrite`/wire-format path if step 1's build succeeded, not just the scratch snippet.

**g. Lock (write-protect).** ⚠️ Irreversible — use a tag you don't need writable afterward.
```swift
tag.writeLock { error in ... }
```
- **Report**: confirm the tag becomes read-only (`queryNDEFStatus` should now report `.readOnly`). Then, separately, call `writeLock` again on the SAME now-locked tag and observe whether it errors or succeeds — this resolves the open question in `NfcModule.swift`'s `serviceMakeReadOnly` comment about whether Core NFC itself tolerates a redundant lock call (needed for §6e's "makeReadOnly() on an already-read-only tag resolves as a no-op" policy) or whether this module needs an explicit `.readOnly` pre-check to short-circuit to success itself.

**h. Invalidate.**
```swift
session.invalidate()
```
- **Report**: does `didInvalidateWithError:` fire synchronously or asynchronously relative to this call? What `Error`/`NFCReaderError` code does a normal, deliberate `invalidate()` call produce (as opposed to a user tapping "Done" on the system sheet, or a session timing out)? List the distinct `NFCReaderError` codes you can trigger deliberately (deliberate invalidate, tag removed mid-operation, letting the ~60s system timeout elapse, tapping "Done") and their `.code` values, so `readerSession(_:didInvalidateWithError:)` in `NfcModule.swift` (currently a blanket "always report `reason: 'error'`", flagged as an open gap in its own comment) can be updated to map these onto the Spec's `'cancelled'|'timeout'|'error'` distinction properly.

## 4. Session-type decision re-check

`ios/NfcModule.swift`'s header comment commits to `NFCNDEFReaderSession` over
`NFCTagReaderSession`, based on precedent in
`docs/react-native-nfc-manager/ios/NfcManager.m` and the NDEF-only scope of
this plan (§0). While running step 3 above:

- **Report**: did `NFCNDEFReaderSession` + its tag-based delegate methods
  (`didDetectTags:`/`connect(to:)`/`queryNDEFStatus`/`readNDEF`/`writeNDEF`/
  `writeLock`) prove sufficient for every one of steps 3b-3g, or did you hit
  a capability gap that required falling back to `NFCTagReaderSession`? If
  the latter, note exactly which step failed and why — this would mean
  `ios/NfcModule.swift`'s session-type decision needs to be revisited.

## 5. Launch / lifecycle spike (§12a, §12d)

This section resolves the open design questions flagged at length in
`ios/NfcModule.swift`'s `WebNfcApiLaunchBridge` class comment and its
`handleAppDidEnterBackground`/`handleAppDidBecomeActive` comment.

### 5a. Cold launch via NFC tap

1. In the throwaway app's `AppDelegate`, implement
   `application(_:continue:restorationHandler:)` and log every field of the
   incoming `NSUserActivity` (`.activityType`, `.webpageURL`,
   `.userInfo`, and — if `.activityType == NSUserActivityTypeBrowsingWeb` —
   `.ndefMessagePayload`).
2. This requires the tag to encode a URL under an Associated Domain your app
   is registered for (App Clip / universal link setup) — set up a minimal
   Associated Domains entitlement + `apple-app-site-association` file on a
   host you control, matching Apple's documented App Clip/NFC background-tag
   flow, OR consult current Apple documentation for whether a plain
   (non-associated-domain) tag can still trigger this callback at all. This
   step's feasibility depends on infrastructure this checklist can't fully
   specify in advance — treat it as exploratory.
3. Force-quit the app. Tap the tag. Observe whether the app cold-launches and
   what `continueUserActivity` receives.
4. **Report**: exact `activityType` value observed. Exact contents of
   `ndefMessagePayload` if present (record count, TNF/type/payload of each).
   Whether `NSUserActivityTypeBrowsingWeb` was indeed the activity type (this
   is nfc-manager's precedent, followed as an unverified assumption in
   `WebNfcApiLaunchBridge.handleContinueUserActivity`), or something else.

### 5b. Warm resume

1. With the app already running in the background (not force-quit), tap the
   same/another configured tag.
2. **Report**: does `application(_:continue:restorationHandler:)` fire again
   while already running? Does the timing/ordering differ from cold launch in
   any way relevant to `NfcLaunchActivationQueue`'s
   "enqueue, then notify via `launchTagReceived` only if JS is already
   running" logic in `ios/NfcModule.swift`?

### 5c. Backgrounding mid-scan

1. Start a scan (`beginScan`, or the scratch-snippet equivalent from step 3a)
   with the system NFC sheet showing.
2. Press the Home button (or swipe to background the app) while the sheet is
   showing, before tapping any tag.
3. **Report**: does `didInvalidateWithError:` fire immediately when
   backgrounding? What error/code? Does `UIApplication.didEnterBackgroundNotification`
   fire before, after, or interleaved with it (add logging with timestamps
   to both to compare ordering)? This directly resolves the open question in
   `NfcModule.swift`'s `handleAppDidEnterBackground` comment block.
4. Foreground the app again. Does anything need to be done manually to
   restart scanning, or was the session already fully torn down by step 3's
   findings?

### 5d. App Clip (if applicable to your use case)

If this library's consumers plan to support App Clip NFC invocation
specifically (§0/§12a call this in-scope):

1. Set up a minimal App Clip target per Apple's current App Clip + NFC
   documentation (this checklist does not reproduce Apple's App Clip setup
   steps in full — consult current Apple docs, since App Clip tooling changes
   between Xcode versions).
2. Encode an NFC tag with the App Clip's invocation URL.
3. Tap the tag with the App Clip not yet installed, and observe the App Clip
   card / invocation flow.
4. **Report**: does the same `NSUserActivityTypeBrowsingWeb` +
   `ndefMessagePayload` mechanism apply, or does App Clip invocation deliver
   the NDEF payload through some other channel?

---

## Report-back template

Copy this into your response when done. Fill in every field — "unknown" /
"didn't get this far" is a valid, useful answer; don't guess.

```
### iOS spike report — [date] — [iOS version] / [device model] / [Xcode version]

1. Build (§1)
   - pod install succeeded: yes/no — errors (if any):
   - Xcode build succeeded: yes/no — errors (if any):
   - Fixes required to NfcModule.mm's Swift header import:
   - Fixes required to NfcModule.swift's method signatures (protocol mismatch, if any):
   - isSupported() call from JS resolved correctly: yes/no

2. Entitlements (§2)
   - Final .entitlements contents:
   - NFCReaderUsageDescription value used:

3. Core NFC sequence (§3)
   - begin() confirmation signal: [none observed / describe]
   - didDetectTags vs didDetectNDEFs: [which fired, on which iOS version]
   - connect(to:) typical latency / failure modes:
   - queryNDEFStatus results for blank tag / tag-with-records / locked tag:
   - read round-trip byte-for-byte match against independent tool: yes/no
   - Data([0x54]).base64EncodedString() == "VA==": yes/no
   - write round-trip confirmed: yes/no
   - writeLock behavior on fresh tag / already-locked tag:
   - invalidate() timing (sync/async) and NFCReaderError codes observed for: deliberate invalidate / user "Done" tap / timeout / tag removed mid-op

4. Session type decision (§4)
   - NFCNDEFReaderSession sufficient for all of read/write/lock: yes/no
   - If no, what specifically required NFCTagReaderSession:

5. Launch/lifecycle (§5)
   - Cold launch activityType observed:
   - ndefMessagePayload contents on cold launch:
   - Warm resume behavior vs cold launch:
   - Backgrounding mid-scan: didInvalidateWithError timing/code vs didEnterBackgroundNotification timing:
   - App Clip mechanism (if tested):

6. Overall recommendation
   - Is `ios/NfcModule.swift`'s architecture sound as scaffolded, or does it need a structural rewrite (e.g. switch session types, add read-before-write, restructure event emission)?
```
