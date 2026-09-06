package dev.webnfcapi

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * Regression tests for tagIdToHexString — the testable byte-to-hex helper
 * extracted from NfcModule.kt (finding #3).
 *
 * The Intent / Tag / NfcAdapter bridge plumbing above this helper still
 * requires a real Android device or Robolectric to exercise; this JVM test
 * pins down the byte-to-hex mapping so a regression in the helper is
 * caught without hardware. The full enqueueActivation flow is covered by
 * the integration tests in src/__tests__/conformance-suite.ts (it consumes
 * the activation payload produced by this code path via
 * consumePendingLaunchTag()).
 */
class TagIdHexStringTest {
  @Test
  fun emptyByteArrayReturnsNull() {
    assertNull(tagIdToHexString(ByteArray(0)))
  }

  @Test
  fun nullByteArrayReturnsNull() {
    assertNull(tagIdToHexString(null))
  }

  @Test
  fun encodesTypical4ByteNfcUidAsLowercaseHex() {
    // Real NFC Forum Type 2 tag UIDs (MIFARE Classic 1K etc.) are 4 or 7 bytes;
    // verify the 4-byte case end-to-end with realistic bytes.
    assertEquals("04aabbcc", tagIdToHexString(byteArrayOf(0x04, 0xaa.toByte(), 0xbb.toByte(), 0xcc.toByte())))
  }

  @Test
  fun encodes7ByteUidAsLowercaseHex() {
    // MIFARE Ultralight / NTAG UIDs are typically 7 bytes; this is also the
    // canonical example used in NfcModule.kt's onTagDiscoveredForScan().
    assertEquals(
      "04112233445566",
      tagIdToHexString(byteArrayOf(0x04, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66)),
    )
  }

  @Test
  fun padSingleDigitHexBytesWithLeadingZero() {
    // A byte < 0x10 must render as two hex chars, not one — otherwise the
    // JS side gets a string of inconsistent length for the same tag type.
    assertEquals("0a", tagIdToHexString(byteArrayOf(0x0a)))
  }

  @Test
  fun highBitBytesStillProduceTwoChars() {
    assertEquals("ff", tagIdToHexString(byteArrayOf(0xff.toByte())))
  }
}
