// CGEvent-based mouse and keyboard input.
//
// All operations require Accessibility permission (Input Monitoring is
// not strictly required for posting events, but the user must have
// granted Accessibility for events to take effect against other apps).

import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

enum InputError: Error {
    case eventCreationFailed
    case permissionDenied
}

func postClick(x: Double, y: Double, button: String, clickCount: Int) throws {
    let point = CGPoint(x: x, y: y)
    let cgButton: CGMouseButton
    let downType: CGEventType
    let upType: CGEventType
    switch button {
    case "right":
        cgButton = .right; downType = .rightMouseDown; upType = .rightMouseUp
    case "middle":
        cgButton = .center; downType = .otherMouseDown; upType = .otherMouseUp
    default:
        cgButton = .left; downType = .leftMouseDown; upType = .leftMouseUp
    }

    guard let down = CGEvent(mouseEventSource: nil, mouseType: downType, mouseCursorPosition: point, mouseButton: cgButton) else {
        throw InputError.eventCreationFailed
    }
    guard let up = CGEvent(mouseEventSource: nil, mouseType: upType, mouseCursorPosition: point, mouseButton: cgButton) else {
        throw InputError.eventCreationFailed
    }
    let count = max(1, clickCount)
    down.setIntegerValueField(.mouseEventClickState, value: Int64(count))
    up.setIntegerValueField(.mouseEventClickState, value: Int64(count))
    for _ in 0..<count {
        down.post(tap: .cghidEventTap)
        up.post(tap: .cghidEventTap)
        usleep(20_000) // 20ms
    }
}

func postMouseMove(x: Double, y: Double) throws {
    let point = CGPoint(x: x, y: y)
    guard let event = CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left) else {
        throw InputError.eventCreationFailed
    }
    event.post(tap: .cghidEventTap)
}

func postType(_ text: String, intervalMs: Int = 0) throws {
    // CGEventKeyboardSetUnicodeString lets us send any UTF-16 string in
    // one event pair (down/up) per character. This bypasses keyboard
    // layout mapping, so it works for Japanese, emoji, etc.
    for scalar in text.unicodeScalars {
        var unichars: [UniChar] = []
        if scalar.value < 0x10000 {
            unichars.append(UniChar(scalar.value))
        } else {
            // surrogate pair
            let v = scalar.value - 0x10000
            let high = 0xD800 + (v >> 10)
            let low = 0xDC00 + (v & 0x3FF)
            unichars.append(UniChar(high))
            unichars.append(UniChar(low))
        }

        guard let down = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true) else {
            throw InputError.eventCreationFailed
        }
        guard let up = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false) else {
            throw InputError.eventCreationFailed
        }
        down.keyboardSetUnicodeString(stringLength: unichars.count, unicodeString: unichars)
        up.keyboardSetUnicodeString(stringLength: unichars.count, unicodeString: unichars)
        down.post(tap: .cghidEventTap)
        up.post(tap: .cghidEventTap)
        if intervalMs > 0 { usleep(useconds_t(intervalMs * 1000)) }
    }
}

// Map a friendly key name to a macOS virtual key code (kVK_*).
private let virtualKeyMap: [String: Int] = [
    "return": 0x24, "enter": 0x24, "tab": 0x30, "space": 0x31,
    "delete": 0x33, "backspace": 0x33, "escape": 0x35, "esc": 0x35,
    "leftarrow": 0x7B, "rightarrow": 0x7C, "downarrow": 0x7D, "uparrow": 0x7E,
    "left": 0x7B, "right": 0x7C, "down": 0x7D, "up": 0x7E,
    "home": 0x73, "end": 0x77, "pageup": 0x74, "pagedown": 0x79,
    "f1": 0x7A, "f2": 0x78, "f3": 0x63, "f4": 0x76,
    "f5": 0x60, "f6": 0x61, "f7": 0x62, "f8": 0x64,
    "f9": 0x65, "f10": 0x6D, "f11": 0x67, "f12": 0x6F,
    "a": 0x00, "s": 0x01, "d": 0x02, "f": 0x03, "h": 0x04, "g": 0x05,
    "z": 0x06, "x": 0x07, "c": 0x08, "v": 0x09, "b": 0x0B, "q": 0x0C,
    "w": 0x0D, "e": 0x0E, "r": 0x0F, "y": 0x10, "t": 0x11,
    "1": 0x12, "2": 0x13, "3": 0x14, "4": 0x15, "6": 0x16, "5": 0x17,
    "=": 0x18, "9": 0x19, "7": 0x1A, "-": 0x1B, "8": 0x1C, "0": 0x1D,
    "]": 0x1E, "o": 0x1F, "u": 0x20, "[": 0x21, "i": 0x22, "p": 0x23,
    "l": 0x25, "j": 0x26, "'": 0x27, "k": 0x28, ";": 0x29, "\\": 0x2A,
    ",": 0x2B, "/": 0x2C, "n": 0x2D, "m": 0x2E, ".": 0x2F, "`": 0x32,
]

private let modifierMap: [String: CGEventFlags] = [
    "cmd": .maskCommand, "command": .maskCommand, "meta": .maskCommand, "primary": .maskCommand,
    "ctrl": .maskControl, "control": .maskControl,
    "alt": .maskAlternate, "option": .maskAlternate,
    "shift": .maskShift,
    "fn": .maskSecondaryFn,
]

func postKeyCombo(keys: [String]) throws {
    var modifiers: CGEventFlags = []
    var letter: Int? = nil
    for raw in keys {
        let k = raw.lowercased()
        if let m = modifierMap[k] {
            modifiers.insert(m)
            continue
        }
        if let vk = virtualKeyMap[k] {
            letter = vk
        } else if k.count == 1, let vk = virtualKeyMap[k.lowercased()] {
            letter = vk
        }
    }
    guard let vk = letter else { throw InputError.eventCreationFailed }
    guard let down = CGEvent(keyboardEventSource: nil, virtualKey: CGKeyCode(vk), keyDown: true) else {
        throw InputError.eventCreationFailed
    }
    guard let up = CGEvent(keyboardEventSource: nil, virtualKey: CGKeyCode(vk), keyDown: false) else {
        throw InputError.eventCreationFailed
    }
    down.flags = modifiers
    up.flags = modifiers
    down.post(tap: .cghidEventTap)
    up.post(tap: .cghidEventTap)
}

func mainScreenSize() -> JSONValue {
    if let screen = NSScreen.main {
        let f = screen.frame
        return .object([
            "w": .double(f.width),
            "h": .double(f.height),
            "scale": .double(screen.backingScaleFactor),
        ])
    }
    return .null
}
