// AX / Accessibility helpers for hermes-native.
//
// These wrap AXUIElement queries used by the desktop adapter: list
// running apps, get the frontmost app, walk the AX tree, and look up
// the element at a screen point. The functions return JSONValue so
// they slot directly into the dispatch table in main.swift.

import AppKit
import ApplicationServices
import Foundation

enum AccessibilityError: Error {
    case permissionDenied
    case notFound
    case axError(AXError)
}

func axPermissionGranted(prompt: Bool = false) -> Bool {
    let options: NSDictionary = [kAXTrustedCheckOptionPrompt.takeUnretainedValue(): prompt]
    return AXIsProcessTrustedWithOptions(options)
}

func listApps() -> [JSONValue] {
    var apps: [JSONValue] = []
    for app in NSWorkspace.shared.runningApplications {
        guard app.activationPolicy == .regular else { continue }
        apps.append(.object([
            "bundleId": .string(app.bundleIdentifier ?? ""),
            "name": .string(app.localizedName ?? ""),
            "pid": .int(Int(app.processIdentifier)),
            "active": .bool(app.isActive),
        ]))
    }
    return apps
}

func frontmostApp() -> JSONValue {
    guard let app = NSWorkspace.shared.frontmostApplication else { return .null }
    return .object([
        "bundleId": .string(app.bundleIdentifier ?? ""),
        "name": .string(app.localizedName ?? ""),
        "pid": .int(Int(app.processIdentifier)),
    ])
}

/// Look up the AX element under a screen point, returning a compact
/// snapshot. The system's AXUIElementCopyElementAtPosition returns the
/// deepest element under the cursor for the system-wide element.
func elementAtPoint(x: Double, y: Double) throws -> JSONValue {
    if !axPermissionGranted() { throw AccessibilityError.permissionDenied }
    let system = AXUIElementCreateSystemWide()
    var element: AXUIElement?
    let result = AXUIElementCopyElementAtPosition(system, Float(x), Float(y), &element)
    if result != .success {
        throw AccessibilityError.axError(result)
    }
    guard let el = element else { throw AccessibilityError.notFound }
    return snapshotElement(el)
}

/// Return a serialisable snapshot of an AX element. Includes the role,
/// title, value, position, size, and the bundle id / name of the app
/// that owns it.
private func snapshotElement(_ el: AXUIElement) -> JSONValue {
    var dict: [String: JSONValue] = [:]
    dict["role"] = .string(stringAttr(el, kAXRoleAttribute) ?? "")
    dict["subrole"] = .string(stringAttr(el, kAXSubroleAttribute) ?? "")
    dict["title"] = .string(stringAttr(el, kAXTitleAttribute) ?? "")
    dict["description"] = .string(stringAttr(el, kAXDescriptionAttribute) ?? "")
    dict["value"] = .string(stringAttr(el, kAXValueAttribute) ?? "")
    dict["identifier"] = .string(stringAttr(el, kAXIdentifierAttribute) ?? "")
    if let pos = pointAttr(el, kAXPositionAttribute) {
        dict["position"] = .object(["x": .double(pos.x), "y": .double(pos.y)])
    }
    if let size = sizeAttr(el, kAXSizeAttribute) {
        dict["size"] = .object(["w": .double(size.width), "h": .double(size.height)])
    }
    // owning app info
    var pid: pid_t = 0
    AXUIElementGetPid(el, &pid)
    if pid > 0 {
        if let app = NSRunningApplication(processIdentifier: pid) {
            dict["app"] = .object([
                "bundleId": .string(app.bundleIdentifier ?? ""),
                "name": .string(app.localizedName ?? ""),
                "pid": .int(Int(pid)),
            ])
        } else {
            dict["app"] = .object(["pid": .int(Int(pid))])
        }
    }
    return .object(dict)
}

// MARK: - Attribute helpers

private func stringAttr(_ el: AXUIElement, _ attr: String) -> String? {
    var value: CFTypeRef?
    let result = AXUIElementCopyAttributeValue(el, attr as CFString, &value)
    if result != .success { return nil }
    if let s = value as? String { return s }
    if let n = value as? NSNumber { return n.stringValue }
    return nil
}

private func pointAttr(_ el: AXUIElement, _ attr: String) -> CGPoint? {
    var value: CFTypeRef?
    let result = AXUIElementCopyAttributeValue(el, attr as CFString, &value)
    if result != .success { return nil }
    guard let axValue = value, CFGetTypeID(axValue) == AXValueGetTypeID() else { return nil }
    var point = CGPoint.zero
    AXValueGetValue(axValue as! AXValue, .cgPoint, &point)
    return point
}

private func sizeAttr(_ el: AXUIElement, _ attr: String) -> CGSize? {
    var value: CFTypeRef?
    let result = AXUIElementCopyAttributeValue(el, attr as CFString, &value)
    if result != .success { return nil }
    guard let axValue = value, CFGetTypeID(axValue) == AXValueGetTypeID() else { return nil }
    var size = CGSize.zero
    AXValueGetValue(axValue as! AXValue, .cgSize, &size)
    return size
}
