/**
 * Port of the vendored app's Screens/SavedRecord/index.js. Grouping by
 * nfc-manager tech (NDEF/NfcA/NfcV/IsoDep) is dropped since this port only
 * ever writes NDEF records — every saved record here is NDEF-scoped by
 * construction, so a single flat list replaces the four grouped sections.
 */
import React from 'react';
import {Alert, Button, ScrollView, StyleSheet, Text, View} from 'react-native';
import {colors} from '../theme';
import {useAppContext} from '../AppContext';
import RecordItem from '../Components/SavedRecordItem';
import SaveRecordModal from '../Components/SaveRecordModal';
import type {SavedRecord} from '../Utils/Storage';

interface Props {
  onOpenRecord: (record: SavedRecord, idx: number) => void;
  onBack: () => void;
}

function SavedRecordScreen({onOpenRecord, onBack}: Props): React.JSX.Element {
  const {storageCache, setStorage} = useAppContext();
  const [recordToCopy, setRecordToCopy] = React.useState<SavedRecord | null>(null);

  async function clearAll() {
    Alert.alert('CONFIRM', 'Are you sure?', [
      {text: 'DO IT', onPress: () => setStorage([])},
      {text: 'CANCEL'},
    ]);
  }

  async function removeIdx(idx: number) {
    Alert.alert('CONFIRM', 'Are you sure?', [
      {
        text: 'DO IT',
        onPress: () => {
          const next = [...storageCache];
          next.splice(idx, 1);
          setStorage(next);
        },
      },
      {text: 'CANCEL'},
    ]);
  }

  return (
    <View style={styles.wrapper} testID="saved-record-screen">
      <Text style={styles.backButton} onPress={onBack} testID="saved-record-back">
        ← Back
      </Text>
      <Text style={styles.header}>MY RECORDS ({storageCache.length})</Text>
      <ScrollView style={styles.list}>
        {storageCache.map((record, idx) => (
          <RecordItem
            key={idx}
            record={record}
            idx={idx}
            onRemove={removeIdx}
            onOpen={onOpenRecord}
            onCopy={setRecordToCopy}
          />
        ))}
      </ScrollView>
      <Button title="CLEAR ALL" onPress={clearAll} testID="saved-record-clear-all" />

      <SaveRecordModal
        title="COPY THIS RECORD AS"
        visible={!!recordToCopy}
        onClose={() => setRecordToCopy(null)}
        onPersistRecord={async name => {
          if (!recordToCopy) {
            return;
          }
          await setStorage([...storageCache, {name, payload: recordToCopy.payload}]);
          setRecordToCopy(null);
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: {flex: 1, backgroundColor: colors.surface},
  backButton: {color: colors.blue, fontSize: 15, padding: 16, paddingBottom: 0},
  header: {fontSize: 20, fontWeight: 'bold', padding: 16, color: colors.text},
  list: {flex: 1},
});

export default SavedRecordScreen;
