// Clipboard.swift — OS clipboard (NSPasteboard) read/write.
//
// Routed through the sidecar (rather than each TS caller talking to the OS)
// so the desktop app and the headless CLI share one clipboard path. Plain
// text only for Phase 1 — the round-trip the IR needs is "copy → variable →
// paste", which is a string.

import AppKit
import Foundation

enum ClipboardError: Error {
    case writeFailed
}

/// Current pasteboard string, or "" when it holds no text (image-only, empty).
func clipboardReadText() -> String {
    return NSPasteboard.general.string(forType: .string) ?? ""
}

/// Replace the pasteboard contents with `text`. clearContents() is required
/// before setString — without it stale non-string types can linger and some
/// apps paste those instead.
func clipboardWriteText(_ text: String) throws {
    let pb = NSPasteboard.general
    pb.clearContents()
    if !pb.setString(text, forType: .string) {
        throw ClipboardError.writeFailed
    }
}
