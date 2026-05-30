// Screen.swift — screenshot helpers for hermes-native.
//
// One JSON-RPC method: `screen.capture` returns a PNG of the full virtual
// desktop (or a screen-coordinate sub-rect) as base64. Uses
// CGWindowListCreateImage which works on macOS 13+ once the user has
// granted Screen Recording permission; without permission the system
// returns a black image rather than failing, so callers should sanity-check
// the result if they care.

import AppKit
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

enum ScreenError: Error {
    case captureFailed
    case encodeFailed
}

func captureScreen(region: CGRect?) throws -> JSONValue {
    // CGRect.null tells CGWindowListCreateImage to use the full virtual screen.
    let bounds = region ?? CGRect.null
    guard let cg = CGWindowListCreateImage(
        bounds,
        .optionOnScreenOnly,
        kCGNullWindowID,
        [.boundsIgnoreFraming]
    ) else {
        throw ScreenError.captureFailed
    }

    let png = NSMutableData()
    guard let dest = CGImageDestinationCreateWithData(
        png as CFMutableData,
        UTType.png.identifier as CFString,
        1,
        nil
    ) else {
        throw ScreenError.encodeFailed
    }
    CGImageDestinationAddImage(dest, cg, nil)
    if !CGImageDestinationFinalize(dest) {
        throw ScreenError.encodeFailed
    }

    return .object([
        "data": .string((png as Data).base64EncodedString()),
        "w": .int(cg.width),
        "h": .int(cg.height),
        "format": .string("png"),
    ])
}
