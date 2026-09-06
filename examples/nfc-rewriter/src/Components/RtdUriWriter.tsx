import React from 'react';
import {Button, StyleSheet, TextInput, View} from 'react-native';
import NfcProxy from '../NfcProxy';
import {colors} from '../theme';
import type {WriterHandle} from './RtdTextWriter';

interface UriValue {
  value: string;
  prefix: string;
}

interface Props {
  value?: UriValue;
}

const PREFIXES = ['https://', 'http://', '---'];

const RtdUriWriter = React.forwardRef<WriterHandle, Props>((props, ref) => {
  const [value, setValue] = React.useState(props.value?.value || '');
  const [prefix, setPrefix] = React.useState(props.value?.prefix || 'https://');

  React.useImperativeHandle(ref, () => ({getValue: () => ({value, prefix})}), [
    value,
    prefix,
  ]);

  const writeNdef = async () => {
    if (!value) {
      return;
    }
    const url = prefix !== '---' ? prefix + value : value;
    await NfcProxy.writeNdef({type: 'URI', value: url});
  };

  return (
    <View>
      <View style={styles.prefixRow}>
        {PREFIXES.map(p => (
          <Button
            key={p}
            title={p}
            color={p === prefix ? colors.blue : undefined}
            onPress={() => setPrefix(p)}
          />
        ))}
      </View>
      <TextInput
        style={styles.input}
        placeholder="URI"
        value={value}
        autoCapitalize="none"
        onChangeText={setValue}
        testID="rtd-uri-input"
      />
      <Button title="WRITE" onPress={writeNdef} testID="rtd-uri-write" />
    </View>
  );
});

const styles = StyleSheet.create({
  prefixRow: {flexDirection: 'row', marginBottom: 10, gap: 4},
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 6,
    padding: 10,
    marginBottom: 20,
  },
});

export default RtdUriWriter;
