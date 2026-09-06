/**
 * Port of the vendored app's Screens/SavedRecord/RecordItem.js. The
 * original's `Share.share()` with a custom-scheme deep link (for
 * cross-device record sharing) has no equivalent target in this port — the
 * original app's other NFC technologies (NfcA/NfcV/IsoDep) that the share
 * payload could also carry are entirely out of scope here — so sharing is
 * dropped; delete/copy/open remain.
 */
import React from 'react';
import {StyleSheet, Text, TouchableOpacity, View} from 'react-native';
import {colors} from '../theme';
import type {SavedRecord} from '../Utils/Storage';

interface Props {
  record: SavedRecord;
  idx: number;
  onRemove: (idx: number) => void;
  onOpen: (record: SavedRecord, idx: number) => void;
  onCopy: (record: SavedRecord) => void;
}

function RecordItem({record, idx, onRemove, onOpen, onCopy}: Props): React.JSX.Element {
  return (
    <View style={styles.row} testID={`record-item-${idx}`}>
      <Text style={styles.title}>{record.name}</Text>
      <View style={styles.actions}>
        <TouchableOpacity onPress={() => onRemove(idx)} style={styles.actionButton}>
          <Text style={styles.actionText}>Delete</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={() => onCopy(record)} style={styles.actionButton}>
          <Text style={styles.actionText}>Copy</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={() => onOpen(record, idx)} style={styles.actionButton}>
          <Text style={styles.actionText}>Open →</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  title: {fontSize: 15, color: colors.text, flex: 1},
  actions: {flexDirection: 'row', gap: 12},
  actionButton: {paddingHorizontal: 4},
  actionText: {color: colors.blue, fontSize: 13},
});

export default RecordItem;
