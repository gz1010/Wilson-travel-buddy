// On macOS, a real mouse click on a React Native control that floats over a web view (the map) is
// also delivered to the web view underneath: AppKit's hit test and React Native's touch handler
// disagree about which view is under the mouse. The map then sees a tap of its own and acts on it
// (it closed the Layers panel the same instant the button opened it). Accessibility presses send no
// mouse event, which is why they never showed this.
//
// So the app notes where each touch starts: noteTouch() runs for every touch (DuskRoot), noteMapTouch()
// only for touches that start on the map itself. A tap the map reports right after a touch that did
// not start on the map belongs to a control over it, and the map ignores it.

const WINDOW_MS = 700;
let touchAt = 0;
let mapTouchAt = 0;

/** For onStartShouldSetResponderCapture on the app's root: every touch passes through it first. Never claims the touch. */
export function noteTouch(): boolean {
  touchAt = Date.now();
  return false;
}

/** For onStartShouldSetResponderCapture on the view that holds the map. Never claims the touch. */
export function noteMapTouch(): boolean {
  mapTouchAt = Date.now();
  return false;
}

/** True when the latest touch, just now, started on something drawn over the map rather than on the map. */
export function tapWasOnOverlay(now = Date.now()): boolean {
  return now - touchAt < WINDOW_MS && mapTouchAt < touchAt;
}
