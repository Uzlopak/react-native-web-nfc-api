// ios/NfcModule.swift
//
// TurboModule implementation of the operation-oriented NFC Spec (IMPLEMENTATION_PLAN.md §3),
// targeting Core NFC on iOS.
//
// ============================================================================
// STATUS: IMPLEMENTED PER SPEC, UNVERIFIED. There is no Mac, no Xcode, and no
// physical iPhone in the environment this file was written in. Nothing in
// this file has been compiled, linked, type-checked by swiftc, or run. Every
// Core NFC API name/signature below is written from documented API shape as
// best understood, not confirmed against a real SDK. Treat every line as a
// draft for someone with real hardware to correct — see
// docs/ios-feasibility-spike-checklist.md for the concrete validation plan
// (§7c of IMPLEMENTATION_PLAN.md).
// ============================================================================
//
// Bridging note (RN 0.85 New Architecture, Swift TurboModule):
// UNVERIFIED — my best understanding is that RN's Codegen, when it sees this
// module registered as `NativeNfc` and finds `NativeNfcSpec` generated from
// src/NativeNfc.ts, generates an Objective-C protocol (`NativeNfcSpec`, a
// `@protocol`) that a Swift class can conform to directly, PROVIDED an
// Objective-C++ shim exposes this Swift class to the RCTTurboModule registry
// via `RCT_EXTERN_MODULE`/a small `.mm` file (see ios/NfcModule.mm in this
// same directory) — analogous to how a Swift RN "old architecture" module
// needs an Obj-C `.m` bridging file with `RCT_EXTERN_MODULE`, except here the
// codegen'd protocol conformance is what actually matters for TurboModule
// dispatch, not just `RCT_EXPORT_METHOD` shims. I have NOT been able to
// confirm whether:
//   (a) Swift can conform to the codegen'd `NativeNfcSpec` Obj-C protocol
//       directly (my assumption below), or whether the New Architecture
//       instead expects a C++ TurboModule subclass with a Swift class
//       injected as a delegate/implementation object (a pattern used in some
//       community Swift TurboModule templates as of RN 0.79-0.85), and
//   (b) whether the generated header name is exactly `NativeNfcSpec.h` /
//       `<ModuleName>-Swift.h` conventions hold for this repo's
//       `codegenConfig.name = "WebNfcApiSpec"` — Android's equivalent
//       (`NativeNfcSpec` Kotlin base class) was confirmed empirically by
//       actually running codegen (see NfcModule.kt's own comment to that
//       effect); no equivalent codegen run has been possible here.
// This file is therefore written as a plain Swift class implementing the
// Spec's methods with the correct signatures/types as best-understood, plus
// `@objc` annotations to make it visible to Objective-C++, and NfcModule.mm
// provides the RCT_EXTERN_MODULE-style glue. Whoever picks this up with a
// real RN 0.85 New Architecture checkout should verify against a freshly
// generated `build/generated/ios/...` codegen output for this package and
// correct this file's class declaration/protocol conformance to match
// exactly what codegen actually emits.

import Foundation
import CoreNFC
import React

// MARK: - Wire format helpers (§5b)

/// The lossless native wire format (§5b): raw TNF/type/id/payload only, no
/// Web NFC semantics (recordType/mediaType/encoding/lang interpretation is
/// entirely a JS-side concern in lib/well-known-records.ts).
struct NdefWireRecordData {
  let tnf: Int
  let type: String    // base64
  let id: String       // base64
  let payload: String  // base64
}

/// Base64 codec notes (§5b, "wire format fidelity"):
///
/// `lib/ndef-wire.ts`'s `bytesToBase64`/`base64ToBytes` are a hand-rolled
/// implementation of STANDARD base64 (RFC 4648 §4: alphabet
/// "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/",
/// '=' padding to a multiple of 4 chars, no line wrapping/CRLF insertion).
/// Foundation's `Data.base64EncodedString(options:)` with the default empty
/// `options` (i.e. NOT passing `.lineLength64Characters` or
/// `.lineLength76Characters`) produces exactly this: standard alphabet,
/// '='-padded, unwrapped. This is documented Foundation behavior, not
/// something this environment can execute to confirm — but the option flags
/// that would change it (line wrapping) are opt-in, so the default call
/// should match byte-for-byte.
///
/// Worked example, so a reviewer with a real Swift REPL can immediately
/// confirm this claim rather than trusting the paragraph above:
///
///   JS side (lib/ndef-wire.ts):
///     bytesToBase64(new TextEncoder().encode("T"))
///     // "T" = 0x54 = 0b01010100, one input byte.
///     // The loop: b0=0x54, b1=undefined, b2=undefined; chunk = 0x54 << 16 = 0x540000.
///     // result[0] = BASE64_CHARS[(0x540000 >> 18) & 0x3f] = BASE64_CHARS[0x15] = 'V'
///     // result[1] = BASE64_CHARS[(0x540000 >> 12) & 0x3f] = BASE64_CHARS[0x00] = 'A'
///     // result[2] = '=' (b1 undefined)
///     // result[3] = '=' (b2 undefined)
///     // => "VA=="
///
///   Swift side (this file, expected):
///     Data([0x54]).base64EncodedString()
///     // Standard base64 of a single 0x54 byte is documented/well-known to be "VA=="
///     // (single byte -> 2 significant base64 chars + "==" padding, matching
///     // RFC 4648's padding rule for len(input) % 3 == 1).
///
///   These two should be byte-identical: "VA==". UNVERIFIED — confirm by
///   actually running `Data([0x54]).base64EncodedString()` in a Swift
///   playground/REPL on real hardware/Xcode as one of the first §7c spike
///   steps (see docs/ios-feasibility-spike-checklist.md) before relying on
///   this in a real read/write round-trip.
enum WireCodec {
  static func encode(_ data: Data) -> String {
    // No options => standard alphabet, '=' padding, no line wrapping.
    // UNVERIFIED — see worked example above.
    return data.base64EncodedString()
  }

