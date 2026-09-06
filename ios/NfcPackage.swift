// ios/NfcPackage.swift
//
// UNVERIFIED module-registration entry point. See ios/NfcModule.swift and
// ios/NfcModule.mm's top-of-file comments for the full bridging caveats —
// nothing here has been compiled.
//
// Android's parallel file is NfcPackage.kt (BaseReactPackage /
// ReactModuleInfoProvider). iOS's TurboModule discovery mechanism is
// different in shape: there is no single "Package" object that gets listed
// somewhere the way `MainApplication.getPackages()` lists `NfcPackage()` on
// Android. Instead, iOS module discovery under the New Architecture goes
// through:
//   1. CocoaPods autolinking finding this pod via its .podspec and adding
//      its `ios/**/*.{h,m,mm,swift}` sources to the app target's build.
//   2. `RCT_EXTERN_REMAP_MODULE`/`RCT_EXPORT_MODULE`-style macros (see
//      ios/NfcModule.mm) making the class discoverable by name at runtime
//      via the Objective-C runtime + RN's own module registry scan.
//   3. (New Architecture specific, UNVERIFIED) the host app's
//      `RCTTurboModuleManagerDelegate` conformance — typically
//      `RCTAppDelegate` on RN 0.85 templates — needing to know how to
//      instantiate this module when JS calls
//      `TurboModuleRegistry.get<Spec>('NativeNfc')`. Whether this happens
//      automatically via the same Objective-C runtime discovery as (2), or
//      whether it requires an explicit codegen-generated provider entry
//      (typically auto-generated into `RCTThirdPartyComponentsProvider`/an
//      equivalent generated Swift/ObjC file during `pod install` when this
//      package's podspec + codegenConfig are correctly wired), is NOT
//      confirmed in this environment.
//
// This file exists mainly to give the "there is an equivalent of
// NfcPackage.kt" requirement in the task a concrete home, and to document
// the above uncertainty at the exact point someone integrating this library
// will look for it. If RN 0.85's actual New Architecture autolinking
// requires an explicit package/provider object (the way some earlier RN
// Fabric-era third-party libraries needed a
// `RCTThirdPartyFabricComponentsProvider` entry), add it here once the
// exact requirement is confirmed by the §7c spike (see
// docs/ios-feasibility-spike-checklist.md step 1).

import Foundation

/// Marker type documenting this module's registration story. Currently
/// empty because — per the comment above — iOS/New-Architecture module
/// registration is believed to be driven by Objective-C runtime discovery
/// (via NfcModule.mm's `RCT_EXTERN_REMAP_MODULE(NativeNfc, NfcModule, ...)`)
/// plus CocoaPods autolinking, not by an explicit package object analogous
/// to Android's `NfcPackage`. UNVERIFIED — confirm no additional explicit
/// registration step is required once this package is actually integrated
/// into a real RN 0.85 New Architecture host app.
@objc(WebNfcApiPackage)
public final class NfcPackage: NSObject {
}
