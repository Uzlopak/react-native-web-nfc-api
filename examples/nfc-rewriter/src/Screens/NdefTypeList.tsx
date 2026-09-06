/**
 * Port of the vendored app's Screens/NdefTypeList/index.js. Icons dropped
 * (no bundled image assets ported — see README.md); list items kept 1:1.
 */
import React from 'react';
import {ScrollView, StyleSheet, Text, TouchableOpacity, View} from 'react-native';
import {colors} from '../theme';
import type {WriteType} from '../NfcProxy';

export interface NdefWriteParams {
  ndefType: WriteType;
  scheme?: string;
}

interface Item {
  title: string;
  description: string;
  params: NdefWriteParams;
}

const WELL_KNOWN: Item[] = [
  {title: 'TEXT', description: 'Write text into NFC tags', params: {ndefType: 'TEXT'}},
  {
    title: 'Link',
    description: 'Write web link or uri into NFC tags',
    params: {ndefType: 'URI'},
  },
  {
    title: 'TEL',
    description: 'Write number into NFC tags to make phone call',
    params: {ndefType: 'URI', scheme: 'tel:'},
  },
  {
    title: 'SMS',
    description: 'Write number into NFC tags to send SMS',
    params: {ndefType: 'URI', scheme: 'sms:'},
  },
  {
    title: 'EMAIL',
    description: 'Write email into NFC tags',
    params: {ndefType: 'URI', scheme: 'mailto:'},
  },
];

const MIME: Item[] = [
  {
    title: 'WiFi Simple Record',
    description: 'Connect to your WiFi AP',
    params: {ndefType: 'WIFI_SIMPLE'},
  },
  {
    title: 'vCard',
    description: 'Write contact records. Not supported by iOS natively.',
    params: {ndefType: 'VCARD'},
  },
];

interface Props {
  onSelect: (params: NdefWriteParams) => void;
  onBack: () => void;
}

function NdefTypeListScreen({onSelect, onBack}: Props): React.JSX.Element {
  const renderItem = (item: Item) => (
    <TouchableOpacity
      key={item.title}
      style={styles.item}
      onPress={() => onSelect(item.params)}
      testID={`ndef-type-${item.title}`}>
      <Text style={styles.itemTitle}>{item.title}</Text>
      <Text style={styles.itemDescription}>{item.description}</Text>
    </TouchableOpacity>
  );

  return (
    <ScrollView style={styles.wrapper} testID="ndef-type-list-screen">
      <Text style={styles.backButton} onPress={onBack} testID="ndef-type-list-back">
        ← Back
      </Text>
      <Text style={styles.sectionHeader}>Well Known</Text>
      {WELL_KNOWN.map(renderItem)}
      <Text style={styles.sectionHeader}>MIME</Text>
      {MIME.map(renderItem)}
      <View style={styles.spacer} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  wrapper: {flex: 1, backgroundColor: colors.surface},
  backButton: {color: colors.blue, fontSize: 15, padding: 16},
  sectionHeader: {
    fontSize: 13,
    fontWeight: 'bold',
    color: colors.textMuted,
    padding: 12,
    paddingBottom: 4,
  },
  item: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  itemTitle: {fontSize: 16, color: colors.text},
  itemDescription: {fontSize: 12, color: colors.textMuted, marginTop: 2},
  spacer: {height: 40},
});

export default NdefTypeListScreen;
