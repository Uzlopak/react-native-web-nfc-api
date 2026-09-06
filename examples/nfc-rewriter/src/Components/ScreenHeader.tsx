/**
 * Port of the vendored app's Components/ScreenHeader.js: a header with a
 * back button, title, and (when a `getRecordPayload` getter is supplied) a
 * save action that either overwrites an existing saved record or opens
 * SaveRecordModal to name a new one.
 */
import React from 'react';
import {Alert, Button, StyleSheet, Text, View} from 'react-native';
import {colors} from '../theme';
import {useAppContext} from '../AppContext';
import type {SavedRecord} from '../Utils/Storage';
import SaveRecordModal from './SaveRecordModal';
import {showToast} from './Toast';

interface Props {
  title: string;
  onBack: () => void;
  getRecordPayload?: () => SavedRecord['payload'] | null;
  savedRecord?: SavedRecord;
  savedRecordIdx?: number;
  readOnly?: boolean;
}

function ScreenHeader({
  title,
  onBack,
  getRecordPayload,
  savedRecord,
  savedRecordIdx,
  readOnly,
}: Props): React.JSX.Element {
  const {storageCache, setStorage} = useAppContext();
  const [saveModalVisible, setSaveModalVisible] = React.useState(false);

  async function onPersistRecord(name: string, updateExisting = false) {
    const payload = getRecordPayload?.();
    if (!payload) {
      return;
    }
    const nextList = [...storageCache];
    if (updateExisting && typeof savedRecordIdx === 'number') {
      nextList[savedRecordIdx] = {name, payload};
    } else {
      nextList.push({name, payload});
    }
    await setStorage(nextList);
    setSaveModalVisible(false);
  }

  return (
    <View style={styles.wrapper}>
      <View style={styles.header}>
        <Button title="< Back" onPress={onBack} testID="screen-header-back" />
        <Text style={styles.title}>{title}</Text>
        {!!getRecordPayload && !readOnly && (
          <Button
            title="Save"
            testID="screen-header-save"
            onPress={() => {
              if (savedRecord && typeof savedRecordIdx === 'number') {
                Alert.alert('Confirm', 'Do you want to override current record?', [
                  {
                    text: 'YES',
                    onPress: () => {
                      onPersistRecord(savedRecord.name, true);
                      showToast({
                        message: `"${savedRecord.name}" has been updated successfully!`,
                        type: 'success',
                      });
                    },
                  },
                  {text: 'No'},
                ]);
              } else {
                setSaveModalVisible(true);
              }
            }}
          />
        )}
      </View>

      <SaveRecordModal
        visible={saveModalVisible}
        onClose={() => setSaveModalVisible(false)}
        onPersistRecord={onPersistRecord}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: {backgroundColor: colors.surface},
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  title: {fontSize: 16, fontWeight: 'bold', color: colors.text},
});

export default ScreenHeader;