  static func decode(_ base64: String) -> Data {
    // Foundation's Data(base64Encoded:) requires correct '='-padding, which
    // ndef-wire.ts always produces (it pads to a multiple of 4 unless the
    // input array is empty, matching Foundation's expectations). Empty
    // string input must decode to empty Data, not fail/return nil.
    if base64.isEmpty {
      return Data()
    }
    return Data(base64Encoded: base64) ?? Data()
  }

  static func wireRecord(tnf: Int, type: Data, id: Data, payload: Data) -> NdefWireRecordData {
    NdefWireRecordData(
      tnf: tnf,
      type: encode(type),
      id: encode(id),
      payload: encode(payload)
    )
  }
}

/// Maps a Web NFC wire TNF value (lib/ndef-wire.ts's TNF constants) to
/// Core NFC's `NFCTypeNameFormat` enum. UNVERIFIED — cross-check exact
/// raw values against the actual CoreNFC.framework header before relying on
/// this; documented as of iOS 13+ CoreNFC, values believed stable:
///   .empty = 0x00, .nfcWellKnown = 0x01, .media = 0x02, .absoluteURI = 0x03,
///   .nfcExternal = 0x04, .unknown = 0x05, .unchanged = 0x06
private func tnfToCoreNFC(_ tnf: Int) -> NFCTypeNameFormat {
  switch tnf {
  case 0x00: return .empty
  case 0x01: return .nfcWellKnown
  case 0x02: return .media
  case 0x03: return .absoluteURI
  case 0x04: return .nfcExternal
  case 0x06: return .unchanged
  default: return .unknown
  }
}

private func coreNFCToTnf(_ tnf: NFCTypeNameFormat) -> Int {
  switch tnf {
  case .empty: return 0x00
  case .nfcWellKnown: return 0x01
  case .media: return 0x02
  case .absoluteURI: return 0x03
  case .nfcExternal: return 0x04
  case .unchanged: return 0x06
  case .unknown: return 0x05
  @unknown default: return 0x05
  }
}

private func payloadToWireRecord(_ payload: NFCNDEFPayload) -> NdefWireRecordData {
  WireCodec.wireRecord(
    tnf: coreNFCToTnf(payload.typeNameFormat),
    type: payload.type,
    id: payload.identifier,
    payload: payload.payload
  )
}

private func wireRecordToPayload(_ record: NdefWireRecordData) -> NFCNDEFPayload {
  NFCNDEFPayload(
    format: tnfToCoreNFC(record.tnf),
    type: WireCodec.decode(record.type),
    identifier: WireCodec.decode(record.id),
    payload: WireCodec.decode(record.payload)
  )
}

// MARK: - Launch activation queue (§12a/§12b/§12c)

struct LaunchActivation {
  let activationId: String
  let serialNumber: String?
  let records: [NdefWireRecordData]
}

/// Process-wide activation queue, mirroring Android's `NfcModule.kt`
/// companion-object `launchTagQueue` (static, because an activation can
/// arrive — via `application(_:continue:restorationHandler:)` or App Clip
/// invocation — before any TurboModule instance backing a fresh JS bridge
/// exists yet).
///
/// UNVERIFIED / open question (§7b, §12a): whether iOS NFC background-tag
/// launch actually flows through `NSUserActivity` the way
/// docs/react-native-nfc-manager/ios/NfcManager.m assumes, is itself one of
/// the §7c spike's open questions — see the long comment on
/// `AppDelegateNfcLaunchHook` below.
final class NfcLaunchActivationQueue {
  static let shared = NfcLaunchActivationQueue()
  private var queue: [LaunchActivation] = []
  private let lock = NSLock()
  private var activationSeq = 0

  /// Weak reference to the live module instance, set/cleared by
  /// NfcModule.swift's init/invalidate, so a warm-resume activation (JS
  /// already running) can additionally emit `launchTagReceived` — mirrors
  /// Android's `activeInstance` static var.
  weak var activeInstance: NfcModule?

  private init() {}

  @discardableResult
  func enqueue(serialNumber: String?, records: [NdefWireRecordData]) -> LaunchActivation {
    lock.lock()
    defer { lock.unlock() }
    activationSeq += 1
    let activation = LaunchActivation(
      activationId: "launch-\(activationSeq)-\(UUID().uuidString)",
      serialNumber: serialNumber,
      records: records
    )
    queue.append(activation)
    return activation
  }

  func poll() -> LaunchActivation? {
    lock.lock()
    defer { lock.unlock() }
    guard !queue.isEmpty else { return nil }
    return queue.removeFirst()
  }
}

/// Notifies the app-integration layer (this module's Swift code) of an
/// activation enqueued while JS may already be running, so it can emit
/// `launchTagReceived`. A cold-launch activation enqueued before the
/// TurboModule instance is constructed has no listener yet and is instead
/// picked up by `SessionCoordinator`'s own JS-side startup drain call to
/// `consumePendingLaunchTag()` (§12c) — same pattern as Android.
func nfcLaunchActivationEnqueuedWhileRunning(_ activation: LaunchActivation) {
  NfcLaunchActivationQueue.shared.activeInstance?.emitLaunchTagReceived(activationId: activation.activationId)
}

