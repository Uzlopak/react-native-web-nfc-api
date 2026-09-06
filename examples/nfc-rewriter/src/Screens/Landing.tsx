/**
 * Port of docs/react-native-nfc-rewriter/src/Screens/Landing/index.js.
 * Drops the app icon image (not vendored into this example) and the
 * decorative zoom/fade Animated sequence's dependency on that image asset,
 * keeping the functional core: check NFC support via NfcProxy.init(), then
 * report the result up (App.tsx derives whether to show this screen or the
 * rest of the app from that result plus the Virtual Tag demo toggle — see
 * App.tsx's `ready` comment).
 */
import * as React from 'react';
import {ActivityIndicator, StyleSheet, Text, View} from 'react-native';
import NfcProxy from '../NfcProxy';
import {colors} from '../theme';

export default function LandingScreen({
  onSupportChecked,
}: {
  onSupportChecked: (supported: boolean) => void;
}): React.JSX.Element {
  const [isNfcSupported, setIsNfcSupported] = React.useState<boolean | null>(
    null,
  );

  // onSupportChecked is a fresh closure from App.tsx on every render;
  // reading it through a ref keeps this effect running only once on mount
  // without needing a lint-suppression comment to justify excluding it
  // from the deps list.
  const onSupportCheckedRef = React.useRef(onSupportChecked);
  onSupportCheckedRef.current = onSupportChecked;

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      const supported = await NfcProxy.init();
      if (cancelled) return;
      setIsNfcSupported(supported);
      onSupportCheckedRef.current(supported);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <View style={styles.container} testID="landing-screen">
      <Text style={styles.title}>NFC ReWriter</Text>
      {isNfcSupported === false ? (
        <Text style={styles.notSupported}>
          Your device/browser doesn't support NFC. Turn on Virtual Tag demo
          above to try this app anyway.
        </Text>
      ) : (
        <ActivityIndicator size="large" style={styles.spinner} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.background,
  },
  title: {fontSize: 28, fontWeight: 'bold', color: colors.text},
  notSupported: {fontSize: 16, padding: 20, textAlign: 'center', color: colors.textMuted},
  spinner: {marginTop: 30},
});
