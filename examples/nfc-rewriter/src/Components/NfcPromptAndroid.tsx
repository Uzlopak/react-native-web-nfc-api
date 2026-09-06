/**
 * Port of
 * docs/react-native-nfc-rewriter/src/Components/NfcPromptAndroid.js. The
 * original subscribed to a reconnect.js outlet ('androidPrompt') updated by
 * NfcProxy's withAndroidPrompt wrapper; this port subscribes directly to
 * NfcProxy.setPromptHandler instead, avoiding a new dependency on
 * reconnect.js for a single global banner.
 */
import * as React from 'react';
import {Platform, StyleSheet, Text, View} from 'react-native';
import {setPromptHandler} from '../NfcProxy';
import {colors} from '../theme';

export default function NfcPromptAndroid(): React.JSX.Element | null {
  const [state, setState] = React.useState<{
    visible: boolean;
    message?: string;
  }>({visible: false});

  React.useEffect(() => {
    setPromptHandler((visible, message) => setState({visible, message}));
    return () => setPromptHandler(null);
  }, []);

  if (Platform.OS !== 'android' || !state.visible) return null;

  return (
    <View style={styles.overlay} pointerEvents="none" testID="android-nfc-prompt">
      <View style={styles.banner}>
        <Text style={styles.text}>{state.message ?? 'Ready to scan NFC'}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    alignItems: 'center',
    paddingTop: 40,
  },
  banner: {
    backgroundColor: colors.blue,
    paddingVertical: 10,
    paddingHorizontal: 20,
    borderRadius: 20,
  },
  text: {color: 'white', fontWeight: '600'},
});
