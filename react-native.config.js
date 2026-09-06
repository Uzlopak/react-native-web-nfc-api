// Consumed by the React Native CLI in host apps. Android has a real native
// implementation (android/); iOS does not exist yet (§7b/§13 build order —
// the iOS feasibility spike/production module comes after Android), so iOS
// autolinking is disabled until ios/ exists, the same pattern the sibling
// react-native-web-serial-api repo uses for its (permanently) Android-only
// case.
module.exports = {
  dependency: {
    platforms: {
      ios: null,
    },
  },
};