// MARK: - AppDelegate integration hook (§12a)
//
// UNVERIFIED / OPEN DESIGN QUESTION (§7b): how does an NDEF tag tap actually
// deliver into this library's host app on iOS?
//
// docs/react-native-nfc-manager/ios/NfcManager.m's approach (lines ~21-41):
// it implements `+(BOOL)application:continueUserActivity:restorationHandler:`
// and checks `userActivity.activityType == NSUserActivityTypeBrowsingWeb`,
// then reads `userActivity.ndefMessagePayload` (an `NFCNDEFMessage`,
// available iOS 12+). This is the mechanism Apple documents for "App Clip
// invoked via NFC tag" and "background NFC tag read continuation" scenarios
// where an NFC tag encodes a URL that Associated Domains / App Clip
// experience routes into the app as a universal link — i.e. the OS itself
// scanned the tag (via the system-level "background tag reading" feature
// introduced iOS 12+, which is DISTINCT from this app calling
// `NFCNDEFReaderSession`/`NFCTagReaderSession` itself) and hands the app an
// `NSUserActivity` whose `activityType` is `NSUserActivityTypeBrowsingWeb`
// because, from the OS's perspective, it's indistinguishable from any other
// universal-link launch.
//
// DECISION (flagged UNVERIFIED — confirm via §7c spike): this file follows
// nfc-manager's precedent and checks `activityType ==
// NSUserActivityTypeBrowsingWeb`, on the reasoning that:
//   1. it is the only documented, working precedent available to consult in
//      this environment (no Apple documentation fetch was performed here —
//      confirm current Apple docs during the spike too, since this API
//      surface last changed meaningfully around iOS 12-13 and this project's
//      author has not re-verified it against a current SDK);
//   2. §0 of the plan scopes "App Clip NFC tap launch" as in-scope, and
//      App Clip invocation via NFC is documented by Apple as flowing through
//      exactly this universal-link / NSUserActivity mechanism, not through
//      NFCNDEFReaderSession.
// OPEN QUESTIONS the §7c spike must answer (see
// docs/ios-feasibility-spike-checklist.md's "Launch/lifecycle spike"
// section):
//   - Does `userActivity.webpageURL` need to be inspected/matched against
//     this app's associated domain, or is `ndefMessagePayload` reliably
//     populated regardless?
//   - Is `NSUserActivityTypeBrowsingWeb` still the correct/only activityType
//     to check on current iOS versions, or has Apple introduced a more
//     specific activity type since nfc-manager's implementation was written?
//   - For a COLD launch via NFC tap (app not running), does RN's own
//     AppDelegate/RCTAppDelegate integration even give this module a chance
//     to see `application:continueUserActivity:` before RN's JS engine has
//     started, and if so how does the activation reach the TurboModule
//     instance that doesn't exist yet? (Answer intended to mirror Android's
//     "enqueue into a static queue, drain via consumePendingLaunchTag() at
//     JS startup" pattern — the queue below IS written assuming that answer
//     will hold, but this has not been confirmed against RN 0.85's actual
//     AppDelegate lifecycle on iOS.)
//   - Whether this app-level hook needs to live in the example app's own
//     AppDelegate (most likely, mirroring how nfc-manager requires host
//     apps to wire up `RCTLinkingManager`/continueUserActivity themselves)
//     rather than being fully self-contained in this library's pod — if so,
//     `example/ios/AppDelegate.swift` (not yet created — no ios/ example
//     project exists in this repo either) needs a call into
//     `NfcModule.handleContinueUserActivity(_:)` below, analogous to how
//     `RCTLinkingManager` requires host AppDelegate wiring for universal
//     links today.
//
// This function is written so an app's AppDelegate CAN call it once real
// hardware confirms the mechanism above; it is not wired into anything
// automatically since there is no ios/ Xcode project in this repo to wire
// it into.
@objc(WebNfcApiLaunchBridge)
public final class WebNfcApiLaunchBridge: NSObject {

  /// Call this from the host app's AppDelegate
  /// `application(_:continue:restorationHandler:)`. Returns true if this
  /// activity was recognized and handled as an NFC launch, false otherwise
  /// (so the host app can fall through to its own universal-link handling).
  ///
  /// UNVERIFIED — see the long design-question comment above this class.
  @available(iOS 12.0, *)
  @discardableResult
  @objc public static func handleContinueUserActivity(_ userActivity: NSUserActivity) -> Bool {
    // DECISION POINT (§7b, flagged UNVERIFIED): following
    // docs/react-native-nfc-manager/ios/NfcManager.m's precedent exactly.
    guard userActivity.activityType == NSUserActivityTypeBrowsingWeb else {
      return false
    }
    guard let ndefMessage = userActivity.ndefMessagePayload else {
      return false
    }
    let records = ndefMessage.records.map(payloadToWireRecord)
    let activation = NfcLaunchActivationQueue.shared.enqueue(serialNumber: nil, records: records)
    nfcLaunchActivationEnqueuedWhileRunning(activation)
    return true
  }
}

// MARK: - NfcModule

