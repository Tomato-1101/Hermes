// Recording.swift — CGEventTap-based desktop recorder.
//
// Captures left mouse clicks and modifier-key shortcuts globally via
// CGEventTap. Each captured event is enriched with an AX snapshot of the
// element under the cursor (best-effort — some apps don't expose AX), then
// pushed into a thread-safe queue.
//
// Consumption model is polling: main.swift exposes `recording.poll` which
// drains the queue and returns the events to the TS host. We chose polling
// over server push so the existing one-shot JSON-RPC protocol in main.swift
// doesn't need to grow notification support for this MVP.
//
// Threading:
//   - CGEventTap requires a CFRunLoop. We spawn a dedicated worker thread,
//     give it its own RunLoop, install the tap there, and call CFRunLoopRun.
//   - Event callbacks run on that worker thread.
//   - The queue is guarded by an `NSLock` so the JSON-RPC handler thread can
//     drain it safely.

import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

enum RecordingError: Error {
    case alreadyRecording
    case notRecording
    case permissionDenied
    case tapCreateFailed
}

final class Recorder {
    static let shared = Recorder()

    private var eventTap: CFMachPort?
    private var runLoopSource: CFRunLoopSource?
    private var workerRunLoop: CFRunLoop?
    private var workerThread: Thread?

    private let queueLock = NSLock()
    private var queue: [JSONValue] = []
    private var nextSeq: Int = 0

    private var isActive = false

    private init() {}

    func start() throws {
        if isActive { throw RecordingError.alreadyRecording }
        if !axPermissionGranted() { throw RecordingError.permissionDenied }

        // Spin up a worker thread that owns the CFRunLoop on which the tap runs.
        let startSemaphore = DispatchSemaphore(value: 0)
        var createError: RecordingError?

        let thread = Thread { [weak self] in
            guard let self = self else { return }
            let runLoop = CFRunLoopGetCurrent()

            let mask: CGEventMask =
                (1 << CGEventType.leftMouseDown.rawValue) |
                (1 << CGEventType.keyDown.rawValue)

            // The userInfo pointer is read inside the C callback; we pass an
            // unmanaged reference to `self` so the callback can call back.
            let userInfo = Unmanaged.passUnretained(self).toOpaque()

            guard let tap = CGEvent.tapCreate(
                tap: .cgSessionEventTap,
                place: .headInsertEventTap,
                options: .listenOnly,
                eventsOfInterest: mask,
                callback: recordingTapCallback,
                userInfo: userInfo
            ) else {
                createError = .tapCreateFailed
                startSemaphore.signal()
                return
            }

            let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
            CFRunLoopAddSource(runLoop, source, .commonModes)
            CGEvent.tapEnable(tap: tap, enable: true)

            self.eventTap = tap
            self.runLoopSource = source
            self.workerRunLoop = runLoop

            startSemaphore.signal()
            CFRunLoopRun() // blocks until CFRunLoopStop is called from stop()
        }
        thread.name = "hermes-recording-tap"
        thread.start()
        workerThread = thread

        // Wait up to 1s for the tap to install — surfaces permission errors
        // synchronously instead of letting recording.start return success
        // for a tap that never armed.
        _ = startSemaphore.wait(timeout: .now() + .seconds(1))
        if let err = createError {
            throw err
        }
        if eventTap == nil {
            throw RecordingError.tapCreateFailed
        }
        isActive = true
    }

    func stop() throws {
        if !isActive { throw RecordingError.notRecording }
        if let tap = eventTap {
            CGEvent.tapEnable(tap: tap, enable: false)
        }
        if let runLoop = workerRunLoop {
            CFRunLoopStop(runLoop)
        }
        // Drop CF refs — the thread will exit and ARC reclaims everything.
        eventTap = nil
        runLoopSource = nil
        workerRunLoop = nil
        workerThread = nil
        isActive = false
    }

    func isRecording() -> Bool {
        isActive
    }

