/**
 * @format
 */

import { AppRegistry, LogBox } from 'react-native';
import App from './App';
import { name as appName } from './app.json';

// The app runs on React Native's old architecture on purpose (react-native-macos). In a debug
// build the notice about it became a warning toast over Get started on every launch. So did the
// native note that macOS sent the appearance before JS listened (harmless at startup).
LogBox.ignoreLogs(['The app is running using the Legacy Architecture', 'Sending `appearanceChanged` with no listeners registered']);

AppRegistry.registerComponent(appName, () => App);
