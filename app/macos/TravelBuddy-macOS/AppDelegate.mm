#import "AppDelegate.h"

#import <React/RCTBundleURLProvider.h>
#import <React/RCTConvert.h>
#import <React/RCTView.h>
#import <React/RCTViewManager.h>
#import <ReactAppDependencyProvider/RCTAppDependencyProvider.h>
#import <objc/runtime.h>

// BuddyGlassView: the glass behind the Dusk design's cards, chips and buttons.
// On macOS 26 it is Apple's Liquid Glass (NSGlassEffectView: real refraction and edge
// highlights). On older macOS it is a light blur (NSVisualEffectView at reduced opacity, so
// the photo behind stays readable). Both are looked up by name, so this compiles with any SDK.
// Used by src/ui/dusk/Glass.tsx; no React Native glass or blur library supports macOS.
@interface BuddyGlassViewManager : RCTViewManager
@end

@implementation BuddyGlassViewManager
RCT_EXPORT_MODULE(BuddyGlassView)

+ (BOOL)requiresMainQueueSetup
{
  return YES;
}

- (NSDictionary *)constantsToExport
{
  return @{@"liquidGlass" : @(NSClassFromString(@"NSGlassEffectView") != nil)};
}

- (NSView *)view
{
  Class liquid = NSClassFromString(@"NSGlassEffectView");
  if (liquid != nil) {
    return [liquid new];
  }
  NSVisualEffectView *view = [NSVisualEffectView new];
  view.blendingMode = NSVisualEffectBlendingModeWithinWindow;
  view.material = NSVisualEffectMaterialUnderWindowBackground;
  view.state = NSVisualEffectStateActive;
  view.appearance = [NSAppearance appearanceNamed:NSAppearanceNameDarkAqua];
  view.alphaValue = 0.55;
  return view;
}

RCT_CUSTOM_VIEW_PROPERTY(cornerRadius, CGFloat, NSView)
{
  CGFloat radius = json ? [RCTConvert CGFloat:json] : 0;
  if ([view respondsToSelector:NSSelectorFromString(@"setCornerRadius:")]) {
    [view setValue:@(radius) forKey:@"cornerRadius"];
  } else {
    view.wantsLayer = YES;
    view.layer.cornerRadius = radius;
    view.layer.masksToBounds = YES;
  }
}

// "clear" (most transparent: chips, tab bar, pins) or "regular" (a little more frost: cards, primary buttons).
RCT_CUSTOM_VIEW_PROPERTY(glassStyle, NSString, NSView)
{
  if ([view respondsToSelector:NSSelectorFromString(@"setStyle:")]) {
    BOOL clear = [json isKindOfClass:[NSString class]] && [json isEqualToString:@"clear"];
    [view setValue:@(clear ? 1 : 0) forKey:@"style"];
  }
}
@end

// react-native-macos 0.81 keeps RCTView's shadowColor as an unretained CGColorRef
// (`@property (assign) CGColorRef shadowColor`), and RCTConvert's CGColor belongs to an NSColor
// that is released straight away. The next shadowRadius/Opacity/Offset then reads freed memory
// in -didUpdateShadow: EXC_BAD_ACCESS in +[NSColor colorWithCGColor:] when a Dusk screen mounts
// (seen on the Mac, 2026-11-15). Each view keeps its own retained copy of its shadow colour.
static const void *kBuddyShadowColorKey = &kBuddyShadowColorKey;

@implementation RCTView (BuddyRetainedShadowColor)
+ (void)load
{
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    Method m = class_getInstanceMethod(self, @selector(setShadowColor:));
    if (m == NULL) {
      return;
    }
    typedef void (*SetShadowColor)(id, SEL, CGColorRef);
    SetShadowColor original = (SetShadowColor)method_getImplementation(m);
    method_setImplementation(m, imp_implementationWithBlock(^(RCTView *view, CGColorRef color) {
      CGColorRef kept = color != NULL ? CGColorCreateCopy(color) : NULL;
      // The associated object owns the copy for as long as the view points at it.
      objc_setAssociatedObject(view, kBuddyShadowColorKey, kept != NULL ? (__bridge_transfer id)kept : nil,
                               OBJC_ASSOCIATION_RETAIN_NONATOMIC);
      original(view, @selector(setShadowColor:), kept);
    }));
  });
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
