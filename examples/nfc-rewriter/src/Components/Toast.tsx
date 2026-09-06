/**
 * Simplified port of the vendored app's Components/Toast.js. The original
 * uses a global `reconnect.js` outlet so any screen can trigger a toast
 * without prop drilling; this port uses a small module-level subscriber list
 * instead (no extra dependency), preserving the same `showToast({message,
 * type})` call-site API used throughout the ported screens.
 */
import React from 'react';
import {Animated, StyleSheet, Text, View} from 'react-native';
import {colors} from '../theme';

interface ToastPayload {
  message: string;
  type: 'success' | 'alert';
}

type Listener = (payload: ToastPayload) => void;
const listeners = new Set<Listener>();

function showToast(payload: ToastPayload): void {
  listeners.forEach(listener => listener(payload));
}

function Toast(): React.JSX.Element {
  const [current, setCurrent] = React.useState<ToastPayload | null>(null);
  const animValue = React.useRef(new Animated.Value(0)).current;

  React.useEffect(() => {
    const listener: Listener = payload => {
      setCurrent(payload);
      Animated.timing(animValue, {
        toValue: 1,
        useNativeDriver: true,
        duration: 300,
      }).start(() => {
        setTimeout(() => {
          Animated.timing(animValue, {
            toValue: 0,
            useNativeDriver: true,
            duration: 300,
          }).start(() => setCurrent(null));
        }, 2000);
      });
    };
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, [animValue]);

  if (!current) {
    return <View testID="toast-empty" />;
  }

  const animStyle = {
    transform: [
      {
        translateY: animValue.interpolate({
          inputRange: [0, 1],
          outputRange: [-100, 0],
        }),
      },
    ],
  };

  return (
    <Animated.View style={[styles.bottom, animStyle]} pointerEvents="none">
      <View
        style={[
          current.type === 'alert' ? styles.alertContent : styles.successContent,
        ]}>
        <Text style={styles.text}>{current.message}</Text>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  bottom: {
    position: 'absolute',
    top: 40,
    left: 0,
    right: 0,
    padding: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  alertContent: {
    borderRadius: 5,
    padding: 15,
    backgroundColor: colors.danger,
  },
  successContent: {
    borderRadius: 5,
    padding: 15,
    backgroundColor: colors.success,
  },
  text: {color: colors.white},
});

export default Toast;
export {showToast};
