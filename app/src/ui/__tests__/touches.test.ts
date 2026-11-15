import { noteMapTouch, noteTouch, tapWasOnOverlay } from '../touches';

describe('telling map taps from clicks on controls over the map', () => {
  it('a touch that starts on a control makes the map ignore the tap it reports', () => {
    noteTouch(); // the root sees it; the map's container does not
    expect(tapWasOnOverlay()).toBe(true);
  });
  it('a touch that starts on the map is the map’s own tap', () => {
    noteTouch();
    noteMapTouch(); // same event, the map's container is on its path
    expect(tapWasOnOverlay()).toBe(false);
  });
  it('a map tap long after the last control click counts again', () => {
    noteTouch();
    expect(tapWasOnOverlay(Date.now() + 2000)).toBe(false);
  });
  it('never claims the touch', () => {
    expect(noteTouch()).toBe(false);
    expect(noteMapTouch()).toBe(false);
  });
});
