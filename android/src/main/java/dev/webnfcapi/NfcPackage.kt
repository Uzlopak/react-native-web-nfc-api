package dev.webnfcapi

import com.facebook.react.BaseReactPackage
import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.model.ReactModuleInfo
import com.facebook.react.module.model.ReactModuleInfoProvider

// `implements ReactPackage` is redundant (BaseReactPackage already implements
// it) but lets the React Native CLI's autolinking detect this package class —
// its matcher only recognizes `implements ReactPackage` / `extends TurboReactPackage`.
class NfcPackage : BaseReactPackage(), ReactPackage {

  override fun getModule(name: String, reactContext: ReactApplicationContext): NativeModule? =
    if (name == NfcModule.NAME) NfcModule(reactContext) else null

  override fun getReactModuleInfoProvider(): ReactModuleInfoProvider {
    return ReactModuleInfoProvider {
      mapOf(
        NfcModule.NAME to ReactModuleInfo(
          NfcModule.NAME,
          NfcModule.NAME,
          false, // canOverrideExistingModule
          false, // needsEagerInit
          false, // isCxxModule
          true, // isTurboModule
        )
      )
    }
  }
}
