//go:build darwin

package main

/*
#cgo CFLAGS: -x objective-c -fobjc-arc
#cgo LDFLAGS: -framework Cocoa -framework WebKit
#include <stdint.h>
#include <stdlib.h>
void cvEval(void *nswin, const char *body, uintptr_t handle);
void cvSnapshot(void *nswin, double width, uintptr_t handle);
void cvSetRepresentedFile(void *nswin, const char *path);
void cvWindowState(void *nswin, char *out, int n);
*/
import "C"

import (
	"errors"
	"runtime/cgo"
	"time"
	"unsafe"
)

type evalResult struct {
	json string
	err  error
}

type snapResult struct {
	png  []byte
	w, h int
	err  error
}

//export cvEvalDone
func cvEvalDone(handle C.uintptr_t, result *C.char, errStr *C.char) {
	h := cgo.Handle(handle)
	ch := h.Value().(chan evalResult)
	h.Delete()
	if errStr != nil {
		ch <- evalResult{err: errors.New(C.GoString(errStr))}
		return
	}
	ch <- evalResult{json: C.GoString(result)}
}

//export cvSnapshotDone
func cvSnapshotDone(handle C.uintptr_t, data unsafe.Pointer, n C.int, w C.int, hgt C.int, errStr *C.char) {
	h := cgo.Handle(handle)
	ch := h.Value().(chan snapResult)
	h.Delete()
	if errStr != nil {
		ch <- snapResult{err: errors.New(C.GoString(errStr))}
		return
	}
	ch <- snapResult{png: C.GoBytes(data, n), w: int(w), h: int(hgt)}
}

// evalJS runs an async function body in the page (use `return`), result as JSON text.
func evalJS(nswin unsafe.Pointer, body string, timeout time.Duration) (string, error) {
	ch := make(chan evalResult, 1)
	cs := C.CString(body)
	defer C.free(unsafe.Pointer(cs))
	C.cvEval(nswin, cs, C.uintptr_t(cgo.NewHandle(ch)))
	select {
	case r := <-ch:
		return r.json, r.err
	case <-time.After(timeout):
		return "", errors.New("eval timed out")
	}
}

// snapshot captures the web view as PNG (width in points; 0 = view width).
func snapshot(nswin unsafe.Pointer, width float64, timeout time.Duration) ([]byte, int, int, error) {
	ch := make(chan snapResult, 1)
	C.cvSnapshot(nswin, C.double(width), C.uintptr_t(cgo.NewHandle(ch)))
	select {
	case r := <-ch:
		return r.png, r.w, r.h, r.err
	case <-time.After(timeout):
		return nil, 0, 0, errors.New("snapshot timed out (web view not rendering?)")
	}
}

func setRepresentedFile(nswin unsafe.Pointer, path string) {
	cs := C.CString(path)
	defer C.free(unsafe.Pointer(cs))
	C.cvSetRepresentedFile(nswin, cs)
}

func windowState(nswin unsafe.Pointer) string {
	buf := make([]byte, 256)
	C.cvWindowState(nswin, (*C.char)(unsafe.Pointer(&buf[0])), 256)
	return C.GoString((*C.char)(unsafe.Pointer(&buf[0])))
}
