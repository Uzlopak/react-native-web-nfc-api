/**
 * A small, dependency-free port of the vendored app's Theme.js — the
 * nfc-rewriter port avoids react-native-paper/react-navigation (see
 * README.md for the rationale) and instead uses these tokens directly with
 * plain React Native components.
 */
export const colors = {
  main: '#E7AC3E',
  sub: '#F4E16C',
  text: '#5C5B52',
  textMuted: '#888888',
  like: '#FFACB7',
  green: '#00ffa9',
  golden: '#FADB6A',
  white: '#ffffff',
  black: '#000000',
  blue: '#0099ff',
  grey: '#888888',
  background: '#f5f5f5',
  surface: '#ffffff',
  border: '#e0e0e0',
  danger: '#d9534f',
  success: '#12D8B4',
};

export const shadowProps = {
  shadowOffset: {width: 0, height: 4},
  shadowOpacity: 0.2,
  shadowRadius: 3,
  shadowColor: '#666',
  backgroundColor: colors.surface,
  elevation: 4,
};
