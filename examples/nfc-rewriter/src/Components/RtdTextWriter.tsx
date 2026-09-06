import React from 'react';
import {Button, StyleSheet, TextInput, View} from 'react-native';
import NfcProxy from '../NfcProxy';
import {colors} from '../theme';

export interface WriterHandle {
  getValue: () => unknown;
}

interface Props {
  value?: string;
}

const RtdTextWriter = React.forwardRef<WriterHandle, Props>((props, ref) => {
  const [value, setValue] = React.useState(props.value || '');

  React.useImperativeHandle(ref, () => ({getValue: () => value}), [value]);

  const writeNdef = async () => {
    if (!value) {
      return;
    }
    await NfcProxy.writeNdef({type: 'TEXT', value});
  };

  return (
    <View>
      <TextInput
        style={styles.input}
        placeholder="Text"
        multiline
        value={value}
        autoCapitalize="none"
        onChangeText={setValue}
        testID="rtd-text-input"
      />
      <Button title="WRITE" onPress={writeNdef} testID="rtd-text-write" />
    </View>
  );
});

const styles = StyleSheet.create({
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 6,
    padding: 10,
    minHeight: 80,
    marginBottom: 10,
    textAlignVertical: 'top',
  },
});

export default RtdTextWriter;
