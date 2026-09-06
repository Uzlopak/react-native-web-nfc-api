/**
 * Port of the vendored app's Components/SaveRecordModal.js, using plain
 * React Native components (no react-native-paper) — see README.md.
 */
import React from 'react';
import {Button, Modal, StyleSheet, Text, TextInput, View} from 'react-native';
import {colors} from '../theme';

interface Props {
  visible: boolean;
  onClose: () => void;
  title?: string;
  onPersistRecord: (name: string) => void;
}

function SaveRecordModal({visible, onClose, title, onPersistRecord}: Props): React.JSX.Element {
  const [name, setName] = React.useState('');

  React.useEffect(() => {
    if (!visible) {
      setName('');
    }
  }, [visible]);

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={styles.header}>
        <Button title="Close" onPress={onClose} />
        <Text style={styles.headerTitle}>{title || 'SAVE RECORD'}</Text>
      </View>
      <View style={styles.body}>
        <TextInput
          value={name}
          onChangeText={setName}
          placeholder="Name"
          autoFocus
          testID="save-record-name-input"
          style={styles.input}
        />
        <Button
          title="SAVE"
          testID="save-record-confirm"
          onPress={() => {
            if (name) {
              onPersistRecord(name);
            }
          }}
        />
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 12,
    backgroundColor: colors.surface,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  headerTitle: {marginLeft: 12, fontSize: 16, fontWeight: 'bold'},
  body: {flex: 1, padding: 15, backgroundColor: colors.surface},
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 6,
    padding: 10,
    marginBottom: 12,
  },
});

export default SaveRecordModal;