/// TurboModule implementation of the operation-oriented NFC Spec (§3).
///
/// Native tracks only "which operationId currently occupies the physical
/// reader" — no notion of NDEFReader instances; that multiplexing is a
/// JS-side concern owned by SessionCoordinator (§5a), exactly as documented
/// for the Android implementation.
///
/// SESSION TYPE DECISION (§7b, flagged UNVERIFIED — confirm via §7c spike):
/// this implementation uses `NFCNDEFReaderSession` (available iOS 11+, NDEF
/// read; iOS 13+ adds `.writingAvailable`/`connect(to:)`-based write via
/// `NFCNDEFTag` protocol conformance) rather than `NFCTagReaderSession`
/// (iOS 13+, lower-level, requires manually querying `NFCNDEFTag` capability
/// per detected tag). Reasoning:
///   - The Web NFC spec (§2, §3) only ever deals in NDEF messages — it has
///     no concept of tag technology below the NDEF layer (§0 "out of
///     scope"). `NFCNDEFReaderSession` is Apple's NDEF-specific session type
///     and is the narrower, more directly-matching primitive for this
///     Spec's `beginScan`/`beginWrite`/`beginMakeReadOnly` surface.
///   - `docs/react-native-nfc-manager/ios/NfcManager.m` uses
///     `NFCNDEFReaderSession` for its `registerTagEvent`/`unregisterTagEvent`
///     (NDEF scan) methods and only reaches for `NFCTagReaderSession` for
///     its `requestTechnology` API (raw MiFare/ISO15693/FeliCa/IsoDep access)
///     — which §0 of this plan explicitly places out of scope. This
///     confirms `NFCNDEFReaderSession` is the precedented choice for an
///     NDEF-only surface.
/// OPEN QUESTION the §7c spike must resolve: whether
/// `NFCNDEFReaderSession`'s write path (`connect(to:)` on a detected
/// `NFCNDEFTag`, then `queryNDEFStatus(completionHandler:)`, then
/// `writeNDEF(_:completionHandler:)`) is sufficiently reliable/full-featured
/// for this Spec's `beginWrite`/`beginMakeReadOnly` (`writeLock` for
/// read-only), or whether `NFCTagReaderSession` + manual `NFCNDEFTag`
/// protocol casting (which nfc-manager's `requestTechnology` path
/// demonstrates for non-NDEF tech, but NOT for the plain-NDEF case) turns
/// out to be necessary in practice. See
/// docs/ios-feasibility-spike-checklist.md step 3 for the literal
/// begin-session -> detect -> connect -> query -> read -> write -> lock ->
/// invalidate sequence to run against real hardware to settle this.
@objc(NfcModule)
public final class NfcModule: NSObject {

  // Bridge plumbing — UNVERIFIED, see this file's top-of-file bridging note.
  // `RCTEventEmitter`-style `sendEvent` is assumed reachable via a bridge
  // reference; the exact base class/protocol this should conform to for a
  // Swift TurboModule under RN 0.85's New Architecture (vs. old-arch
  // RCTEventEmitter subclassing) has not been confirmed. Written against the
  // NativeEventEmitter contract from src/NativeNfc.ts (addListener/
  // removeListeners + emitting named events) rather than against a
  // confirmed Swift base class.
  @objc public weak var bridge: RCTBridge?

  private var listenerCount = 0

  // --- operation state (mirrors Android NfcModule.kt's fields) --------------

  private var activeScanOperationId: String?
  private var ndefSession: NFCNDEFReaderSession?

  private struct PendingWrite {
    let operationId: String
    let records: [NdefWireRecordData]
    let overwrite: Bool
  }
  private struct PendingMakeReadOnly {
    let operationId: String
  }

  private var pendingWrite: PendingWrite?
  private var pendingMakeReadOnly: PendingMakeReadOnly?

  /// Promise resolvers/rejectors keyed by operationId, for the one-shot
  /// beginWrite/beginMakeReadOnly operations (§3's promise-resolution
  /// semantics: these resolve only once the operation fully completes).
  /// UNVERIFIED bridging types — `RCTPromiseResolveBlock`/
  /// `RCTPromiseRejectBlock` are the standard RN Objective-C block typedefs;
  /// assumed importable into Swift via the React/RCTBridgeModule.h umbrella
  /// header. Confirm during the spike.
  private var pendingResolvers: [String: RCTPromiseResolveBlock] = [:]
  private var pendingRejecters: [String: RCTPromiseRejectBlock] = [:]

  // Serializes access to the mutable state above across Core NFC's delegate
  // callback queue (dispatched on `.main` per the `initWithDelegate:queue:`
  // call below) and whatever queue TurboModule method dispatch happens on.
  // UNVERIFIED whether this is strictly necessary if both ends are pinned to
  // main — kept defensively since RN's New Architecture method dispatch
  // queue is not something this environment could confirm.
  private let stateLock = NSLock()

  public override init() {
    super.init()
    NfcLaunchActivationQueue.shared.activeInstance = self
    // §12d: app foreground/background observation. UNVERIFIED design choice
    // — see the long comment on `handleAppDidEnterBackground` below for why
    // UIApplication notifications were chosen over relying on Core NFC's own
    // invalidation callback to infer backgrounding.
    NotificationCenter.default.addObserver(
      self,
      selector: #selector(handleAppDidEnterBackground),
      name: UIApplication.didEnterBackgroundNotification,
      object: nil
    )
    NotificationCenter.default.addObserver(
      self,
      selector: #selector(handleAppDidBecomeActive),
      name: UIApplication.didBecomeActiveNotification,
      object: nil
    )
  }

  deinit {
    NotificationCenter.default.removeObserver(self)
    if NfcLaunchActivationQueue.shared.activeInstance === self {
      NfcLaunchActivationQueue.shared.activeInstance = nil
    }
  }

  // MARK: Spec: isSupported / isEnabled

