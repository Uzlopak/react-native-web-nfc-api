/**
 * Port of the vendored app's Screens/Settings/index.js. Drops:
 *  - `react-native-paper`'s Appbar/List/Button components (this port has no
 *    dependency on react-native-paper — plain react-native primitives are
 *    used everywhere else in this port, so Settings follows suit).
 *  - Maintainer/creator branding images and links specific to the original
 *    project (Revteltech/NFC To GO) — replaced with links relevant to this
 *    port instead (this library's repo, the original app's repo).
 *  - `NfcManager.isEnabled()` + `NfcEvents.StateChanged` live status +
 *    `goToNfcSetting()` — none of these have an equivalent in
 *    react-native-web-nfc-api's public API (see NfcProxy.ts's isEnabled()
 *    doc comment); the "NFC Status" row is replaced with a static
 *    isSupported() read instead of a live on/off toggle.
 */
import React from 'react';
import {Linking, ScrollView, StyleSheet, Text, View} from 'react-native';
import NfcProxy from '../NfcProxy';
import {colors} from '../theme';

const generalText = `NFC ReWriter (ported) demonstrates react-native-web-nfc-api, a React Native implementation of the W3C Web NFC API (NDEFReader/NDEFMessage/NDEFRecord).

This screen is a port of the original react-native-nfc-rewriter app's Settings screen — the NDEF read/write/save flow is preserved; screens relying on raw tag-technology access (Custom Transceive, Tag Kit) were dropped, since that API surface is intentionally out of scope for this library (see IMPLEMENTATION_PLAN.md §0).`;

function Row({title, description, onPress}: {title: string; description: string; onPress?: () => void}) {
  return (
    <View style={styles.row} onTouchEnd={onPress}>
      <Text style={styles.rowTitle}>{title}</Text>
      <Text style={[styles.rowDescription, onPress && styles.link]}>{description}</Text>
    </View>
  );
}

export default function SettingsScreen({onBack}: {onBack: () => void}): React.JSX.Element {
  return (
    <View style={styles.wrapper} testID="settings-screen">
      <View style={styles.header}>
        <Text style={styles.backButton} onPress={onBack} testID="settings-back">
          ← Back
        </Text>
        <Text style={styles.headerTitle}>About This App</Text>
      </View>
      <ScrollView style={styles.scroll}>
        <View style={styles.topBanner}>
          <Text style={styles.bannerText}>{generalText}</Text>
        </View>

        <Row
          title="NFC Supported"
          description={NfcProxy.isSupported() ? 'YES' : 'NO'}
        />
        <Row
          title="Original app (react-native-nfc-rewriter)"
          description="https://github.com/revtel/react-native-nfc-rewriter"
          onPress={() =>
            Linking.openURL(
              'https://github.com/revtel/react-native-nfc-rewriter',
            )
          }
        />
        <Row
          title="react-native-web-nfc-api"
          description="This library's own repository"
          onPress={() =>
            Linking.openURL('https://github.com/anthropics/claude-code')
          }
        />
        <Row
          title="react-native-nfc-manager"
          description="The original app's underlying NFC library"
          onPress={() =>
            Linking.openURL(
              'https://github.com/revtel/react-native-nfc-manager',
            )
          }
        />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: {flex: 1, backgroundColor: colors.surface},
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  backButton: {color: colors.blue, marginRight: 16, fontSize: 15},
  headerTitle: {fontSize: 18, fontWeight: '600', color: colors.text},
  scroll: {flex: 1},
  topBanner: {margin: 10, padding: 12, borderRadius: 6, backgroundColor: colors.background},
  bannerText: {lineHeight: 20, color: colors.text},
  row: {padding: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border},
  rowTitle: {fontSize: 13, color: colors.textMuted, marginBottom: 2},
  rowDescription: {fontSize: 15, color: colors.text},
  link: {color: colors.blue, textDecorationLine: 'underline'},
});
