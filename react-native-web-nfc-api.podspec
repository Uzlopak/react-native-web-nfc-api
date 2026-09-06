require "json"

package = JSON.parse(File.read(File.join(__dir__, "package.json")))

# NOTE (unverified — confirm via §7c spike, see also ios/NfcModule.swift's own
# top-of-file note): this podspec follows the current standard shape for an
# RN 0.85 New Architecture TurboModule authored in Swift, as documented for
# `react-native-builder-bob`/community TurboModule templates around this RN
# version. The `install_modules_dependencies` helper and its exact invocation
# (including whether `:SwiftAppFramework` or no second argument is correct
# for a *library* pod, as opposed to an application's Podfile) have not been
# verified against a real `pod install` in this workspace — there is no Mac
# available here. Treat every line below as "best current understanding,
# written per the RN 0.85 New Architecture docs as of this plan," not as
# something that has actually been run through CocoaPods.
Pod::Spec.new do |s|
  s.name         = "react-native-web-nfc-api"
  s.version      = package["version"]
  s.summary      = package["description"]
  s.homepage     = "https://github.com/uzlopak/react-native-web-nfc-api"
  s.license      = package["license"]
  s.authors      = package["author"]
  s.platforms    = { :ios => "15.1" } # RN 0.85's current floor per RN release notes (unverified in this environment — confirm against the exact RN 0.85.3 template's `Podfile`/`minIosVersion` before shipping — see §7c note above).
  s.source       = { :git => "https://github.com/uzlopak/react-native-web-nfc-api.git", :tag => "#{s.version}" }

  s.source_files = "ios/**/*.{h,m,mm,swift}"

  # Swift/ObjC++ interop (§ bridging note in ios/NfcModule.swift): DEFINES_MODULE
  # is required so the generated -Swift.h header is importable from the .mm
  # shim; SWIFT_VERSION pins the Swift dialect used to compile NfcModule.swift.
  # unverified — confirm the exact xcconfig keys expected by RN 0.85 codegen
  # against a real Xcode build; this mirrors the shape used by other
  # community Swift TurboModules as of RN 0.79-0.85, but this repo has not
  # built it.
  s.pod_target_xcconfig = {
    "DEFINES_MODULE" => "YES",
    "SWIFT_VERSION" => "5.0",
    "CLANG_ENABLE_MODULES" => "YES",
  }

  s.dependency "React-Core"

  # install_modules_dependencies wires up the New Architecture / TurboModule
  # codegen dependencies (ReactCodegen, React-RCTFabric, etc.) that RN's own
  # `react_native_pods.rb` helper expects every TurboModule-providing pod to
  # call. UNVERIFIED — confirm via §7c spike / an actual `pod install` run
  # whether this is still the current invocation for RN 0.85, and whether a
  # Swift-only library pod (no Fabric view components) needs the
  # `:SwiftAppFramework` flavor argument at all or should omit it.
  if respond_to?(:install_modules_dependencies, true)
    install_modules_dependencies(s)
  end
end