  @objc public func isSupported(_ resolve: @escaping RCTPromiseResolveBlock,
                                 rejecter reject: @escaping RCTPromiseRejectBlock) {
    if #available(iOS 13.0, *) {
      resolve(NFCNDEFReaderSession.readingAvailable)
    } else {
      resolve(false)
    }
  }

  @objc public func isEnabled(_ resolve: @escaping RCTPromiseResolveBlock,
                               rejecter reject: @escaping RCTPromiseRejectBlock) {
    // §3: "iOS always true if supported" — Core NFC has no user-facing
    // radio on/off toggle the way Android's NfcAdapter does; `readingAvailable`
    // already captures "hardware + entitlement + OS capability present" so
    // isEnabled mirrors isSupported on this platform. UNVERIFIED: whether
    // there is any iOS state (e.g. Settings > NFC, if such a toggle exists
    // on some device/OS combination) this should actually reflect instead —
    // confirm no such user-facing toggle exists during the spike.
    if #available(iOS 13.0, *) {
      resolve(NFCNDEFReaderSession.readingAvailable)
    } else {
      resolve(false)
    }
  }

  // MARK: Spec: beginScan

  @objc public func beginScan(_ operationId: String,
                               options: [String: Any],
                               resolver resolve: @escaping RCTPromiseResolveBlock,
                               rejecter reject: @escaping RCTPromiseRejectBlock) {
    stateLock.lock()
    defer { stateLock.unlock() }

    guard NFCNDEFReaderSession.readingAvailable else {
      reject("NotSupportedError", "NFC NDEF reading not available on this device", nil)
      return
    }
    if ndefSession != nil || pendingWrite != nil || pendingMakeReadOnly != nil {
      // Native itself never runs two operations simultaneously (§3) —
      // SessionCoordinator is responsible for not calling beginScan while
      // something else is active, but defend here too.
      reject("InvalidStateError", "an NFC session is already active", nil)
      return
    }

    activeScanOperationId = operationId
    // UNVERIFIED: `invalidateAfterFirstRead: false` keeps the session alive
    // across multiple taps, matching this Spec's "scan stays active until
    // cancelOperation" semantics (§3) — nfc-manager's `registerTagEvent`
    // exposes this as a caller-controlled option; this Spec has no such
    // option so it is hardcoded to `false` here, which should be correct
    // for a live `scan()` subscription, but has not been exercised on
    // hardware.
    let session = NFCNDEFReaderSession(delegate: self, queue: nil, invalidateAfterFirstRead: false)
    if let alertMessage = options["alertMessage"] as? String {
      session.alertMessage = alertMessage
    }
    ndefSession = session
    session.begin()
    // §3: beginScan resolves once the session is successfully active, not
    // once a tag is found. UNVERIFIED: Core NFC has no explicit "session
    // became active" completion callback for NFCNDEFReaderSession the way
    // NFCTagReaderSessionDelegate has `tagReaderSessionDidBecomeActive` —
    // resolving immediately after `begin()` is called is this
    // implementation's best-effort interpretation; whether `begin()` can
    // synchronously fail in a way that should instead reject is one of the
    // §7c spike's open questions (see checklist step 3a).
    resolve(nil)
  }

  // MARK: Spec: beginWrite

  @objc public func beginWrite(_ operationId: String,
                                records: [[String: Any]],
                                options: [String: Any],
                                resolver resolve: @escaping RCTPromiseResolveBlock,
                                rejecter reject: @escaping RCTPromiseRejectBlock) {
    stateLock.lock()

    guard NFCNDEFReaderSession.readingAvailable else {
      stateLock.unlock()
      reject("NotSupportedError", "NFC NDEF not available on this device", nil)
      return
    }

    let overwrite = (options["overwrite"] as? Bool) ?? true
    let wireRecords = records.compactMap { dict -> NdefWireRecordData? in
      guard let tnf = dict["tnf"] as? Int,
            let type = dict["type"] as? String,
            let id = dict["id"] as? String,
            let payload = dict["payload"] as? String else { return nil }
      return NdefWireRecordData(tnf: tnf, type: type, id: id, payload: payload)
    }

    // §5a: a second write/makeReadOnly replaces (rather than rejecting) an
    // in-flight one — but per §3, that REPLACEMENT policy is
    // SessionCoordinator's job on the JS side (it aborts the previous
    // operation's promise itself before this native call is even made for
    // the new one). Native's own state here should never actually observe
    // an overlapping beginWrite call from a well-behaved coordinator; this
    // guard exists defensively, mirroring Android's approach of just
    // tracking one `pendingWrite` slot at a time.
    pendingWrite = PendingWrite(operationId: operationId, records: wireRecords, overwrite: overwrite)
    pendingResolvers[operationId] = resolve
    pendingRejecters[operationId] = reject

    if ndefSession == nil {
      let session = NFCNDEFReaderSession(delegate: self, queue: nil, invalidateAfterFirstRead: false)
      if let alertMessage = options["alertMessage"] as? String {
        session.alertMessage = alertMessage
      }
      ndefSession = session
      session.begin()
    }
    // If a scan session is already active (activeScanOperationId != nil),
    // §5a's suspend/resume policy means SessionCoordinator should have
    // already cancelled it before calling beginWrite — so ndefSession
    // being non-nil here should only happen transiently. UNVERIFIED: Core
    // NFC does not obviously support "redirecting" an already-active
    // session's purpose (scan vs write) without invalidating and
    // recreating it; this implementation does NOT currently handle that
    // transition explicitly and may need a session-recreate step here once
    // real hardware behavior is observed (§7c spike checklist step 4).
    stateLock.unlock()
  }

  // MARK: Spec: beginMakeReadOnly

  @objc public func beginMakeReadOnly(_ operationId: String,
                                       options: [String: Any],
                                       resolver resolve: @escaping RCTPromiseResolveBlock,
                                       rejecter reject: @escaping RCTPromiseRejectBlock) {
    stateLock.lock()

    guard NFCNDEFReaderSession.readingAvailable else {
      stateLock.unlock()
      reject("NotSupportedError", "NFC NDEF not available on this device", nil)
      return
    }

    pendingMakeReadOnly = PendingMakeReadOnly(operationId: operationId)
    pendingResolvers[operationId] = resolve
    pendingRejecters[operationId] = reject

    if ndefSession == nil {
      let session = NFCNDEFReaderSession(delegate: self, queue: nil, invalidateAfterFirstRead: false)
      if let alertMessage = options["alertMessage"] as? String {
        session.alertMessage = alertMessage
      }
      ndefSession = session
      session.begin()
    }
    stateLock.unlock()
  }

  // MARK: Spec: cancelOperation

  @objc public func cancelOperation(_ operationId: String,
                                     resolver resolve: @escaping RCTPromiseResolveBlock,
                                     rejecter reject: @escaping RCTPromiseRejectBlock) {
    stateLock.lock()

    var handled = false

    if activeScanOperationId == operationId {
      activeScanOperationId = nil
      handled = true
    }
    if pendingWrite?.operationId == operationId {
      pendingWrite = nil
      pendingRejecters.removeValue(forKey: operationId)
      pendingResolvers.removeValue(forKey: operationId)
      handled = true
    }
    if pendingMakeReadOnly?.operationId == operationId {
      pendingMakeReadOnly = nil
      pendingRejecters.removeValue(forKey: operationId)
      pendingResolvers.removeValue(forKey: operationId)
      handled = true
    }

    if activeScanOperationId == nil && pendingWrite == nil && pendingMakeReadOnly == nil {
      // No operations remain — invalidate the session. UNVERIFIED: whether
      // `invalidateSession()` synchronously fires `didInvalidateWithError`
      // or defers it (affecting whether `operationEnded{reason:'cancelled'}`
      // below and the delegate's own invalidation-driven cleanup race) is
      // exactly the kind of ordering question the §7c spike must observe.
      ndefSession?.invalidate()
      ndefSession = nil
    }

    stateLock.unlock()

    // cancelOperation is idempotent (§3) — always emit operationEnded, even
    // for an unknown/already-finished operationId, mirroring Android.
    emitEvent("operationEnded", body: ["operationId": operationId, "reason": "cancelled"])
    if !handled {
      NSLog("[NfcModule] cancelOperation(\(operationId)) — no matching active operation (idempotent no-op)")
    }
    resolve(nil)
  }

  // MARK: Spec: consumePendingLaunchTag

  @objc public func consumePendingLaunchTag(_ resolve: @escaping RCTPromiseResolveBlock,
                                             rejecter reject: @escaping RCTPromiseRejectBlock) {
    guard let activation = NfcLaunchActivationQueue.shared.poll() else {
      resolve(NSNull())
      return
    }
    var result: [String: Any] = [
      "activationId": activation.activationId,
      "records": activation.records.map { rec -> [String: Any] in
        ["tnf": rec.tnf, "type": rec.type, "id": rec.id, "payload": rec.payload]
      },
    ]
    if let serialNumber = activation.serialNumber {
      result["serialNumber"] = serialNumber
    }
    resolve(result)
  }

  // MARK: addListener / removeListeners (NativeEventEmitter plumbing)

  @objc public func addListener(_ eventName: String) {
    listenerCount += 1
  }

  @objc public func removeListeners(_ count: Double) {
    listenerCount = max(0, listenerCount - Int(count))
  }

  func emitLaunchTagReceived(activationId: String) {
    emitEvent("launchTagReceived", body: ["activationId": activationId])
  }

  /// UNVERIFIED bridging: assumes `self.bridge.eventDispatcher()` (old-arch
  /// pattern) or an equivalent New Architecture event-emission path is
  /// reachable from a plain NSObject-based TurboModule. This is one of the
  /// least certain parts of this file — RN's New Architecture typically
  /// wants event-emitting TurboModules to subclass a specific base
  /// (`RCTEventEmitter` in old arch; the New Architecture story for a Swift
  /// TurboModule emitting events without going through the old
  /// RCTEventEmitter bridge is genuinely unclear to the author of this file
  /// without a real RN 0.85 checkout to inspect). Confirm and likely REWRITE
  /// this method during the §7c spike.
  private func emitEvent(_ name: String, body: [String: Any]) {
    // Placeholder: intentionally not a confident implementation. See
    // doc-comment above. A real implementation likely needs this class to
    // either subclass RCTEventEmitter (if New Architecture still supports
    // that for Swift) or hold a reference to the module's generated
    // `EventEmitter` C++ callback via the TurboModule's `installJSIBindings`
    // hookup, per RN 0.85's actual Swift TurboModule + events template.
    NSLog("[NfcModule] emitEvent(\(name), \(body)) — UNVERIFIED event bridging, see comment")
  }

  // MARK: §12d — backgrounding detection
  //
  // OPEN DESIGN QUESTION (§7b/§12d, UNVERIFIED): does Core NFC report
  // backgrounding to the app BEFORE invalidating an active
  // NFCNDEFReaderSession, or does the OS simply invalidate the session
  // silently as part of suspending the app, with `didInvalidateWithError`
  // arriving with some generic "session invalidated" error that is
  // indistinguishable from a user-cancelled session (tapping "Done" on the
  // system NFC sheet) without ALSO observing app-lifecycle notifications?
  //
  // DECISION (flagged UNVERIFIED): this implementation observes
  // `UIApplication.didEnterBackgroundNotification`/
  // `didBecomeActiveNotification` directly (via NotificationCenter) as the
  // source of truth for `appStateChanged` — mirroring Android's
  // `LifecycleEventListener.onHostPause`/`onHostResume` — rather than trying
  // to infer backgrounding from `NFCNDEFReaderSessionDelegate`'s
  // `didInvalidateWithError:` error code/domain. Rationale: the Spec (§3)
  // treats `appStateChanged` and `operationEnded{reason:'cancelled'}` as two
  // independent signals (SessionCoordinator, not native, reconciles them,
  // §5a/§12d) — so it is *fine*, and arguably required by the Spec's own
  // design, for native to just report "app went to background" via one
  // channel and "the session ended, here's why (if I know)" via another,
  // rather than trying to unify them into a single native-side "backgrounded
  // cancellation" concept. This sidesteps needing to know the exact
  // NSError domain/code Core NFC uses for an OS-initiated background
  // invalidation.
  //
  // REMAINING OPEN QUESTIONS for the §7c spike (see
  // docs/ios-feasibility-spike-checklist.md "backgrounding" section):
  //   - Does backgrounding actually invalidate the session at all, or does
  //     it stay alive (e.g. if the OS grants some background NFC grace
  //     period)? If the session survives backgrounding, does a subsequent
  //     tag tap while backgrounded still deliver a `didDetectNDEFs`
  //     callback, or is scanning hardware-paused while backgrounded?
  //   - What is the actual timing/ordering of
  //     `didEnterBackgroundNotification` versus any resulting
  //     `didInvalidateWithError:` call, if the latter happens at all?
  //   - Should `beginScan`'s own error-handling path additionally treat a
  //     `didInvalidateWithError` whose `NFCReaderError` code is
  //     `.readerSessionInvalidationErrorSessionTimeout` or similar
  //     differently from a generic error, for `operationEnded`'s
  //     `reason: 'timeout'` vs `'error'` distinction (§3)? This mapping is
  //     NOT implemented with confidence below — see the delegate's
  //     `didInvalidateWithError` implementation for the current
  //     best-effort/placeholder mapping.

  @objc private func handleAppDidEnterBackground() {
    emitEvent("appStateChanged", body: ["state": "background"])
  }

  @objc private func handleAppDidBecomeActive() {
    emitEvent("appStateChanged", body: ["state": "foreground"])
  }
}

