import React from 'react';
import {Button, StyleSheet, Text, TextInput, View} from 'react-native';
import NfcProxy from '../NfcProxy';
import {colors} from '../theme';
import type {WriterHandle} from './RtdTextWriter';

const InputLabel: Record<string, string> = {
  'sms:': 'Number',
  'tel:': 'Number',
  'mailto:': 'Email',
};

interface Props {
  scheme: string;
  value?: {value: string};
}

const RtdUriShortcutWriter = React.forwardRef<WriterHandle, Props>((props, ref) => {
  const {scheme} = props;
  const [value, setValue] = React.useState(props.value?.value || '');

  React.useImperativeHandle(ref, () => ({getValue: () => ({value, scheme})}), [
    value,
    scheme,
  ]);

  const writeNdef = async () => {
    if (!value) {
      return;
    }
    await NfcProxy.writeNdef({type: 'URI', value: scheme + value});
  };

  return (
    <View>
      <View style={styles.schemeRow}>
        <Text style={styles.scheme}>{scheme}</Text>
      </View>
      <TextInput
        style={styles.input}
        placeholder={InputLabel[scheme] || 'Value'}
        value={value}
        autoCapitalize="none"
        onChangeText={setValue}
        testID="rtd-uri-shortcut-input"
      />
      <Button title="WRITE" onPress={writeNdef} testID="rtd-uri-shortcut-write" />
    </View>
  );
});

const styles = StyleSheet.create({
  schemeRow: {marginBottom: 10},
  scheme: {fontSize: 16, color: colors.textMuted},
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 6,
    padding: 10,
    marginBottom: 20,
  },
});

export default RtdUriShortcutWriter;
