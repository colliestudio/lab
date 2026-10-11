// WKWebView access the Tauri API doesn't offer: evaluate JS *with a result*, and takeSnapshot → PNG.
// Both run on the main thread (with_webview) and answer through a completion block; callers (worker
// threads) wait on a channel. macOS only; other platforms: see ideas/desktop-tauri.md (WebView2 has
// CapturePreview, WebKitGTK has webkit_web_view_get_snapshot: same shape, different code).

use std::sync::mpsc;
use std::time::Duration;
use tauri::WebviewWindow;

#[cfg(target_os = "macos")]
mod mac {
    use block2::RcBlock;
    use objc2::runtime::AnyObject;
    use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep, NSImage};
    use objc2_foundation::{NSDictionary, NSError, NSNumber, NSString};
    use objc2_web_kit::{WKSnapshotConfiguration, WKWebView};
    use std::sync::mpsc::Sender;

    pub unsafe fn eval(wk: *mut std::ffi::c_void, js: &str, tx: Sender<Result<String, String>>) {
        let wk = &*(wk as *const WKWebView);
        let block = RcBlock::new(move |obj: *mut AnyObject, err: *mut NSError| {
            let r = if !err.is_null() {
                Err((*err).localizedDescription().to_string())
            } else if obj.is_null() {
                Ok(String::new())
            } else if let Some(s) = (*obj).downcast_ref::<NSString>() {
                Ok(s.to_string())
            } else {
                Ok(format!("{:?}", &*obj))
            };
            let _ = tx.send(r);
        });
        wk.evaluateJavaScript_completionHandler(&NSString::from_str(js), Some(&block));
    }

    pub unsafe fn snapshot(wk: *mut std::ffi::c_void, width_pt: f64, tx: Sender<Result<Vec<u8>, String>>) {
        let wk = &*(wk as *const WKWebView);
        let mtm = objc2::MainThreadMarker::new().expect("main thread");
        let cfg = WKSnapshotConfiguration::new(mtm);
        // the output is width_pt * backing scale pixels wide; ask for the view's width at 1x pixels
        // when the screen is Retina so images stay ~1k tokens (scale handled by the caller via width)
        cfg.setSnapshotWidth(Some(&NSNumber::new_f64(width_pt)));
        cfg.setAfterScreenUpdates(true);
        let block = RcBlock::new(move |img: *mut NSImage, err: *mut NSError| {
            let r = if !err.is_null() {
                Err(format!("takeSnapshot: {}", (*err).localizedDescription()))
            } else if img.is_null() {
                Err("takeSnapshot returned no image".into())
            } else {
                (|| {
                    let tiff = (*img).TIFFRepresentation().ok_or("no TIFF representation")?;
                    let rep = NSBitmapImageRep::imageRepWithData(&tiff).ok_or("no bitmap rep")?;
                    let png = rep.representationUsingType_properties(NSBitmapImageFileType::PNG, &NSDictionary::new()).ok_or("PNG encoding failed")?;
                    Ok::<_, String>(png.to_vec())
                })()
            };
            let _ = tx.send(r);
        });
        wk.takeSnapshotWithConfiguration_completionHandler(Some(&cfg), &block);
    }

    /// Ask WebKit to keep a hidden/occluded view running: the public inactive-scheduling policy
    /// (macOS 14+, timers/JS) and the private occlusion switch (rendering + rAF). Returns what took.
    pub unsafe fn keep_rendering(wk: *mut std::ffi::c_void) -> String {
        use objc2::{msg_send, sel};
        use objc2_foundation::NSObjectProtocol;
        use objc2_web_kit::WKInactiveSchedulingPolicy;
        let wk = &*(wk as *const WKWebView);
        let mut done = vec![];
        let prefs = wk.configuration().preferences();
        if prefs.respondsToSelector(sel!(setInactiveSchedulingPolicy:)) {
            prefs.setInactiveSchedulingPolicy(WKInactiveSchedulingPolicy::None);
            done.push("inactiveSchedulingPolicy=none");
        }
        if wk.respondsToSelector(sel!(_setWindowOcclusionDetectionEnabled:)) {
            let _: () = msg_send![wk, _setWindowOcclusionDetectionEnabled: false];
            done.push("SPI _setWindowOcclusionDetectionEnabled:NO");
        }
        done.join(", ")
    }

    /// WebContent process of this view (SPI `_webProcessIdentifier`), for memory accounting.
    pub unsafe fn web_pid(wk: *mut std::ffi::c_void) -> i32 {
        use objc2::{msg_send, sel};
        use objc2_foundation::NSObjectProtocol;
        let wk = &*(wk as *const WKWebView);
        if wk.respondsToSelector(sel!(_webProcessIdentifier)) {
            msg_send![wk, _webProcessIdentifier]
        } else {
            -1
        }
    }

    /// GPU process (SPI `_gpuProcessIdentifier`), shared by the app's views.
    pub unsafe fn gpu_pid(wk: *mut std::ffi::c_void) -> i32 {
        use objc2::{msg_send, sel};
        use objc2_foundation::NSObjectProtocol;
        let wk = &*(wk as *const WKWebView);
        if wk.respondsToSelector(sel!(_gpuProcessIdentifier)) {
            msg_send![wk, _gpuProcessIdentifier]
        } else {
            -1
        }
    }

    pub unsafe fn invisible(ns_window: *mut std::ffi::c_void) {
        let w = &*(ns_window as *const objc2_app_kit::NSWindow);
        w.setAlphaValue(0.0);
        w.setIgnoresMouseEvents(true);
    }
}