// MARK: - NFCNDEFReaderSessionDelegate

extension NfcModule: NFCNDEFReaderSessionDelegate {

  // UNVERIFIED exact delegate method signature: CoreNFC's
  // NFCNDEFReaderSessionDelegate has changed shape across iOS SDK versions
  // (iOS 11's original single `didDetectNDEFs:` vs. iOS 13's additional
  // per-tag `didDetectTags:`/`connect(to:)`-based methods on the same
  // delegate protocol for write support). This implementation targets the
  // iOS 13+ tag-based delegate methods (needed for write/lock support,
  // per the session-type decision above) — confirm the exact selector
  // names/argument types against the CoreNFC.framework header for the
  // actual deployment target SDK during the spike; the names below are
  // written from documented/precedented shape (nfc-manager's iOS 11-era
  // `didDetectNDEFs:` plus the iOS 13 tag-based additions), not confirmed
  // against a current Xcode's CoreNFC module.

  public func readerSession(_ session: NFCNDEFReaderSession, didDetectNDEFs messages: [NFCNDEFMessage]) {
    // iOS 11-era callback: delivered when the session isn't using the
    // iOS13+ per-tag connect flow. Kept for broad-compatibility read-only
    // scanning; the write path below requires the tag-based delegate
    // methods instead. UNVERIFIED whether both callback styles can be
    // relied on simultaneously on one delegate/session instance, or whether
    // implementing `didDetectTags:` suppresses this one entirely on iOS 13+
    // (documented CoreNFC behavor, not confirmed here).
    guard let operationId = activeScanOperationId else { return }
    let records = messages.first?.records.map(payloadToWireRecord) ?? []
    emitEvent("tagDiscovered", body: [
      "operationId": operationId,
      "serialNumber": "", // iOS 11 callback path exposes no tag UID directly.
      "records": records.map { ["tnf": $0.tnf, "type": $0.type, "id": $0.id, "payload": $0.payload] },
    ])
  }

