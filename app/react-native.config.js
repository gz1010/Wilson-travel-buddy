// Fonts bundled into the iOS app (linked into the Xcode project by `npx react-native-asset`).
// The blur, gradient and mask libraries are iOS-only (the Dusk design runs on iOS); keep them
// out of the macOS build so the classic Mac app still installs and builds.
const iosOnly = { platforms: { macos: null } };

module.exports = {
  assets: ['./assets/fonts'],
  dependencies: {
    '@react-native-community/blur': iosOnly,
    '@react-native-masked-view/masked-view': iosOnly,
    'react-native-linear-gradient': iosOnly,
  },
};
