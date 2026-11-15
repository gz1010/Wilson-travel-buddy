#import "AppDelegate.h"

#import <React/RCTBundleURLProvider.h>
#import <React/RCTViewManager.h>
#import <ReactAppDependencyProvider/RCTAppDependencyProvider.h>

// BuddyBlurView: the Mac's own blur (NSVisualEffectView), for the Dusk liquid-glass design.
// It blurs whatever is behind it inside the window. Used by src/ui/dusk/Glass.tsx; no
// React Native blur library supports macOS.
@interface BuddyBlurViewManager : RCTViewManager
@end

@implementation BuddyBlurViewManager
RCT_EXPORT_MODULE(BuddyBlurView)
- (NSView *)view
{
  NSVisualEffectView *view = [NSVisualEffectView new];
  view.blendingMode = NSVisualEffectBlendingModeWithinWindow;
  view.material = NSVisualEffectMaterialHUDWindow;
  view.state = NSVisualEffectStateActive;
  view.appearance = [NSAppearance appearanceNamed:NSAppearanceNameDarkAqua];
  return view;
}
@end

@implementation AppDelegate

- (void)applicationDidFinishLaunching:(NSNotification *)notification
{
  self.moduleName = @"TravelBuddy";
  // You can add your custom initial props in the dictionary below.
  // They will be passed down to the ViewController used by React Native.
  self.initialProps = @{};
  self.dependencyProvider = [RCTAppDependencyProvider new];
  
  [super applicationDidFinishLaunching:notification];

  // The Dusk design is laid out for a phone: open a phone-shaped window.
  dispatch_async(dispatch_get_main_queue(), ^{
    NSWindow *window = NSApplication.sharedApplication.windows.firstObject;
    if (window == nil) {
      return;
    }
    [window setContentSize:NSMakeSize(430, 900)];
    window.contentMinSize = NSMakeSize(390, 700);
    window.appearance = [NSAppearance appearanceNamed:NSAppearanceNameDarkAqua];
    window.backgroundColor = [NSColor colorWithRed:14 / 255.0 green:15 / 255.0 blue:20 / 255.0 alpha:1];
    [window center];
  });
}

- (NSURL *)sourceURLForBridge:(RCTBridge *)bridge
{
  return [self bundleURL];
}

- (NSURL *)bundleURL
{
#if DEBUG
  return [[RCTBundleURLProvider sharedSettings] jsBundleURLForBundleRoot:@"index"];
#else
  return [[NSBundle mainBundle] URLForResource:@"main" withExtension:@"jsbundle"];
#endif
}

/// This method controls whether the `concurrentRoot`feature of React18 is turned on or off.
///
/// @see: https://reactjs.org/blog/2022/03/29/react-v18.html
/// @note: This requires to be rendering on Fabric (i.e. on the New Architecture).
/// @return: `true` if the `concurrentRoot` feature is enabled. Otherwise, it returns `false`.
- (BOOL)concurrentRootEnabled
{
#ifdef RN_FABRIC_ENABLED
  return true;
#else
  return false;
#endif
}

@end