/// Run JS in the page and get its result as a string (JS should return a string).
pub fn eval_js(win: &WebviewWindow, js: &str) -> Result<String, String> {
    let (tx, rx) = mpsc::channel();
    let js = js.to_string();
    #[cfg(target_os = "macos")]
    win.with_webview(move |pv| unsafe { mac::eval(pv.inner(), &js, tx) }).map_err(|e| e.to_string())?;
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (win, js, tx);
        return Err("eval_js: macOS only in this spike".into());
    }
    rx.recv_timeout(Duration::from_secs(5)).map_err(|_| "eval_js: no answer within 5 s (page suspended?)".to_string())?
}

/// PNG of what the webview shows (its own rendering, incl. composited iframes).
pub fn snapshot_png(win: &WebviewWindow, width_pt: f64) -> Result<Vec<u8>, String> {
    let (tx, rx) = mpsc::channel();
    #[cfg(target_os = "macos")]
    win.with_webview(move |pv| unsafe { mac::snapshot(pv.inner(), width_pt, tx) }).map_err(|e| e.to_string())?;
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (win, width_pt, tx);
        return Err("snapshot: macOS only in this spike".into());
    }
    rx.recv_timeout(Duration::from_secs(10)).map_err(|_| "snapshot: no image within 10 s".to_string())?
}

#[cfg(target_os = "macos")]
pub fn keep_rendering(win: &WebviewWindow) -> String {
    let (tx, rx) = mpsc::channel();
    let _ = win.with_webview(move |pv| {
        let _ = tx.send(unsafe { mac::keep_rendering(pv.inner()) });
    });
    rx.recv_timeout(Duration::from_secs(2)).unwrap_or_default()
}

/// (WebContent pid, GPU pid) behind this window.
pub fn web_pid(win: &WebviewWindow) -> (i32, i32) {
    let (tx, rx) = mpsc::channel();
    #[cfg(target_os = "macos")]
    let _ = win.with_webview(move |pv| {
        let _ = tx.send(unsafe { (mac::web_pid(pv.inner()), mac::gpu_pid(pv.inner())) });
    });
    #[cfg(not(target_os = "macos"))]
    let _ = (win, tx);
    rx.recv_timeout(Duration::from_secs(2)).unwrap_or((-1, -1))
}

#[cfg(target_os = "macos")]
pub fn make_invisible(win: &WebviewWindow) {
    if let Ok(ns) = win.ns_window() {
        let ns = ns as usize;
        let _ = win.run_on_main_thread(move || unsafe { mac::invisible(ns as *mut std::ffi::c_void) });
    }
}
