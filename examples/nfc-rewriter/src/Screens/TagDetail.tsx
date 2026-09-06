/**
 * Port of the vendored app's Screens/TagDetail/index.js + Components/NdefMessage.js.
 * Drops:
 *  - `getTechList(tag)` / the "TECHNOLOGIES" chip row — enumerating raw tag
 *    technologies (NfcA/NfcB/IsoDep/MifareClassic/...) has no equivalent in
 *    this library, which only ever exposes the NDEF layer (§0 scope
 *    boundary) — `SimpleTag` (NfcProxy.ts) has no technology list to show.
 *  - `react-native-paper`'s Button/Appbar (not a dependency of this port).
 *  - Per-RTD-type payload components (RtdTextPayload/RtdUriPayload/
 *    WifiSimplePayload/TextBasedMimePayload as separate classes) — this
 *    library's NDEFReader already decodes text into `record.text` (see
 *    NfcProxy.toSimpleTag), so there's no raw NDEF byte payload left to
 *    re-decode here; a single inline renderer covers all record types by
 *    reading `recordType`/`mediaType`/`text` directly off SimpleTag.
 */
import React from 'react';
import {Linking, ScrollView, StyleSheet, Text, View} from 'react-native';
import {colors} from '../theme';
import type {SimpleTag} from '../NfcProxy';

function isLikelyUrl(text: string): boolean {
  return /^https?:\/\//i.test(text);
}

export default function TagDetailScreen({
  tag,
  onBack,
}: {
  tag: SimpleTag;
  onBack: () => void;
}): React.JSX.Element {
  return (
    <View style={styles.wrapper} testID="tag-detail-screen">
      <View style={styles.header}>
        <Text style={styles.backButton} onPress={onBack} testID="tag-detail-back">
          ← Back
        </Text>
        <Text style={styles.headerTitle}>Tag Detail</Text>
      </View>
      <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
        <View style={styles.section}>
          <Text style={styles.sectionLabel}>SERIAL NUMBER</Text>
          <Text style={styles.value}>{tag.serialNumber || '---'}</Text>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionLabel}>
            NDEF RECORDS ({tag.records.length})
          </Text>
          {tag.records.length === 0 ? (
            <Text style={styles.value}>--- (empty message)</Text>
          ) : (
            tag.records.map((record, idx) => (
              <View key={idx} style={styles.recordRow} testID={`tag-detail-record-${idx}`}>
                <Text style={styles.recordType}>
                  {record.recordType}
                  {record.mediaType ? ` (${record.mediaType})` : ''}
                </Text>
                {record.id ? (
                  <Text style={styles.recordMeta}>id: {record.id}</Text>
                ) : null}
                {record.text !== undefined ? (
                  isLikelyUrl(record.text) ? (
                    <Text
                      style={styles.recordLink}
                      onPress={() =>
                        Linking.openURL(record.text!).catch(() => {})
                      }>
                      {record.text}
                    </Text>
                  ) : (
                    <Text style={styles.recordText}>{record.text}</Text>
                  )
                ) : (
                  <Text style={styles.recordMeta}>(binary payload, not text-decodable)</Text>
                )}
              </View>
            ))
          )}
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionLabel}>RAW TAG OBJECT</Text>
          <Text style={styles.rawJson}>{JSON.stringify(tag, null, 2)}</Text>
        </View>
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
  content: {padding: 10},
  section: {
    padding: 10,
    borderRadius: 8,
    backgroundColor: colors.background,
    marginBottom: 12,
  },
  sectionLabel: {fontSize: 13, color: colors.textMuted, marginBottom: 6},
  value: {fontSize: 16, color: colors.text},
  recordRow: {
    paddingVertical: 6,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  recordType: {fontSize: 13, color: colors.textMuted, marginBottom: 2},
  recordMeta: {fontSize: 12, color: colors.textMuted},
  recordText: {fontSize: 16, color: colors.text},
  recordLink: {fontSize: 16, color: colors.blue, textDecorationLine: 'underline'},
  rawJson: {fontSize: 12, color: colors.textMuted, fontFamily: 'monospace'},
});