    func drain() -> [JSONValue] {
        queueLock.lock()
        defer { queueLock.unlock() }
        let out = queue
        queue.removeAll(keepingCapacity: true)
        return out
    }

    fileprivate func enqueue(_ event: JSONValue) {
        queueLock.lock()
        queue.append(event)
        queueLock.unlock()
    }

    fileprivate func nextSequence() -> Int {
        queueLock.lock()
        defer { queueLock.unlock() }
        nextSeq += 1
        return nextSeq
    }
}

// MARK: - CGEventTap callback

private let recordingTapCallback: CGEventTapCallBack = {
    (_ proxy: CGEventTapProxy,
     _ type: CGEventType,
     _ event: CGEvent,
     _ userInfo: UnsafeMutableRawPointer?) -> Unmanaged<CGEvent>? in

    guard let info = userInfo else { return Unmanaged.passUnretained(event) }
    let recorder = Unmanaged<Recorder>.fromOpaque(info).takeUnretainedValue()

    // listenOnly taps must always return the event unmodified.
    let passThrough = Unmanaged.passUnretained(event)

    let seq = recorder.nextSequence()
    let ts = Date().timeIntervalSince1970

    switch type {
    case .leftMouseDown:
        let loc = event.location
        var fields: [String: JSONValue] = [
            "seq": .int(seq),
            "kind": .string("click"),
            "button": .string("left"),
            "x": .double(loc.x),
            "y": .double(loc.y),
            "ts": .double(ts),
        ]
        // Best effort: AX snapshot of the element under the cursor.
        if let snap = try? elementAtPoint(x: loc.x, y: loc.y) {
            fields["element"] = snap
        }
        recorder.enqueue(.object(fields))

    case .keyDown:
        let keyCode = event.getIntegerValueField(.keyboardEventKeycode)
        let flags = event.flags
        // Only record modifier-key combos to avoid drowning the IR in raw
        // keystrokes (typing into a text field is captured as a separate
        // 'change'-style event in a future phase).
        let hasMod = flags.contains(.maskCommand) || flags.contains(.maskControl) || flags.contains(.maskAlternate)
        guard hasMod else { return passThrough }

        var keys: [JSONValue] = []
        if flags.contains(.maskCommand) { keys.append(.string("meta")) }
        if flags.contains(.maskControl) { keys.append(.string("ctrl")) }
        if flags.contains(.maskAlternate) { keys.append(.string("alt")) }
        if flags.contains(.maskShift) { keys.append(.string("shift")) }
        if let keyName = keyNameFromCode(Int(keyCode)) {
            keys.append(.string(keyName))
        }

        let payload: JSONValue = .object([
            "seq": .int(seq),
            "kind": .string("key"),
            "keys": .array(keys),
            "ts": .double(ts),
        ])
        recorder.enqueue(payload)

    default:
        break
    }

    return passThrough
}

// Tiny subset of macOS virtual key codes. Sufficient for the modifier-key
// combos a desktop recording is realistically going to capture; anything
// else falls through with `null` and the recorder skips the step.
private func keyNameFromCode(_ code: Int) -> String? {
    switch code {
    case 0: return "a"
    case 1: return "s"
    case 2: return "d"
    case 3: return "f"
    case 4: return "h"
    case 5: return "g"
    case 6: return "z"
    case 7: return "x"
    case 8: return "c"
    case 9: return "v"
    case 11: return "b"
    case 12: return "q"
    case 13: return "w"
    case 14: return "e"
    case 15: return "r"
    case 16: return "y"
    case 17: return "t"
    case 31: return "o"
    case 32: return "u"
    case 34: return "i"
    case 35: return "p"
    case 37: return "l"
    case 38: return "j"
    case 40: return "k"
    case 45: return "n"
    case 46: return "m"
    case 36: return "return"
    case 48: return "tab"
    case 49: return "space"
    case 51: return "delete"
    case 53: return "escape"
    case 123: return "left"
    case 124: return "right"
    case 125: return "down"
    case 126: return "up"
    default: return nil
    }
}
