import React from 'react';
import {Button, StyleSheet, TextInput, View} from 'react-native';
import NfcProxy from '../NfcProxy';
import {colors} from '../theme';
import type {WriterHandle} from './RtdTextWriter';

interface WifiValue {
  ssid: string;
  networkKey: string;
}

interface Props {
  value?: WifiValue;
}

const WifiSimpleWriter = React.forwardRef<WriterHandle, Props>((props, ref) => {
  const [ssid, setSsid] = React.useState(props.value?.ssid || '');
  const [networkKey, setNetworkKey] = React.useState(props.value?.networkKey || '');

  React.useImperativeHandle(ref, () => ({getValue: () => ({ssid, networkKey})}), [
    ssid,
    networkKey,
  ]);

  const writeNdef = async () => {
    if (!ssid || !networkKey) {
      return;
    }
    await NfcProxy.writeNdef({type: 'WIFI_SIMPLE', value: {ssid, networkKey}});
  };

  return (
    <View>
      <TextInput style={styles.input} placeholder="SSID" value={ssid} onChangeText={setSsid} testID="wifi-ssid" />
      <TextInput
        style={styles.lastInput}
        placeholder="Network Key"
        value={networkKey}
        onChangeText={setNetworkKey}
        testID="wifi-key"
      />
      <Button title="WRITE" onPress={writeNdef} testID="wifi-write" />
    </View>
  );
});

const styles = StyleSheet.create({
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 6,
    padding: 10,
    marginBottom: 10,
  },
  lastInput: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 6,
    padding: 10,
    marginBottom: 20,
  },
});

export default WifiSimpleWriter;