  @available(iOS 13.0, *)
  public func readerSession(_ session: NFCNDEFReaderSession, didDetectTags tags: [NFCNDEFTag]) {
    guard let tag = tags.first else { return }

    stateLock.lock()
    let write = pendingWrite
    let makeReadOnly = pendingMakeReadOnly
    let scanOperationId = activeScanOperationId
    stateLock.unlock()

    session.connect(to: tag) { [weak self] error in
      guard let self = self else { return }
      if let error = error {
        session.restartPolling()
        NSLog("[NfcModule] connect(to:) failed, restarting polling: \(error)")
        return
      }

      if let write = write {
        self.serviceWrite(session: session, tag: tag, write: write)
      } else if let makeReadOnly = makeReadOnly {
        self.serviceMakeReadOnly(session: session, tag: tag, makeReadOnly: makeReadOnly)
      } else if let scanOperationId = scanOperationId {
        self.serviceScanRead(session: session, tag: tag, operationId: scanOperationId)
      }
    }
  }

  @available(iOS 13.0, *)
  private func serviceScanRead(session: NFCNDEFReaderSession, tag: NFCNDEFTag, operationId: String) {
    tag.queryNDEFStatus { [weak self] status, _, error in
      guard let self = self else { return }
      if let error = error {
        self.emitEvent("operationEnded", body: [
          "operationId": operationId, "reason": "error",
          "message": "queryNDEFStatus failed: \(error.localizedDescription)",
        ])
        session.restartPolling()
        return
      }
      guard status != .notSupported else {
        self.emitEvent("operationEnded", body: [
          "operationId": operationId, "reason": "error", "message": "tag does not support NDEF",
        ])
        session.restartPolling()
        return
      }
      tag.readNDEF { [weak self] message, error in
        guard let self = self else { return }
        if let error = error {
          self.emitEvent("operationEnded", body: [
            "operationId": operationId, "reason": "error",
            "message": "readNDEF failed: \(error.localizedDescription)",
          ])
          session.restartPolling()
          return
        }
        let records = message?.records.map(payloadToWireRecord) ?? []
        // UNVERIFIED: NFCNDEFTag has no directly-exposed "serial number"
        // property in the base protocol (unlike NFCISO7816Tag.identifier
        // etc. on the more specific tag-technology protocols nfc-manager
        // uses for its raw-tech APIs, out of scope here per §0). Left empty
        // pending confirmation of whether any NDEF-only API surface exposes
        // a UID — see checklist step 3.
        self.emitEvent("tagDiscovered", body: [
          "operationId": operationId,
          "serialNumber": "",
          "records": records.map { ["tnf": $0.tnf, "type": $0.type, "id": $0.id, "payload": $0.payload] },
        ])
        session.restartPolling()
      }
    }
  }

