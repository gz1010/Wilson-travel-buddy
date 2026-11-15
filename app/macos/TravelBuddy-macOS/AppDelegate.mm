#import "AppDelegate.h"

#import <React/RCTBridgeModule.h>
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

// The older-macOS glass: the light blur, with an optional coloured layer over it for the tint.
@interface BuddyBlurView : NSVisualEffectView
@property (nonatomic, copy) NSColor *buddyTint;
@end

@implementation BuddyBlurView {
  NSView *_tintView;
}

- (void)setBuddyTint:(NSColor *)tint
{
  _buddyTint = [tint copy];
  if (tint == nil) {
    [_tintView removeFromSuperview];
    _tintView = nil;
    return;
  }
  if (_tintView == nil) {
    _tintView = [[NSView alloc] initWithFrame:self.bounds];
    _tintView.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
    _tintView.wantsLayer = YES;
    [self addSubview:_tintView];
  }
  // The whole view is drawn at its alphaValue (0.55, so the photo behind reads through); undo
  // that for the tint so it is as strong as its colour asks, like the tint on Liquid Glass.
  CGFloat alpha = tint.alphaComponent;
  if (self.alphaValue > 0) {
    alpha = MIN(1.0, alpha / self.alphaValue);
  }
  _tintView.layer.backgroundColor = [tint colorWithAlphaComponent:alpha].CGColor;
}
@end

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
  BuddyBlurView *view = [BuddyBlurView new];
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

// A colour the glass leans toward (someone speaking, a live state), as a processed React Native
// colour; none for clear glass. Liquid Glass tints itself (NSGlassEffectView.tintColor); the
// older blur gets a coloured layer over it. Glass.tsx draws the tint in JS only on builds without
// this prop.
RCT_CUSTOM_VIEW_PROPERTY(tintColor, UIColor, NSView)
{
  NSColor *color = (json != nil && json != (id)kCFNull) ? [RCTConvert UIColor:json] : nil;
  Class liquid = NSClassFromString(@"NSGlassEffectView");
  if (liquid != nil && [view isKindOfClass:liquid]) {
    [view setValue:color forKey:@"tintColor"];
  } else if ([view isKindOfClass:[BuddyBlurView class]]) {
    ((BuddyBlurView *)view).buddyTint = color;
  }
}
@end

// BuddyFiles: an itinerary from a file, for Chat's Import (src/ui/dusk/ImportSheet.tsx). React
// Native for macOS has no file picker, so "Open a file" is AppKit's NSOpenPanel, and a file dropped
// on Chat comes here too. The file is read here and only its text goes to JS. No network.
// The app is not sandboxed today: TravelBuddy.entitlements is in the project, but no build setting
// (CODE_SIGN_ENTITLEMENTS) applies it. If it is ever applied, its
// com.apple.security.files.user-selected.read-only covers both ways in: a file picked in the panel
// or dropped on the window.

/** An itinerary is a few kilobytes; a file over this is not one. */
static const unsigned long long kBuddyFilesMaxBytes = 2 * 1024 * 1024;

/** The extensions JS allows (["ics", "txt"]), lower case, without dots. */
static NSSet<NSString *> *BuddyFileExtensions(NSArray *types)
{
  NSMutableSet<NSString *> *set = [NSMutableSet set];
  NSCharacterSet *trim = [NSCharacterSet characterSetWithCharactersInString:@". "];
  for (id t in types) {
    if (![t isKindOfClass:[NSString class]]) {
      continue;
    }
    NSString *ext = [[(NSString *)t lowercaseString] stringByTrimmingCharactersInSet:trim];
    if (ext.length > 0) {
      [set addObject:ext];
    }
  }
  return set;
}

static BOOL BuddyFileAllowed(NSURL *url, NSSet<NSString *> *extensions)
{
  return extensions.count == 0 || [extensions containsObject:url.pathExtension.lowercaseString ?: @""];
}

/** The file's text: UTF-8, else an encoding Foundation recognises (a UTF-16 BOM), else Windows Latin 1. */
static NSString *BuddyReadTextFile(NSURL *url, NSString **problem)
{
  NSNumber *size = nil;
  [url getResourceValue:&size forKey:NSURLFileSizeKey error:nil];
  if (size != nil && size.unsignedLongLongValue > kBuddyFilesMaxBytes) {
    *problem = @"That file is too big for an itinerary (over 2 MB).";
    return nil;
  }
  NSError *error = nil;
  NSData *data = [NSData dataWithContentsOfURL:url options:0 error:&error];
  if (data == nil) {
    *problem = error.localizedDescription ?: @"The file could not be read.";
    return nil;
  }
  if (data.length > kBuddyFilesMaxBytes) {
    *problem = @"That file is too big for an itinerary (over 2 MB).";
    return nil;
  }
  NSString *text = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
  if (text == nil) {
    NSStringEncoding used = 0;
    text = [NSString stringWithContentsOfURL:url usedEncoding:&used error:nil];
  }
  // A NUL byte outside UTF-16 means a binary file, not text.
  if (text == nil && memchr(data.bytes, 0, data.length) == NULL) {
    text = [[NSString alloc] initWithData:data encoding:NSWindowsCP1252StringEncoding];
  }
  if (text == nil) {
    *problem = @"That file isn't text: open a calendar file (.ics) or a text file.";
    return nil;
  }
  // A byte order mark (U+FEFF) left at the start is not part of the itinerary.
  if (text.length > 0 && [text characterAtIndex:0] == 0xFEFF) {
    text = [text substringFromIndex:1];
  }
  return text;
}

