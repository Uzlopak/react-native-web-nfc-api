import React from 'react';
import {Alert, Button, StyleSheet, TextInput, View} from 'react-native';
import NfcProxy from '../NfcProxy';
import {colors} from '../theme';
import type {WriterHandle} from './RtdTextWriter';

interface VCardValue {
  name: string;
  org?: string;
  tel?: string;
  email?: string;
}

interface Props {
  value?: VCardValue;
}

const VCardWriter = React.forwardRef<WriterHandle, Props>((props, ref) => {
  const [name, setName] = React.useState(props.value?.name || '');
  const [org, setOrg] = React.useState(props.value?.org || '');
  const [tel, setTel] = React.useState(props.value?.tel || '');
  const [email, setEmail] = React.useState(props.value?.email || '');

  React.useImperativeHandle(
    ref,
    () => ({getValue: () => ({name, org, tel, email})}),
    [name, org, tel, email],
  );

  const writeNdef = async () => {
    if (!name || (!tel && !email)) {
      Alert.alert('Invalid Input', 'Must provide "Name" and either "Tel" or "Email"');
      return;
    }
    await NfcProxy.writeNdef({type: 'VCARD', value: {name, org, tel, email}});
  };

  return (
    <View>
      <TextInput style={styles.input} placeholder="Name" value={name} onChangeText={setName} testID="vcard-name" />
      <TextInput style={styles.input} placeholder="Org" value={org} onChangeText={setOrg} testID="vcard-org" />
      <TextInput style={styles.input} placeholder="Tel" value={tel} onChangeText={setTel} testID="vcard-tel" />
      <TextInput
        style={styles.lastInput}
        placeholder="Email"
        value={email}
        onChangeText={setEmail}
        testID="vcard-email"
      />
      <Button title="WRITE" onPress={writeNdef} testID="vcard-write" />
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

export default VCardWriter;
