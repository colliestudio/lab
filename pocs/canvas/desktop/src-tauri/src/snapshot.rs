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
pub fn make_invisible(win: &WebviewWindow) {
    if let Ok(ns) = win.ns_window() {
        let ns = ns as usize;
        let _ = win.run_on_main_thread(move || unsafe { mac::invisible(ns as *mut std::ffi::c_void) });
    }
}