/** Reads off the main thread, then resolves { name, text } or rejects with a sentence to show. */
static void BuddyResolveTextFile(NSURL *url, RCTPromiseResolveBlock resolve, RCTPromiseRejectBlock reject)
{
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
    NSString *problem = nil;
    NSString *text = BuddyReadTextFile(url, &problem);
    if (text == nil) {
      reject(@"read_failed", problem ?: @"The file could not be read.", nil);
    } else {
      resolve(@{@"name" : url.lastPathComponent ?: @"", @"text" : text});
    }
  });
}

// Greys out files of other kinds in the panel; folders stay enabled so the person can browse.
@interface BuddyOpenPanelFilter : NSObject <NSOpenSavePanelDelegate>
@property (nonatomic, copy) NSSet<NSString *> *extensions;
@end

@implementation BuddyOpenPanelFilter
- (BOOL)panel:(id)sender shouldEnableURL:(NSURL *)url
{
  NSNumber *isDirectory = nil;
  NSNumber *isPackage = nil;
  [url getResourceValue:&isDirectory forKey:NSURLIsDirectoryKey error:nil];
  [url getResourceValue:&isPackage forKey:NSURLIsPackageKey error:nil];
  if (isDirectory.boolValue) {
    return !isPackage.boolValue;
  }
  return BuddyFileAllowed(url, self.extensions);
}
@end

@interface BuddyFiles : NSObject <RCTBridgeModule>
@end

@implementation BuddyFiles {
  BOOL _picking;
}
RCT_EXPORT_MODULE(BuddyFiles)

+ (BOOL)requiresMainQueueSetup
{
  return NO;
}

// NSOpenPanel is AppKit UI: the methods run on the main thread (the reading itself does not).
- (dispatch_queue_t)methodQueue
{
  return dispatch_get_main_queue();
}

// pickText(["ics", "txt"]): the open panel, as a sheet on the app's window. Resolves
// { name, text } for the file picked, or null when the person cancels.
RCT_EXPORT_METHOD(pickText : (NSArray *)types resolve : (RCTPromiseResolveBlock)resolve reject : (RCTPromiseRejectBlock)reject)
{
  if (_picking) {
    reject(@"busy", @"The file panel is already open.", nil);
    return;
  }
  NSOpenPanel *panel = [NSOpenPanel openPanel];
  panel.canChooseFiles = YES;
  panel.canChooseDirectories = NO;
  panel.allowsMultipleSelection = NO;
  panel.resolvesAliases = YES;
  panel.prompt = @"Import";
  panel.message = @"Choose an itinerary: a calendar file (.ics) or a text file.";
  BuddyOpenPanelFilter *filter = [BuddyOpenPanelFilter new];
  filter.extensions = BuddyFileExtensions(types);
  panel.delegate = filter; // weak: the block below keeps the filter alive until the panel closes
  _picking = YES;
  __weak BuddyFiles *weakSelf = self;
  void (^finish)(NSModalResponse) = ^(NSModalResponse response) {
    BuddyFiles *strongSelf = weakSelf;
    if (strongSelf != nil) {
      strongSelf->_picking = NO;
    }
    panel.delegate = nil;
    (void)filter;
    NSURL *url = response == NSModalResponseOK ? panel.URL : nil;
    if (url == nil) {
      resolve([NSNull null]);
      return;
    }
    BuddyResolveTextFile(url, resolve, reject);
  };
  NSWindow *window = NSApp.keyWindow ?: NSApp.mainWindow;
  if (window != nil) {
    [panel beginSheetModalForWindow:window completionHandler:finish];
  } else {
    finish([panel runModal]);
  }
}

// readText(path, ["ics", "txt"]): a file dropped on Chat (the path from the drop event), read the
// same way. Only the kinds pickText offers.
RCT_EXPORT_METHOD(readText : (NSString *)path types : (NSArray *)types resolve : (RCTPromiseResolveBlock)resolve reject : (RCTPromiseRejectBlock)reject)
{
  NSURL *url = [path hasPrefix:@"file://"] ? [NSURL URLWithString:path] : (path.length > 0 ? [NSURL fileURLWithPath:path] : nil);
  if (url == nil || !url.isFileURL || !BuddyFileAllowed(url, BuddyFileExtensions(types))) {
    reject(@"unsupported", @"Drop a calendar file (.ics) or a text file (.txt).", nil);
    return;
  }
  BuddyResolveTextFile(url, resolve, reject);
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
