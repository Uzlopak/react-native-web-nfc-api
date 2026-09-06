# iOS project stub

No Xcode project is checked in here — an `.xcodeproj`/`.xcworkspace` is a
directory of Xcode-specific project files that aren't meaningfully hand-
authored or reviewed as plain text, and generating one requires CocoaPods /
Xcode tooling this sandbox doesn't have. Per this build step's scope ("full
native project generation is out of scope"), this directory is left as a
placeholder with instructions instead of a stub project.

To generate the real project:

```sh
npx @react-native-community/cli init WebNfcApiExample --skip-install
# then replace its ios/ directory with this one's contents merged in, or:
cd example
npx pod-install ios
```

Then, per `IMPLEMENTATION_PLAN.md` §12a and this repo's `README.md`:

- Add the `com.apple.developer.nfc.readersession.formats` entitlement.
- Add an `NFCReaderUsageDescription` entry to `Info.plist` (drives the
  system NFC permission prompt automatically on session start — see
  README.md's permission-model section).
- For background tag reading / App Clip launch delivery, confirm
  `application(_:continue:restorationHandler:)` /
  `NSUserActivity.ndefMessagePayload` wiring as described in §12a — this is
  still marked TBD pending the iOS feasibility spike (§7c), not yet
  implemented in this library's native code.
