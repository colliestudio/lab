//go:build darwin

// Native helpers on the window's WKWebView (Wails exposes the NSWindow, not the web view):
//  - cvEval: callAsyncJavaScript (awaits promises, returns JSON) for readiness checks and camera moves
//  - cvSnapshot: WKWebView takeSnapshotWithConfiguration → PNG (the agent's screenshot)
//  - cvSetRepresentedFile: title bar proxy icon for the open file
#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#include "_cgo_export.h"

static WKWebView *findWebView(NSView *v) {
    if ([v isKindOfClass:[WKWebView class]]) return (WKWebView *)v;
    for (NSView *s in v.subviews) {
        WKWebView *w = findWebView(s);
        if (w) return w;
    }
    return nil;
}

void cvEval(void *nswin, const char *body, uintptr_t handle) {
    NSString *js = [NSString stringWithUTF8String:body];
    dispatch_async(dispatch_get_main_queue(), ^{
        NSWindow *win = (__bridge NSWindow *)nswin;
        WKWebView *wv = findWebView(win.contentView);
        if (!wv) { cvEvalDone(handle, NULL, (char *)"no web view"); return; }
        NSString *wrapped = [NSString stringWithFormat:@"return JSON.stringify(await (async () => { %@ })())", js];
        [wv callAsyncJavaScript:wrapped arguments:nil inFrame:nil inContentWorld:WKContentWorld.pageWorld
              completionHandler:^(id result, NSError *error) {
            if (error) { cvEvalDone(handle, NULL, (char *)error.description.UTF8String); return; }
            NSString *s = [result isKindOfClass:[NSString class]] ? result : @"null";
            cvEvalDone(handle, (char *)s.UTF8String, NULL);
        }];
    });
}

void cvSnapshot(void *nswin, double width, uintptr_t handle) {
    dispatch_async(dispatch_get_main_queue(), ^{
        NSWindow *win = (__bridge NSWindow *)nswin;
        WKWebView *wv = findWebView(win.contentView);
        if (!wv) { cvSnapshotDone(handle, NULL, 0, 0, 0, (char *)"no web view"); return; }
        WKSnapshotConfiguration *cfg = [[WKSnapshotConfiguration alloc] init];
        cfg.afterScreenUpdates = YES;
        if (width > 0) cfg.snapshotWidth = @(width);
        [wv takeSnapshotWithConfiguration:cfg completionHandler:^(NSImage *img, NSError *error) {
            if (!img) {
                cvSnapshotDone(handle, NULL, 0, 0, 0, (char *)(error ? error.description.UTF8String : "no image"));
                return;
            }
            // 1 image pixel per CSS pixel (a Retina snapshot is 2x: 4x the bytes and tokens for the agent)
            NSInteger pw = (NSInteger)llround(img.size.width), ph = (NSInteger)llround(img.size.height);
            NSBitmapImageRep *rep = [[NSBitmapImageRep alloc] initWithBitmapDataPlanes:NULL pixelsWide:pw pixelsHigh:ph
                bitsPerSample:8 samplesPerPixel:4 hasAlpha:YES isPlanar:NO colorSpaceName:NSDeviceRGBColorSpace bytesPerRow:0 bitsPerPixel:0];
            rep.size = NSMakeSize(pw, ph);
            [NSGraphicsContext saveGraphicsState];
            NSGraphicsContext *ctx = [NSGraphicsContext graphicsContextWithBitmapImageRep:rep];
            [NSGraphicsContext setCurrentContext:ctx];
            ctx.imageInterpolation = NSImageInterpolationHigh;
            [img drawInRect:NSMakeRect(0, 0, pw, ph) fromRect:NSZeroRect operation:NSCompositingOperationCopy fraction:1.0];
            [NSGraphicsContext restoreGraphicsState];
            NSData *png = [rep representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
            cvSnapshotDone(handle, (void *)png.bytes, (int)png.length, (int)pw, (int)ph, NULL);
        }];
    });
}

void cvSetRepresentedFile(void *nswin, const char *path) {
    NSString *p = [NSString stringWithUTF8String:path];
    dispatch_async(dispatch_get_main_queue(), ^{
        NSWindow *win = (__bridge NSWindow *)nswin;
        [win setRepresentedFilename:p];
        [[NSDocumentController sharedDocumentController] noteNewRecentDocumentURL:[NSURL fileURLWithPath:p]];
    });
}

// Window state for diagnostics: visible? occluded? on which screen?
void cvWindowState(void *nswin, char *out, int n) {
    __block NSString *s;
    dispatch_sync(dispatch_get_main_queue(), ^{
        NSWindow *win = (__bridge NSWindow *)nswin;
        s = [NSString stringWithFormat:@"visible=%d occlusionVisible=%d frame=%@ backingScale=%.1f",
             win.isVisible, (win.occlusionState & NSWindowOcclusionStateVisible) != 0,
             NSStringFromRect(win.frame), win.backingScaleFactor];
    });
    strncpy(out, s.UTF8String, n - 1);
    out[n - 1] = 0;
}
