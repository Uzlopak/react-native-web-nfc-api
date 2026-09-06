// ios/NfcModule.h
//
// UNVERIFIED bridging shim header. See the long bridging-note comment at the
// top of ios/NfcModule.swift for the full explanation of what is and isn't
// confirmed about this approach. No Mac/Xcode/iPhone was available to
// compile or verify any of this against a real RN 0.85 New Architecture
// codegen output.
//
// Intent: expose the codegen-generated `NativeNfcSpec` Objective-C protocol
// (produced from src/NativeNfc.ts by react-native-codegen, the same way
// Android's `NativeNfcSpec` Kotlin base class is codegen-produced) as
// something `ios/NfcModule.mm` can reference when registering the Swift
// `NfcModule` class with the TurboModule system.
//
// This header intentionally does NOT redeclare the Spec's method signatures
// — the actual generated protocol (expected under a path resembling
// `build/generated/ios/FBReactNativeSpec/FBReactNativeSpecJSI.h` or a
// per-module generated header, depending on codegen configuration) is the
// authoritative source once this package is actually built inside a host
// app with New Architecture codegen enabled. Redeclaring guessed signatures
// here would risk silently diverging from whatever codegen actually emits.
#import <Foundation/Foundation.h>
#import <React/RCTBridgeModule.h>

NS_ASSUME_NONNULL_BEGIN

/// Forward-declares the Swift `NfcModule` class (via the generated
/// `<ModuleName>-Swift.h` header, imported in the .mm file) as an
/// Objective-C-visible symbol. No members declared here — this header exists
/// only so NfcModule.mm has something concrete to `#import` if a project
/// setup wants a stable header for autolinking to reference; the actual
/// registration is done via `RCT_EXTERN_MODULE`-style glue in NfcModule.mm.
@interface NfcModuleObjCShimMarker : NSObject
@end

NS_ASSUME_NONNULL_END
