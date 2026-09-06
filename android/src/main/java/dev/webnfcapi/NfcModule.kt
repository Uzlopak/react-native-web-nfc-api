package dev.webnfcapi

import android.app.Activity
import android.content.Intent
import android.content.IntentFilter
import android.nfc.NdefMessage
import android.nfc.NdefRecord
import android.nfc.NfcAdapter
import android.nfc.Tag
import android.nfc.tech.Ndef
import android.os.Build
import android.os.Bundle
import android.os.Parcelable
import android.util.Base64
import android.util.Log
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.LifecycleEventListener
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.WritableArray
import com.facebook.react.bridge.WritableMap
import com.facebook.react.modules.core.DeviceEventManagerModule
import java.util.UUID
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.atomic.AtomicInteger

/** The lossless native wire format (§5b): raw TNF/type/id/payload only, no semantics. */
internal data class NdefWireRecordData(
  val tnf: Int,
  val type: String,
  val id: String,
  val payload: String,
)

internal data class LaunchActivation(
  val activationId: String,
  val serialNumber: String?,
  val records: List<NdefWireRecordData>,
)

// --- wire codec helpers (§5b): top-level so both NfcModule's instance code
// and its companion object (which enqueues launch activations before any
// instance may exist) can use them. android.util.Base64.NO_WRAP produces
// standard-alphabet base64 with '=' padding and no line breaks — byte-
// identical to lib/ndef-wire.ts's own hand-rolled bytesToBase64/base64ToBytes
// (verified by inspection: both use the same 64-char alphabet, same padding
// rule, same absence of line wrapping).

internal fun NdefRecord.toWireRecord(): NdefWireRecordData = NdefWireRecordData(
  tnf = this.tnf.toInt(),
  type = Base64.encodeToString(this.type ?: ByteArray(0), Base64.NO_WRAP),
  id = Base64.encodeToString(this.id ?: ByteArray(0), Base64.NO_WRAP),
  payload = Base64.encodeToString(this.payload ?: ByteArray(0), Base64.NO_WRAP),
)

internal fun NdefWireRecordData.toAndroidNdefRecord(): NdefRecord = NdefRecord(
  this.tnf.toShort(),
  Base64.decode(this.type, Base64.NO_WRAP),
  Base64.decode(this.id, Base64.NO_WRAP),
  Base64.decode(this.payload, Base64.NO_WRAP),
)

/**
 * Convert a raw NFC tag UID byte array to the lowercase hex string the JS
 * side consumes. Extracted as a top-level helper so the byte-to-hex mapping
 * — used both by onTagDiscoveredForScan (live scans) and enqueueActivation
 * (cold-launch tags) — can be exercised from a plain JVM unit test without
 * pulling in android.nfc.Tag / Intent via Robolectric. Returns null for
 * null/empty so callers can use it directly inside `?.` chains.
 *
 * Used by:
 *  - enqueueActivation() (regression: finding #3, launch-tag serial extraction)
 *  - onTagDiscoveredForScan() (existing live-scan serial extraction)
 */
internal fun tagIdToHexString(id: ByteArray?): String? {
  if (id == null || id.isEmpty()) return null
  return id.joinToString("") { "%02x".format(it) }
}

/**
 * SDK-gated replacement for the single-arg Intent.getParcelableArrayExtra,
 * deprecated since API 33 in favor of the type-safe two-arg overload. This
 * module's minSdkVersion is 24 (android/gradle.properties), so both paths
 * are needed — the pre-33 branch necessarily still uses the deprecated
 * single-arg form, which is why it's suppressed at this one call site
 * rather than left to warn on every caller.
 */
@Suppress("DEPRECATION")
internal fun <T : Parcelable> Intent.getParcelableArrayExtraCompat(
  name: String,
  clazz: Class<T>,
): Array<out Parcelable>? =
  if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
    this.getParcelableArrayExtra(name, clazz)
  } else {
    this.getParcelableArrayExtra(name)
  }

