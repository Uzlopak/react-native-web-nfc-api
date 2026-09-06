// ios/NfcModule.mm
//
// UNVERIFIED Objective-C++ bridging shim. See ios/NfcModule.swift's top-of-file
// comment for the full explanation of what is uncertain here. This file has
// not been compiled — there is no Mac/Xcode/iPhone in this environment.
//
// Purpose: register the Swift `NfcModule` class (ios/NfcModule.swift) as the
// TurboModule backing the JS name "NativeNfc" (src/NativeNfc.ts:
// `TurboModuleRegistry.get<Spec>('NativeNfc')`), mirroring what
// `NfcPackage.kt`'s `ReactModuleInfo(NfcModule.NAME, ...)` does on Android
// (NfcModule.NAME = "NativeNfc").
//
// BEST-UNDERSTOOD APPROACH (flagged UNVERIFIED, see ios/NfcModule.swift's
// header comment for the full caveat): for a plain Objective-C/old-style
// bridge module, this would simply be:
//
//   #import <React/RCTBridgeModule.h>
//   #import "WebNfcApi-Swift.h"   // auto-generated header exposing @objc Swift symbols
//
//   @interface RCT_EXTERN_REMAP_MODULE(NativeNfc, NfcModule, NSObject)
//   RCT_EXTERN_METHOD(isSupported:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)
//   ... one RCT_EXTERN_METHOD per Spec method ...
//   @end
//
// However, under the New Architecture (TurboModules + codegen), the
// generated `NativeNfcSpec` protocol/`ObjCTurboModule` wrapper is supposed to
// take over dispatch instead of relying on `RCT_EXTERN_METHOD`'s old-bridge
// reflection mechanism, and modules are expected to be looked up via
// `RCTTurboModuleManagerDelegate`'s `getModuleClassFromName:` /
// `getTurboModule:` hooks (typically implemented in the host app's/example
// app's own `AppDelegate`, e.g. via `RCTAppDelegate`'s
// `-extraModulesForBridge:`/`-turboModuleProviderForRequestingTurboModule:`
// overrides on RN 0.85). Whether `RCT_EXTERN_REMAP_MODULE` is even necessary
// or correct for a New-Architecture-only Swift TurboModule (this package
// declares "New Architecture only. No old bridge fallback." per
// IMPLEMENTATION_PLAN.md §0), or whether the class name + `RCT_EXPORT_MODULE`
// convention alone is sufficient for it to be discovered by codegen's own
// generated provider, is NOT confirmed here.
//
// This file therefore takes the conservative, most-likely-correct-looking
// approach: use `RCT_EXTERN_REMAP_MODULE` to make the Swift class discoverable
// under the JS name "NativeNfc" for autolinking, while explicitly flagging
// that the New Architecture codegen wiring (the generated
// `NativeNfcSpecJSI.h`/`NativeNfcSpec` protocol conformance check at compile
// time) has not been exercised and may require additional glue this
// environment could not produce with confidence. A real build's compiler
// errors (if this Swift class doesn't fully satisfy the generated protocol)
// are the fastest way to close this gap — see
// docs/ios-feasibility-spike-checklist.md step 1 for "get this package to
// compile inside a throwaway host app" as the very first spike action, before
// even touching real NFC hardware.

#import <React/RCTBridgeModule.h>
#import "NfcModule.h"

// UNVERIFIED: the exact generated Swift-interop header name follows the
// pattern "<ProductModuleName>-Swift.h" where ProductModuleName is normally
// the pod/target name with non-alphanumeric characters stripped — for this
// package's pod name "react-native-web-nfc-api" that would plausibly be
// "react_native_web_nfc_api-Swift.h", but the exact name is determined by
// Xcode's build settings (PRODUCT_MODULE_NAME) at build time, not by this
// source file, and could not be confirmed without a real build. If this
// import fails, search the derived-data build products for the actual
// generated header name and correct this line.
#if __has_include("react_native_web_nfc_api-Swift.h")
#import "react_native_web_nfc_api-Swift.h"
#elif __has_include("WebNfcApi-Swift.h")
#import "WebNfcApi-Swift.h"
#endif

@interface RCT_EXTERN_REMAP_MODULE(NativeNfc, NfcModule, NSObject)

RCT_EXTERN_METHOD(isSupported:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(isEnabled:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(beginScan:(NSString *)operationId
                  options:(NSDictionary *)options
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(beginWrite:(NSString *)operationId
                  records:(NSArray *)records
                  options:(NSDictionary *)options
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(beginMakeReadOnly:(NSString *)operationId
                  options:(NSDictionary *)options
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(cancelOperation:(NSString *)operationId
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(consumePendingLaunchTag:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(addListener:(NSString *)eventName)
RCT_EXTERN_METHOD(removeListeners:(double)count)

@end

@implementation NfcModuleObjCShimMarker
@end
