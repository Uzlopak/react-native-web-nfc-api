/**
 * Port of docs/react-native-nfc-rewriter/src/Screens/Home/index.js.
 *
 * Dropped from the original:
 *  - Deep-link handling (`Linking`, `query-string` share-payload parsing)
 *    that routed shared records to CustomTransceive — that screen doesn't
 *    exist in this port (raw tag-tech, out of scope), so the deep-link
 *    plumbing that only ever fed it is dropped too.
 *  - `NfcManager.getBackgroundTag()` / `DiscoverBackgroundTag` listener —
 *    this library's launch-delivery normalization (IMPLEMENTATION_PLAN.md
 *    §12) surfaces launch-delivered tags as ordinary `reading` events, not
 *    as a separate "background tag" API; wiring that up needs a live
 *    `scan()` subscription, which this simple screen doesn't keep open.
 *    The Virtual Tag demo's Lifecycle tab (see App.tsx) is the place this
 *    library's example already demonstrates that flow.
 *  - `goToNfcSetting()` — no equivalent in this library (see NfcProxy.ts).
 */
import * as React from 'react';
import {
  Dimensions,
  Linking,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import NfcProxy, {type SimpleTag} from '../NfcProxy';
import {colors} from '../theme';

export default function HomeScreen({
  onScannedTag,
  onOpenNdefTypeList,
  onOpenSavedRecords,
  onOpenSettings,
}: {
  onScannedTag: (tag: SimpleTag) => void;
  onOpenNdefTypeList: () => void;
  onOpenSavedRecords: () => void;
  onOpenSettings: () => void;
}): React.JSX.Element {
  // `null` means "supported, but this library has no way to know whether
  // the radio is on until a real scan()/write() is attempted" (see
  // NfcProxy.isEnabled()) — treated the same as "assume enabled" below, so
  // the user can try to scan rather than being blocked by a banner that
  // isn't actually backed by a real hardware check.
  const [enabled, setEnabled] = React.useState<boolean | null>(null);
  const showNotEnabledBanner = enabled === false;
  const padding = 40;
  const width = Math.max(200, Dimensions.get('window').width - 2 * padding);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      const isEnabled = await NfcProxy.isEnabled();
      if (!cancelled) setEnabled(isEnabled);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const scanTag = async () => {
    const tag = await NfcProxy.readTag();
    if (tag) onScannedTag(tag);
  };

  return (
    <View style={[styles.screen, {padding}]} testID="home-screen">
      <View style={styles.center}>
        <Text style={styles.appTitle}>NFC ReWriter</Text>
        <Text style={styles.subtitle}>Open Source NFC Reader/Writer</Text>
        <Text style={styles.portNote}>
          (ported to react-native-web-nfc-api)
        </Text>

        <View style={styles.tabRow}>
          <Pressable style={styles.tabButton} onPress={onOpenNdefTypeList} testID="nav-write-ndef">
            <Text style={styles.tabButtonText}>WRITE NDEF</Text>
          </Pressable>
          <Pressable style={styles.tabButton} onPress={onOpenSavedRecords} testID="nav-saved-records">
            <Text style={styles.tabButtonText}>MY RECORDS</Text>
          </Pressable>
        </View>

        <TouchableOpacity
          onPress={() =>
            Linking.openURL(
              'https://github.com/revtel/react-native-nfc-rewriter',
            )
          }
          style={styles.link}>
          <Text style={styles.linkText}>Original app (GitHub)</Text>
        </TouchableOpacity>
        <TouchableOpacity
          onPress={() =>
            Linking.openURL('https://github.com/anthropics/claude-code')
          }
          style={styles.link}>
          <Text style={styles.linkText}>react-native-web-nfc-api</Text>
        </TouchableOpacity>
      </View>

      <Pressable
        style={styles.settingsButton}
        onPress={onOpenSettings}
        testID="nav-settings">
        <Text style={styles.settingsButtonText}>⚙</Text>
      </Pressable>

      <View style={styles.bottom}>
        {!showNotEnabledBanner ? (
          <Pressable style={[styles.scanButton, {width}]} onPress={scanTag} testID="scan-tag-button">
            <Text style={styles.scanButtonText}>SCAN NFC TAG</Text>
          </Pressable>
        ) : (
          <View style={[styles.notEnabled, {width}]}>
            <Text style={styles.notEnabledText}>
              Your NFC is not enabled or not supported on this platform.
              {Platform.OS !== 'android' &&
                ' (react-native-web-nfc-api has no cross-platform "open NFC settings" API — see NfcProxy.ts.)'}
            </Text>
            <Pressable
              style={styles.checkAgainButton}
              onPress={async () => setEnabled(await NfcProxy.isEnabled())}
              testID="check-again-button">
              <Text style={styles.checkAgainButtonText}>CHECK AGAIN</Text>
            </Pressable>
          </View>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {flex: 1, backgroundColor: colors.background},
  center: {flex: 1, alignItems: 'center', justifyContent: 'center'},
  appTitle: {fontSize: 26, fontWeight: 'bold', color: colors.text},
  subtitle: {
    padding: 12,
    fontSize: 16,
    fontWeight: '600',
    textAlign: 'center',
    color: colors.textMuted,
  },
  portNote: {fontSize: 12, color: colors.textMuted, marginBottom: 16},
  tabRow: {flexDirection: 'row', gap: 12, marginBottom: 16},
  tabButton: {
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.blue,
  },
  tabButtonText: {color: colors.blue, fontWeight: '600'},
  link: {paddingVertical: 6},
  linkText: {color: colors.textMuted, textDecorationLine: 'underline'},
  settingsButton: {
    position: 'absolute',
    top: Platform.OS === 'android' ? 20 : 8,
    right: 12,
    padding: 8,
  },
  settingsButtonText: {fontSize: 22},
  bottom: {alignItems: 'center', marginBottom: 12},
  scanButton: {
    backgroundColor: colors.blue,
    paddingVertical: 14,
    borderRadius: 8,
    alignItems: 'center',
  },
  scanButtonText: {color: 'white', fontWeight: 'bold', fontSize: 16},
  notEnabled: {alignItems: 'stretch'},
  notEnabledText: {textAlign: 'center', marginBottom: 10, color: colors.text},
  checkAgainButton: {
    borderWidth: 1,
    borderColor: colors.blue,
    borderRadius: 8,
    paddingVertical: 10,
    alignItems: 'center',
  },
  checkAgainButtonText: {color: colors.blue, fontWeight: '600'},
});
