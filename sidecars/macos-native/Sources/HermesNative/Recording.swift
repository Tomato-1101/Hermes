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

    // Text-input batching state. Modifier-free keystrokes accumulate into
    // `textBuffer`; the buffer is flushed (emitted as a single `type` step)
    // when the user pauses for `TEXT_IDLE_MS`, switches focus via a mouse
    // click, fires a modifier-key combo, or stops the recording.
    private let textLock = NSLock()
    private var textBuffer: String = ""
    private var textBufferStartedAt: TimeInterval = 0
    private var textIdleTimer: DispatchSourceTimer?
    private static let TEXT_IDLE_MS: Int = 600

    // Click-vs-drag disambiguation. A left press is buffered until its
    // matching release: if the cursor moved past DRAG_THRESHOLD points
    // between down and up we emit a `drag`, otherwise a `click`. The element
    // snapshot is taken at the press point (the meaningful target for both).
    private struct PendingMouseDown {
        let x: Double
        let y: Double
        let ts: TimeInterval
        let element: JSONValue?
    }
    private let mouseLock = NSLock()
    private var pendingDown: PendingMouseDown?
    private static let DRAG_THRESHOLD: Double = 5.0

    // Scroll batching. A single scroll gesture fires many wheel events; we
    // accumulate their pixel deltas and flush one `scroll` step when the wheel
    // goes idle for SCROLL_IDLE_MS (or another event interrupts the gesture).
    private let scrollLock = NSLock()
    private var scrollDx: Double = 0
    private var scrollDy: Double = 0
    private var scrollX: Double = 0
    private var scrollY: Double = 0
    private var scrollStartedAt: TimeInterval = 0
    private var scrollIdleTimer: DispatchSourceTimer?
    private static let SCROLL_IDLE_MS: Int = 300

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
                (1 << CGEventType.leftMouseUp.rawValue) |
                (1 << CGEventType.rightMouseDown.rawValue) |
                (1 << CGEventType.scrollWheel.rawValue) |
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
        // Flush any pending text / scroll / press so the last action lands as
        // a step instead of being silently discarded.
        flushTextBuffer()
        flushScrollBuffer()
        flushPendingDownAsClick()
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

    // MARK: - Text-input batching

    /// Append a single character (or a few — IME composition can push more
    /// than one UniChar in a single keyDown) into the pending text buffer
    /// and reset the idle timer.
    fileprivate func appendText(_ s: String) {
        textLock.lock()
        if textBuffer.isEmpty {
            textBufferStartedAt = Date().timeIntervalSince1970
        }
        textBuffer.append(s)
        let snapshot = textBuffer
        textLock.unlock()
        rearmIdleTimer(snapshot: snapshot)
    }

    /// Flush whatever's in the text buffer right now as a single `type` step.
    /// Called on idle, on a modifier combo, on a mouse click, and on stop().
    fileprivate func flushTextBuffer() {
        textLock.lock()
        let text = textBuffer
        let startedAt = textBufferStartedAt
        textBuffer = ""
        textBufferStartedAt = 0
        textIdleTimer?.cancel()
        textIdleTimer = nil
        textLock.unlock()

        guard !text.isEmpty else { return }
        let seq = nextSequence()
        let event: JSONValue = .object([
            "seq": .int(seq),
            "kind": .string("type"),
            "text": .string(text),
            "ts": .double(startedAt > 0 ? startedAt : Date().timeIntervalSince1970),
        ])
        enqueue(event)
    }

    /// Rearm the dispatch timer that triggers `flushTextBuffer()` after
    /// TEXT_IDLE_MS milliseconds of keyboard silence. The snapshot is only
    /// used to skip the flush if the buffer already drained from another path.
    private func rearmIdleTimer(snapshot: String) {
        textLock.lock()
        textIdleTimer?.cancel()
        let timer = DispatchSource.makeTimerSource(queue: DispatchQueue.global())
        timer.schedule(deadline: .now() + .milliseconds(Self.TEXT_IDLE_MS))
        timer.setEventHandler { [weak self] in
            guard let self = self else { return }
            // Bail if someone else already flushed (e.g. a mouse click came in).
            self.textLock.lock()
            let currentLen = self.textBuffer.count
            self.textLock.unlock()
            if currentLen == 0 || currentLen < snapshot.count {
                return
            }
            self.flushTextBuffer()
        }
        textIdleTimer = timer
        timer.resume()
        textLock.unlock()
    }

    // MARK: - Click / drag disambiguation

    /// Buffer a left press. A press starts a new gesture, so any in-flight
    /// text/scroll is flushed first to keep IR ordering faithful.
    fileprivate func beginMouseDown(x: Double, y: Double, ts: TimeInterval, element: JSONValue?) {
        flushTextBuffer()
        flushScrollBuffer()
        mouseLock.lock()
        pendingDown = PendingMouseDown(x: x, y: y, ts: ts, element: element)
        mouseLock.unlock()
    }

    /// Resolve a buffered press against its release: drag if the cursor moved,
    /// click otherwise.
    fileprivate func endMouseUp(x: Double, y: Double) {
        mouseLock.lock()
        let down = pendingDown
        pendingDown = nil
        mouseLock.unlock()
        guard let d = down else { return }
        if hypot(x - d.x, y - d.y) >= Self.DRAG_THRESHOLD {
            enqueueDrag(from: d, toX: x, toY: y)
        } else {
            enqueueClick(from: d)
        }
    }

    /// Emit any dangling press (recording stopped mid-gesture) as a click.
    fileprivate func flushPendingDownAsClick() {
        mouseLock.lock()
        let down = pendingDown
        pendingDown = nil
        mouseLock.unlock()
        guard let d = down else { return }
        enqueueClick(from: d)
    }

    private func enqueueClick(from d: PendingMouseDown, button: String = "left") {
        var fields: [String: JSONValue] = [
            "seq": .int(nextSequence()),
            "kind": .string("click"),
            "button": .string(button),
            "x": .double(d.x),
            "y": .double(d.y),
            "ts": .double(d.ts),
        ]
        if let el = d.element { fields["element"] = el }
        enqueue(.object(fields))
    }

    /// Right clicks aren't disambiguated against a drag (a right-drag is not a
    /// gesture we record), so they emit immediately on press — flushing any
    /// in-flight text/scroll first to keep IR ordering faithful.
    fileprivate func recordRightClick(x: Double, y: Double, ts: TimeInterval, element: JSONValue?) {
        flushTextBuffer()
        flushScrollBuffer()
        enqueueClick(from: PendingMouseDown(x: x, y: y, ts: ts, element: element), button: "right")
    }

    private func enqueueDrag(from d: PendingMouseDown, toX: Double, toY: Double) {
        var fields: [String: JSONValue] = [
            "seq": .int(nextSequence()),
            "kind": .string("drag"),
            "x": .double(d.x),
            "y": .double(d.y),
            "toX": .double(toX),
            "toY": .double(toY),
            "ts": .double(d.ts),
        ]
        if let el = d.element { fields["element"] = el }
        enqueue(.object(fields))
    }

    // MARK: - Scroll batching

    /// Accumulate one wheel event's pixel delta into the pending scroll
    /// gesture (deltas already converted to the replay convention by the
    /// caller). Type input is flushed first so it stays ordered before the
    /// scroll that follows it.
    fileprivate func accumulateScroll(x: Double, y: Double, dx: Double, dy: Double) {
        flushTextBuffer()
        scrollLock.lock()
        if scrollDx == 0, scrollDy == 0 {
            scrollStartedAt = Date().timeIntervalSince1970
        }
        scrollDx += dx
        scrollDy += dy
        scrollX = x
        scrollY = y
        scrollLock.unlock()
        rearmScrollIdleTimer()
    }

    /// Flush the accumulated scroll gesture as a single `scroll` step.
    fileprivate func flushScrollBuffer() {
        scrollLock.lock()
        let dx = scrollDx
        let dy = scrollDy
        let x = scrollX
        let y = scrollY
        let startedAt = scrollStartedAt
        scrollDx = 0
        scrollDy = 0
        scrollX = 0
        scrollY = 0
        scrollStartedAt = 0
        scrollIdleTimer?.cancel()
        scrollIdleTimer = nil
        scrollLock.unlock()

        guard dx != 0 || dy != 0 else { return }
        let event: JSONValue = .object([
            "seq": .int(nextSequence()),
            "kind": .string("scroll"),
            "x": .double(x),
            "y": .double(y),
            "dx": .double(dx),
            "dy": .double(dy),
            "ts": .double(startedAt > 0 ? startedAt : Date().timeIntervalSince1970),
        ])
        enqueue(event)
    }

    private func rearmScrollIdleTimer() {
        scrollLock.lock()
        scrollIdleTimer?.cancel()
        let timer = DispatchSource.makeTimerSource(queue: DispatchQueue.global())
        timer.schedule(deadline: .now() + .milliseconds(Self.SCROLL_IDLE_MS))
        timer.setEventHandler { [weak self] in
            self?.flushScrollBuffer()
        }
        scrollIdleTimer = timer
        timer.resume()
        scrollLock.unlock()
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

    let ts = Date().timeIntervalSince1970

    switch type {
    case .leftMouseDown:
        // Defer the decision: a press becomes a `drag` if the cursor moves
        // before release, otherwise a `click`. The AX snapshot of the element
        // under the press is the target for both. Resolved in endMouseUp.
        let loc = event.location
        let element = try? elementAtPoint(x: loc.x, y: loc.y)
        recorder.beginMouseDown(x: loc.x, y: loc.y, ts: ts, element: element)

    case .leftMouseUp:
        let loc = event.location
        recorder.endMouseUp(x: loc.x, y: loc.y)

    case .rightMouseDown:
        let loc = event.location
        let element = try? elementAtPoint(x: loc.x, y: loc.y)
        recorder.recordRightClick(x: loc.x, y: loc.y, ts: ts, element: element)

    case .scrollWheel:
        let loc = event.location
        // Prefer pixel deltas (trackpad / momentum); fall back to line deltas
        // for a classic wheel (~10px per line). The wheel axis sign runs
        // opposite to screen-space motion, so negate to match the replay
        // convention (dy > 0 scrolls down). See postScroll in Input.swift.
        let pdy = event.getIntegerValueField(.scrollWheelEventPointDeltaAxis1)
        let pdx = event.getIntegerValueField(.scrollWheelEventPointDeltaAxis2)
        let stepDy: Double
        let stepDx: Double
        if pdy != 0 || pdx != 0 {
            stepDy = Double(pdy)
            stepDx = Double(pdx)
        } else {
            stepDy = event.getDoubleValueField(.scrollWheelEventDeltaAxis1) * 10
            stepDx = event.getDoubleValueField(.scrollWheelEventDeltaAxis2) * 10
        }
        recorder.accumulateScroll(x: loc.x, y: loc.y, dx: -stepDx, dy: -stepDy)

    case .keyDown:
        // A key press ends any in-flight scroll gesture; flush it so the
        // scroll step stays ordered before whatever the key produces.
        recorder.flushScrollBuffer()
        let keyCode = event.getIntegerValueField(.keyboardEventKeycode)
        let flags = event.flags
        // Ignore the modifier flag bits that aren't actually "down" modifiers
        // (caps lock, secondary fn, numeric pad markers) when deciding combo
        // vs. text.
        let hasMod =
            flags.contains(.maskCommand) ||
            flags.contains(.maskControl) ||
            flags.contains(.maskAlternate)

        if hasMod {
            // Modifier combo — flush any pending text input, then emit the
            // combo as its own step.
            recorder.flushTextBuffer()
            var keys: [JSONValue] = []
            if flags.contains(.maskCommand) { keys.append(.string("meta")) }
            if flags.contains(.maskControl) { keys.append(.string("ctrl")) }
            if flags.contains(.maskAlternate) { keys.append(.string("alt")) }
            if flags.contains(.maskShift) { keys.append(.string("shift")) }
            if let keyName = keyNameFromCode(Int(keyCode)) {
                keys.append(.string(keyName))
            }
            let payload: JSONValue = .object([
                "seq": .int(recorder.nextSequence()),
                "kind": .string("key"),
                "keys": .array(keys),
                "ts": .double(ts),
            ])
            recorder.enqueue(payload)
        } else {
            // Plain typing — extract the Unicode string the OS would have
            // produced and append to the in-flight text buffer.
            var actualLength: Int = 0
            var chars = [UniChar](repeating: 0, count: 8)
            event.keyboardGetUnicodeString(
                maxStringLength: chars.count,
                actualStringLength: &actualLength,
                unicodeString: &chars
            )
            if actualLength > 0 {
                let text = String(utf16CodeUnits: chars, count: actualLength)
                // Skip control characters (return / tab / delete / escape /
                // arrows) — surface them as key steps instead so the engine
                // can replay them faithfully via keyCombo.
                if text.unicodeScalars.allSatisfy({ $0.value >= 0x20 && $0.value != 0x7F }) {
                    recorder.appendText(text)
                } else if let keyName = keyNameFromCode(Int(keyCode)) {
                    // Emit special key as a no-modifier "key" step so engines
                    // replaying it still hit Enter/Tab/Esc/etc.
                    recorder.flushTextBuffer()
                    let payload: JSONValue = .object([
                        "seq": .int(recorder.nextSequence()),
                        "kind": .string("key"),
                        "keys": .array([.string(keyName)]),
                        "ts": .double(ts),
                    ])
                    recorder.enqueue(payload)
                }
            }
        }

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
