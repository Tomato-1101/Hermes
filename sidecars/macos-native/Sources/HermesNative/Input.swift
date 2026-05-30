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

/// Return the current cursor location in Quartz coordinates (origin
/// top-left, matching CGEvent's coordinate space). NSEvent.mouseLocation
/// is Cocoa (origin bottom-left of the screen frame), so we flip Y against
/// the bottom of the screen that contains the cursor.
func currentMousePosition() -> CGPoint {
    let cocoa = NSEvent.mouseLocation
    let containing = NSScreen.screens.first(where: { NSPointInRect(cocoa, $0.frame) })
        ?? NSScreen.main
    guard let screen = containing else { return CGPoint(x: cocoa.x, y: cocoa.y) }
    let frame = screen.frame
    let quartzY = (frame.origin.y + frame.size.height) - cocoa.y
    return CGPoint(x: cocoa.x, y: quartzY)
}

// Cached mach timebase: converts nanoseconds to host ticks for
// mach_wait_until. mach_timebase_info on Apple silicon returns 125/3
// (i.e. 1 tick ≈ 41.66ns), so we must convert — passing raw ns to
// mach_wait_until would otherwise wake 24× too early.
private var _mt_inited = false
private var _mt = mach_timebase_info_data_t()

private func nanosToHostTicks(_ ns: UInt64) -> UInt64 {
    if !_mt_inited {
        mach_timebase_info(&_mt)
        _mt_inited = true
    }
    return ns * UInt64(_mt.denom) / UInt64(_mt.numer)
}

/// Linearly interpolate the cursor from its current position to (toX, toY)
/// over `durationMs` milliseconds at **constant velocity**, posting one
/// `.mouseMoved` event per step. Returns a small dict of measurements
/// the TS side logs so the user can see actual vs requested fps.
///
/// Four optimisations matter here — without them a "250 fps" loop shows
/// up on screen as 30 fps, which is what the user reported:
///
///   1. Reuse ONE CGEvent across the loop. Allocating a new one each
///      step costs ~100-200µs; at 6ms-frame cadence that's a third of
///      the budget.
///
///   2. Stamp .mouseEventDeltaX/Y on every post. Without explicit deltas,
///      the WindowServer coalesces same-frame mouseMoved events into one
///      visual update, so a 166 Hz stream collapses to the display
///      refresh rate. Setting deltas tells it these are distinct motions.
///
///   3. Bump the thread to .userInteractive QoS for the move. The
///      JSON-RPC main thread runs at .userInitiated by default, which
///      lets mach_wait_until slip by 500µs-2ms under any system load.
///
///   4. Hybrid sleep: kernel wait gets us close, then busy-spin the
///      final ~150µs. mach_wait_until's wake jitter dominates sub-ms
///      deadlines; busy-spin is the only way to land on time.
func postMouseMoveSmooth(toX: Double, toY: Double, durationMs: Int, steps: Int) throws -> JSONValue {
    let safeSteps = max(1, steps)
    let totalNs = UInt64(max(1, durationMs)) * 1_000_000
    let from = currentMousePosition()
    let dx = toX - Double(from.x)
    let dy = toY - Double(from.y)

    // (3) Raise QoS so the scheduler prioritises our wake-ups.
    let prevQos = Thread.current.qualityOfService
    Thread.current.qualityOfService = .userInteractive
    defer { Thread.current.qualityOfService = prevQos }

    // (1) Single CGEvent re-posted with mutated fields.
    guard let event = CGEvent(
        mouseEventSource: nil,
        mouseType: .mouseMoved,
        mouseCursorPosition: from,
        mouseButton: .left
    ) else {
        throw InputError.eventCreationFailed
    }

    let startTicks = mach_absolute_time()
    let spinThresholdTicks = nanosToHostTicks(150_000) // 150µs busy-spin floor
    var prevX = Double(from.x)
    var prevY = Double(from.y)
    var maxSlipNs: Int64 = 0

    for i in 1...safeSteps {
        let t = Double(i) / Double(safeSteps)
        let x = Double(from.x) + dx * t
        let y = Double(from.y) + dy * t

        // (1) Update location on the shared event instead of allocating.
        event.location = CGPoint(x: x, y: y)
        // (2) Explicit delta so WindowServer doesn't coalesce.
        let ddx = Int64((x - prevX).rounded())
        let ddy = Int64((y - prevY).rounded())
        event.setIntegerValueField(.mouseEventDeltaX, value: ddx)
        event.setIntegerValueField(.mouseEventDeltaY, value: ddy)
        prevX = x; prevY = y

        event.post(tap: .cghidEventTap)

        if i < safeSteps {
            let deadlineNs = UInt64(Double(totalNs) * t)
            let deadlineTicks = startTicks + nanosToHostTicks(deadlineNs)
            // (4) Hybrid sleep: kernel for the bulk, spin for the last ~150µs.
            let now = mach_absolute_time()
            if deadlineTicks > now + spinThresholdTicks {
                mach_wait_until(deadlineTicks - spinThresholdTicks)
            }
            while mach_absolute_time() < deadlineTicks { /* busy-spin */ }
            let slipTicks = Int64(mach_absolute_time()) - Int64(deadlineTicks)
            if slipTicks > 0 {
                let slipNs = slipTicks * Int64(_mt.numer) / Int64(_mt.denom)
                if slipNs > maxSlipNs { maxSlipNs = slipNs }
            }
        }
    }

    let totalDurationTicks = mach_absolute_time() - startTicks
    let totalDurationNs = totalDurationTicks * UInt64(_mt.numer) / UInt64(_mt.denom)
    let actualFps =
        totalDurationNs > 0
            ? Double(safeSteps) * 1_000_000_000.0 / Double(totalDurationNs)
            : 0.0
    return .object([
        "ok": .bool(true),
        "actualFps": .double(actualFps),
        "maxSlipMs": .double(Double(maxSlipNs) / 1_000_000.0),
        "steps": .int(safeSteps),
        "durationMs": .double(Double(totalDurationNs) / 1_000_000.0),
    ])
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