  @available(iOS 13.0, *)
  private func serviceWrite(session: NFCNDEFReaderSession, tag: NFCNDEFTag, write: NfcModule.PendingWrite) {
    tag.queryNDEFStatus { [weak self] status, _, error in
      guard let self = self else { return }
      let resolve = self.pendingResolvers.removeValue(forKey: write.operationId)
      let reject = self.pendingRejecters.removeValue(forKey: write.operationId)
      self.stateLock.lock(); self.pendingWrite = nil; self.stateLock.unlock()

      if let error = error {
        reject?("NotReadableError", "queryNDEFStatus failed: \(error.localizedDescription)", error)
        self.emitEvent("operationEnded", body: ["operationId": write.operationId, "reason": "error", "message": error.localizedDescription])
        session.invalidate()
        return
      }
      if status == .readOnly {
        reject?("NotAllowedError", "tag is read-only", nil)
        self.emitEvent("operationEnded", body: ["operationId": write.operationId, "reason": "error", "message": "tag is read-only"])
        session.invalidate()
        return
      }
      if status == .notSupported {
        reject?("NotSupportedError", "tag does not support NDEF", nil)
        self.emitEvent("operationEnded", body: ["operationId": write.operationId, "reason": "error", "message": "tag does not support NDEF"])
        session.invalidate()
        return
      }
      if !write.overwrite && status == .readWrite {
        // §5d/§8: overwrite:false on a tag with existing records ->
        // NotAllowedError. UNVERIFIED: `queryNDEFStatus`'s three-way status
        // (.notSupported/.readOnly/.readWrite) doesn't directly tell us
        // whether the tag ALREADY HAS records — it must be read first to
        // know that (mirrors Android's own `ndef.cachedNdefMessage` check).
        // Read-before-write is not implemented in this draft; flagged for
        // the spike to fill in.
        NSLog("[NfcModule] overwrite:false check against existing content is NOT implemented — needs read-before-write, see comment")
      }

      let ndefMessage = NFCNDEFMessage(records: write.records.map(wireRecordToPayload))
      tag.writeNDEF(ndefMessage) { error in
        if let error = error {
          reject?("NetworkError", error.localizedDescription, error)
          self.emitEvent("operationEnded", body: ["operationId": write.operationId, "reason": "error", "message": error.localizedDescription])
        } else {
          resolve?(nil)
          self.emitEvent("operationEnded", body: ["operationId": write.operationId, "reason": "success"])
        }
        session.invalidate()
      }
    }
  }

  @available(iOS 13.0, *)
  private func serviceMakeReadOnly(session: NFCNDEFReaderSession, tag: NFCNDEFTag, makeReadOnly: NfcModule.PendingMakeReadOnly) {
    let resolve = pendingResolvers.removeValue(forKey: makeReadOnly.operationId)
    let reject = pendingRejecters.removeValue(forKey: makeReadOnly.operationId)
    stateLock.lock(); pendingMakeReadOnly = nil; stateLock.unlock()

    // §6e: makeReadOnly() on an already-read-only tag resolves as a no-op.
    // UNVERIFIED: whether Core NFC's `writeLock` itself already tolerates
    // being called on an already-locked tag (returning success) the way
    // Android's `Ndef.makeReadOnly()` does, or whether it errors and this
    // implementation needs an explicit `queryNDEFStatus` pre-check for
    // `.readOnly` to short-circuit to success — not confirmed here.
    tag.writeLock { error in
      if let error = error {
        reject?("NetworkError", error.localizedDescription, error)
        self.emitEvent("operationEnded", body: ["operationId": makeReadOnly.operationId, "reason": "error", "message": error.localizedDescription])
      } else {
        resolve?(nil)
        self.emitEvent("operationEnded", body: ["operationId": makeReadOnly.operationId, "reason": "success"])
      }
      session.invalidate()
    }
  }

  public func readerSession(_ session: NFCNDEFReaderSession, didInvalidateWithError error: Error) {
    stateLock.lock()
    let scanOperationId = activeScanOperationId
    activeScanOperationId = nil
    if ndefSession === session {
      ndefSession = nil
    }
    stateLock.unlock()

    // UNVERIFIED reason mapping: §3's operationEnded reasons are
    // 'cancelled'|'timeout'|'error'|'success'. Core NFC surfaces
    // invalidation causes via `NFCReaderError` codes (e.g.
    // `.readerSessionInvalidationErrorUserCanceled`,
    // `.readerSessionInvalidationErrorSessionTimeout`,
    // `.readerSessionInvalidationErrorSessionTerminatedUnexpectedly`) — this
    // draft does not attempt to branch on them and reports a blanket
    // 'error' for any scan-session invalidation not already handled by a
    // cancelOperation() call (which emits its own 'cancelled' event and
    // clears activeScanOperationId before this delegate method would even
    // see a stale id). Mapping NFCReaderError codes to the Spec's reason
    // enum precisely is left for the §7c spike/follow-up — see checklist.
    if let scanOperationId = scanOperationId {
      emitEvent("operationEnded", body: [
        "operationId": scanOperationId, "reason": "error",
        "message": error.localizedDescription,
      ])
    }
  }
}