/**
 * TurboModule implementation of the operation-oriented NFC Spec (§3).
 *
 * Native tracks only "which operationId currently occupies the physical
 * reader" — it has no notion of NDEFReader instances; multiplexing across
 * readers is entirely a JS-side concern owned by SessionCoordinator (§5a).
 *
 * NOTE: this is the production module built per IMPLEMENTATION_PLAN.md §7a,
 * following the build-order's Android feasibility-spike step (§13 step 6).
 * The base class name (NativeWebNfcApiSpecSpec) was confirmed empirically by
 * running the example app's `generateCodegenArtifactsFromSchema` Gradle task
 * against this repo's `codegenConfig.name = "WebNfcApiSpec"` before writing
 * this file — see the build report for the exact generated path/name.
 */
class NfcModule(private val reactContext: ReactApplicationContext) :
  NativeNfcSpec(reactContext), LifecycleEventListener {

  companion object {
    const val NAME = "NativeNfc"
    private const val TAG = "NfcModule"

    // The launch-activation queue (§12b/§12c) is process-wide native state,
    // not tied to a single NfcModule instance's lifetime, because
    // Activity.getIntent()/onNewIntent() can fire before the TurboModule
    // instance backing a fresh JS bridge has been constructed. A static
    // queue plus a static reference to the live module (if any) lets
    // MainActivity.onNewIntent() (called from example/android's Kotlin,
    // outside this module) enqueue an activation and notify JS immediately
    // when JS is already running, or simply leave it queued for the
    // cold-launch drain otherwise.
    private val launchTagQueue = ConcurrentLinkedQueue<LaunchActivation>()
    private val activationSeq = AtomicInteger(0)

    @Volatile
    private var activeInstance: NfcModule? = null

    /**
     * Called by the host app's Activity (MainActivity.onNewIntent) for the
     * warm-resume case (§12b) — the Activity already exists, so Android
     * delivers the new intent here instead of recreating the Activity.
     * Also safe to call defensively from onCreate with the initial intent,
     * though the cold-launch path below already covers that via
     * Activity.getIntent() read at NfcModule construction time.
     */
    @JvmStatic
    fun handleNewIntent(intent: Intent) {
      val records = extractNdefRecordsFromIntent(intent) ?: return
      val activation = enqueueActivation(records, intent)
      // §12b: onNewIntent's enqueue additionally emits launchTagReceived
      // since JS is already running to hear it; a cold-launch enqueue (via
      // the constructor reading Activity.getIntent()) is simply drained by
      // SessionCoordinator's own startup call to consumePendingLaunchTag().
      activeInstance?.emitLaunchTagReceived(activation.activationId)
    }

    private fun enqueueActivation(records: List<NdefWireRecordData>, intent: Intent): LaunchActivation {
      // Tag object isn't always present on NDEF_DISCOVERED intents (depends
      // on whether the dispatching Activity explicitly attached it), so
      // serial number is best-effort. When present, Tag.id gives the raw
      // 7-byte UID as a byte array — same path onTagDiscoveredForScan uses
      // for live scans, so launch activations are no longer worse than scan
      // activations when the tag is attached to the launch intent.
      val serialNumber: String? = run {
        val tagArray =
          intent.getParcelableArrayExtraCompat(NfcAdapter.EXTRA_TAG, Parcelable::class.java)
            ?: return@run null
        val tag = tagArray.firstOrNull() as? Tag ?: return@run null
        tagIdToHexString(tag.id)
      }
      val activation = LaunchActivation(
        activationId = "launch-${activationSeq.incrementAndGet()}-${UUID.randomUUID()}",
        serialNumber = serialNumber,
        records = records,
      )
      launchTagQueue.add(activation)
      return activation
    }

    /**
     * Converts an Intent's EXTRA_NDEF_MESSAGES (if present and it's an
     * NDEF_DISCOVERED intent) into the lossless wire record list (§5b).
     * Returns null if the intent carries no NDEF payload at all.
     */
    private fun extractNdefRecordsFromIntent(intent: Intent): List<NdefWireRecordData>? {
      if (intent.action != NfcAdapter.ACTION_NDEF_DISCOVERED) return null
      val rawMessages =
        intent.getParcelableArrayExtraCompat(NfcAdapter.EXTRA_NDEF_MESSAGES, Parcelable::class.java)
          ?: return null
      if (rawMessages.isEmpty()) return emptyList()
      val ndefMessage = rawMessages[0] as? NdefMessage ?: return emptyList()
      return ndefMessage.records.map { it.toWireRecord() }
    }
  }

  // --- operation state -------------------------------------------------------

  private var activeScanOperationId: String? = null
  private var pendingWrite: PendingWrite? = null
  private var pendingMakeReadOnly: PendingMakeReadOnly? = null
  private var listenerCount = 0

  private data class PendingWrite(
    val operationId: String,
    val records: List<NdefWireRecordData>,
    val overwrite: Boolean,
  )

  private data class PendingMakeReadOnly(val operationId: String)

  private val nfcAdapter: NfcAdapter?
    get() = NfcAdapter.getDefaultAdapter(reactContext)

  private val stateChangeReceiver = object : android.content.BroadcastReceiver() {
    override fun onReceive(context: android.content.Context?, intent: Intent?) {
      if (intent?.action != NfcAdapter.ACTION_ADAPTER_STATE_CHANGED) return
      val state = intent.getIntExtra(NfcAdapter.EXTRA_ADAPTER_STATE, NfcAdapter.STATE_OFF)
      val enabled = state == NfcAdapter.STATE_ON
      emitEvent("stateChanged") { putBoolean("enabled", enabled) }
    }
  }

  init {
    reactContext.addLifecycleEventListener(this)
    activeInstance = this
    reactContext.registerReceiver(
      stateChangeReceiver,
      IntentFilter(NfcAdapter.ACTION_ADAPTER_STATE_CHANGED),
    )
    // Cold-launch case (§12b): the Activity may already have an intent
    // (the one that started it) by the time this TurboModule is
    // constructed. Drain it once here; SessionCoordinator's own startup
    // call to consumePendingLaunchTag() (§12c) picks this up — no
    // launchTagReceived is emitted for this path since JS wasn't running
    // to receive an event yet.
    reactContext.currentActivity?.intent?.let { intent ->
      extractNdefRecordsFromIntent(intent)?.let { records ->
        enqueueActivation(records, intent)
      }
    }
  }

  override fun invalidate() {
    super.invalidate()
    activeInstance = null
    try {
      reactContext.unregisterReceiver(stateChangeReceiver)
    } catch (e: IllegalArgumentException) {
      // receiver was never registered / already unregistered — invalidate()
      // must be safe to call more than once.
      Log.d(TAG, "stateChangeReceiver already unregistered", e)
    }
    reactContext.removeLifecycleEventListener(this)
    disableReaderModeIfActive()
  }

  // --- Spec: isSupported/isEnabled --------------------------------------------

  override fun isSupported(promise: Promise) {
    promise.resolve(nfcAdapter != null)
  }

  override fun isEnabled(promise: Promise) {
    promise.resolve(nfcAdapter?.isEnabled ?: false)
  }

  // --- Spec: beginScan ---------------------------------------------------------

  override fun beginScan(operationId: String, options: ReadableMap, promise: Promise) {
    val adapter = nfcAdapter
    if (adapter == null) {
      promise.reject("NotSupportedError", "no NFC hardware on this device")
      return
    }
    if (!adapter.isEnabled) {
      promise.reject("NotReadableError", "NFC is disabled")
      return
    }
    val activity = reactContext.currentActivity
    if (activity == null) {
      promise.reject("NotSupportedError", "no foreground Activity to bind an NFC reader session to")
      return
    }

    activeScanOperationId = operationId

    val callback = NfcAdapter.ReaderCallback { tag -> onTagDiscoveredForScan(operationId, tag) }
    val flags = NfcAdapter.FLAG_READER_NFC_A or
      NfcAdapter.FLAG_READER_NFC_B or
      NfcAdapter.FLAG_READER_NFC_F or
      NfcAdapter.FLAG_READER_NFC_V or
      NfcAdapter.FLAG_READER_NFC_BARCODE or
      NfcAdapter.FLAG_READER_SKIP_NDEF_CHECK

    try {
      activity.runOnUiThread {
        try {
          adapter.enableReaderMode(activity, callback, flags, Bundle())
          promise.resolve(null)
        } catch (e: Exception) {
          activeScanOperationId = null
          promise.reject("NotReadableError", e.message, e)
        }
      }
    } catch (e: Exception) {
      activeScanOperationId = null
      promise.reject("NotReadableError", e.message, e)
    }
  }

  /**
   * enableReaderMode's callback delivers one tag at a time on a background
   * thread (§7a). If a beginWrite/beginMakeReadOnly is pending (§5a's
   * suspend policy — SessionCoordinator has already stopped the scan
   * subscriber-visible behavior on the JS side, but the physical
   * enableReaderMode session may still be the one servicing a write that
   * was issued while a scan's cancelOperation() call is in flight), service
   * that instead of emitting a read.
   */
  private fun onTagDiscoveredForScan(operationId: String, tag: Tag) {
    if (activeScanOperationId != operationId) return // stale callback from an already-cancelled session

    val exclusive = pendingWrite ?: pendingMakeReadOnly
    if (exclusive != null) {
      serviceExclusiveOperation(tag)
      return
    }

    val ndef = Ndef.get(tag)
    if (ndef == null) {
      emitEvent("operationEnded") {
        putString("operationId", operationId)
        putString("reason", "error")
        putString("message", "tag does not support NDEF")
      }
      return
    }

    val message = ndef.cachedNdefMessage ?: try {
      ndef.connect()
      val msg = ndef.ndefMessage
      ndef.close()
      msg
    } catch (e: Exception) {
      emitEvent("operationEnded") {
        putString("operationId", operationId)
        putString("reason", "error")
        putString("message", e.message ?: "failed to read NDEF message")
      }
      return
    }

    val wireRecords = message?.records?.map { it.toWireRecord() } ?: emptyList()
    val serialNumber = tagIdToHexString(tag.id)

    emitEvent("tagDiscovered") {
      putString("operationId", operationId)
      putString("serialNumber", serialNumber)
      putArray("records", wireRecordsToWritableArray(wireRecords))
    }
  }

  // --- Spec: beginWrite --------------------------------------------------------

  override fun beginWrite(
    operationId: String,
    records: ReadableArray,
    options: ReadableMap,
    promise: Promise,
  ) {
    val adapter = nfcAdapter
    if (adapter == null) {
      promise.reject("NotSupportedError", "no NFC hardware on this device")
      return
    }
    if (!adapter.isEnabled) {
      promise.reject("NotReadableError", "NFC is disabled")
      return
    }
    val activity = reactContext.currentActivity
    if (activity == null) {
      promise.reject("NotSupportedError", "no foreground Activity to bind an NFC reader session to")
      return
    }

    val overwrite = if (options.hasKey("overwrite")) options.getBoolean("overwrite") else true
    val wireRecords = readableArrayToWireRecords(records)

    pendingWrite = PendingWrite(operationId, wireRecords, overwrite)
    pendingPromises[operationId] = promise

    val callback = NfcAdapter.ReaderCallback { tag ->
      if (pendingWrite?.operationId == operationId) {
        serviceExclusiveOperation(tag)
      }
    }
    val flags = NfcAdapter.FLAG_READER_NFC_A or
      NfcAdapter.FLAG_READER_NFC_B or
      NfcAdapter.FLAG_READER_NFC_F or
      NfcAdapter.FLAG_READER_NFC_V or
      NfcAdapter.FLAG_READER_SKIP_NDEF_CHECK

    activity.runOnUiThread {
      try {
        adapter.enableReaderMode(activity, callback, flags, Bundle())
      } catch (e: Exception) {
        pendingWrite = null
        pendingPromises.remove(operationId)
        promise.reject("NotReadableError", e.message, e)
      }
    }
  }

  // --- Spec: beginMakeReadOnly --------------------------------------------------

  override fun beginMakeReadOnly(operationId: String, options: ReadableMap, promise: Promise) {
    val adapter = nfcAdapter
    if (adapter == null) {
      promise.reject("NotSupportedError", "no NFC hardware on this device")
      return
    }
    if (!adapter.isEnabled) {
      promise.reject("NotReadableError", "NFC is disabled")
      return
    }
    val activity = reactContext.currentActivity
    if (activity == null) {
      promise.reject("NotSupportedError", "no foreground Activity to bind an NFC reader session to")
      return
    }

    pendingMakeReadOnly = PendingMakeReadOnly(operationId)
    pendingPromises[operationId] = promise

    val callback = NfcAdapter.ReaderCallback { tag ->
      if (pendingMakeReadOnly?.operationId == operationId) {
        serviceExclusiveOperation(tag)
      }
    }
    val flags = NfcAdapter.FLAG_READER_NFC_A or
      NfcAdapter.FLAG_READER_NFC_B or
      NfcAdapter.FLAG_READER_NFC_F or
      NfcAdapter.FLAG_READER_NFC_V or
      NfcAdapter.FLAG_READER_SKIP_NDEF_CHECK

    activity.runOnUiThread {
      try {
        adapter.enableReaderMode(activity, callback, flags, Bundle())
      } catch (e: Exception) {
        pendingMakeReadOnly = null
        pendingPromises.remove(operationId)
        promise.reject("NotReadableError", e.message, e)
      }
    }
  }

  private val pendingPromises = java.util.concurrent.ConcurrentHashMap<String, Promise>()

  private fun serviceExclusiveOperation(tag: Tag) {
    val write = pendingWrite
    val makeReadOnly = pendingMakeReadOnly
    val ndef = Ndef.get(tag)

    if (write != null) {
      pendingWrite = null
      val promise = pendingPromises.remove(write.operationId)
      if (ndef == null) {
        val err = "tag does not support NDEF"
        promise?.reject("NotSupportedError", err)
        emitEvent("operationEnded") {
          putString("operationId", write.operationId)
          putString("reason", "error")
          putString("message", err)
        }
        return
      }
      try {
        ndef.connect()
        if (!write.overwrite && (ndef.cachedNdefMessage?.records?.isNotEmpty() == true)) {
          ndef.close()
          promise?.reject("NotAllowedError", "tag already has NDEF records and overwrite is false")
          emitEvent("operationEnded") {
            putString("operationId", write.operationId)
            putString("reason", "error")
            putString("message", "tag already has NDEF records and overwrite is false")
          }
          return
        }
        val androidRecords = write.records.map { it.toAndroidNdefRecord() }.toTypedArray()
        ndef.writeNdefMessage(NdefMessage(androidRecords))
        ndef.close()
        promise?.resolve(null)
        emitEvent("operationEnded") {
          putString("operationId", write.operationId)
          putString("reason", "success")
        }
      } catch (e: Exception) {
        promise?.reject("NetworkError", e.message, e)
        emitEvent("operationEnded") {
          putString("operationId", write.operationId)
          putString("reason", "error")
          putString("message", e.message ?: "write failed")
        }
      } finally {
        disableReaderModeIfNoOperationsPending()
      }
      return
    }

    if (makeReadOnly != null) {
      pendingMakeReadOnly = null
      val promise = pendingPromises.remove(makeReadOnly.operationId)
      if (ndef == null) {
        val err = "tag does not support NDEF"
        promise?.reject("NotSupportedError", err)
        emitEvent("operationEnded") {
          putString("operationId", makeReadOnly.operationId)
          putString("reason", "error")
          putString("message", err)
        }
        return
      }
      try {
        ndef.connect()
        // makeReadOnly() on an already-read-only tag resolves as a no-op
        // (§6e) — Ndef.makeReadOnly() itself already returns false rather
        // than throwing in that case on real hardware, so both paths
        // resolve successfully; only a genuine I/O failure rejects.
        ndef.makeReadOnly()
        ndef.close()
        promise?.resolve(null)
        emitEvent("operationEnded") {
          putString("operationId", makeReadOnly.operationId)
          putString("reason", "success")
        }
      } catch (e: Exception) {
        promise?.reject("NetworkError", e.message, e)
        emitEvent("operationEnded") {
          putString("operationId", makeReadOnly.operationId)
          putString("reason", "error")
          putString("message", e.message ?: "makeReadOnly failed")
        }
      } finally {
        disableReaderModeIfNoOperationsPending()
      }
    }
  }

  // --- Spec: cancelOperation ----------------------------------------------------

  override fun cancelOperation(operationId: String, promise: Promise) {
    var handled = false

    if (activeScanOperationId == operationId) {
      activeScanOperationId = null
      disableReaderModeIfNoOperationsPending()
      handled = true
    }

    if (pendingWrite?.operationId == operationId) {
      pendingWrite = null
      pendingPromises.remove(operationId)?.reject("AbortError", "operation cancelled")
      disableReaderModeIfNoOperationsPending()
      handled = true
    }

    if (pendingMakeReadOnly?.operationId == operationId) {
      pendingMakeReadOnly = null
      pendingPromises.remove(operationId)?.reject("AbortError", "operation cancelled")
      disableReaderModeIfNoOperationsPending()
      handled = true
    }

    // cancelOperation is idempotent (§3): always emit operationEnded, even
    // for an unknown/already-finished operationId.
    emitEvent("operationEnded") {
      putString("operationId", operationId)
      putString("reason", "cancelled")
    }
    if (!handled) {
      Log.d(TAG, "cancelOperation($operationId) — no matching active operation (idempotent no-op)")
    }
    promise.resolve(null)
  }

  private fun disableReaderModeIfNoOperationsPending() {
    if (activeScanOperationId == null && pendingWrite == null && pendingMakeReadOnly == null) {
      disableReaderModeIfActive()
    }
  }

  private fun disableReaderModeIfActive() {
    val activity = reactContext.currentActivity ?: return
    val adapter = nfcAdapter ?: return
    try {
      activity.runOnUiThread {
        try {
          adapter.disableReaderMode(activity)
        } catch (e: Exception) {
          Log.d(TAG, "disableReaderMode failed (activity likely finishing)", e)
        }
      }
    } catch (e: Exception) {
      Log.d(TAG, "disableReaderMode failed (activity likely finishing)", e)
    }
  }

  // --- Spec: consumePendingLaunchTag --------------------------------------------

  override fun consumePendingLaunchTag(promise: Promise) {
    val activation = launchTagQueue.poll()
    if (activation == null) {
      promise.resolve(null)
      return
    }
    val result: WritableMap = Arguments.createMap()
    result.putString("activationId", activation.activationId)
    activation.serialNumber?.let { result.putString("serialNumber", it) }
    result.putArray("records", wireRecordsToWritableArray(activation.records))
    promise.resolve(result)
  }

  private fun emitLaunchTagReceived(activationId: String) {
    emitEvent("launchTagReceived") { putString("activationId", activationId) }
  }

  // --- NativeEventEmitter plumbing (addListener/removeListeners) --------------

  override fun addListener(eventName: String) {
    listenerCount++
  }

  override fun removeListeners(count: Double) {
    listenerCount = (listenerCount - count.toInt()).coerceAtLeast(0)
  }

  private fun emitEvent(name: String, build: WritableMap.() -> Unit) {
    val map = Arguments.createMap()
    map.build()
    reactContext
      .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
      .emit(name, map)
  }

  // --- LifecycleEventListener (§7a/§12d: appStateChanged) ------------------------

  override fun onHostResume() {
    emitEvent("appStateChanged") { putString("state", "foreground") }
  }

  override fun onHostPause() {
    emitEvent("appStateChanged") { putString("state", "background") }
  }

  override fun onHostDestroy() {
    disableReaderModeIfActive()
  }

  // --- wire codec helpers (§5b) --------------------------------------------------

  private fun readableArrayToWireRecords(records: ReadableArray): List<NdefWireRecordData> {
    val result = mutableListOf<NdefWireRecordData>()
    for (i in 0 until records.size()) {
      val map = records.getMap(i) ?: continue
      result.add(
        NdefWireRecordData(
          tnf = map.getInt("tnf"),
          type = map.getString("type") ?: "",
          id = map.getString("id") ?: "",
          payload = map.getString("payload") ?: "",
        ),
      )
    }
    return result
  }

  private fun wireRecordsToWritableArray(records: List<NdefWireRecordData>): WritableArray {
    val array = Arguments.createArray()
    for (record in records) {
      val map = Arguments.createMap()
      map.putInt("tnf", record.tnf)
      map.putString("type", record.type)
      map.putString("id", record.id)
      map.putString("payload", record.payload)
      array.pushMap(map)
    }
    return array
  }
}
