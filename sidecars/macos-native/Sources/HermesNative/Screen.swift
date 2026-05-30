// Screen.swift — screenshot, template-match and OCR helpers for hermes-native.
//
// JSON-RPC methods:
//   - `screen.capture`   PNG of the full virtual desktop (or a sub-rect), base64.
//   - `screen.findImage` normalized-cross-correlation template match: locate a
//                        small reference image on screen, return its rect/center
//                        in LOGICAL screen points (the coordinate space mouse.*
//                        clicks use). CPU NCC on a downscaled grayscale buffer —
//                        no Apple template-match API exists, and this is enough
//                        to click a known button/icon. scaleInvariant tries a
//                        small scale pyramid.
//   - `screen.ocr`       Apple Vision text recognition over the screen (or a
//                        sub-rect); returns the joined text plus per-line
//                        observations with rects in logical points.
//
// Coordinates returned by findImage/ocr follow the sidecar contract: SCREEN-
// ABSOLUTE, origin TOP-LEFT, LOGICAL POINTS. CGWindowListCreateImage hands back
// retina PIXELS, so we divide by the capture's pixels-per-point scale and add
// the region origin. Single-display (main screen) is assumed for the full-screen
// (null region) case.

import AppKit
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers
import Vision

enum ScreenError: Error {
    case captureFailed
    case encodeFailed
    case decodeFailed
}

/// Raw CGImage capture of the full virtual desktop or a screen-point sub-rect.
func captureCGImage(region: CGRect?) throws -> CGImage {
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
    return cg
}

func captureScreen(region: CGRect?) throws -> JSONValue {
    let cg = try captureCGImage(region: region)

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

// MARK: - Pixel <-> logical-point mapping

/// A captured image plus the data needed to map its pixels back to logical
/// screen points: the region's logical origin and the pixels-per-point scale.
private struct CapturedImage {
    let cg: CGImage
    let originX: Double
    let originY: Double
    let scaleX: Double
    let scaleY: Double
}

private func captureForAnalysis(region: CGRect?) throws -> CapturedImage {
    let cg = try captureCGImage(region: region)
    let logical: CGRect
    if let r = region {
        logical = r
    } else if let f = NSScreen.main?.frame {
        logical = CGRect(x: 0, y: 0, width: f.width, height: f.height)
    } else {
        logical = CGRect(x: 0, y: 0, width: CGFloat(cg.width), height: CGFloat(cg.height))
    }
    let scaleX = logical.width > 0 ? Double(cg.width) / Double(logical.width) : 1
    let scaleY = logical.height > 0 ? Double(cg.height) / Double(logical.height) : 1
    return CapturedImage(
        cg: cg,
        originX: Double(logical.origin.x),
        originY: Double(logical.origin.y),
        scaleX: scaleX,
        scaleY: scaleY
    )
}

/// Draw `cg` into a w×h device-gray buffer (top-left origin) and return its
/// luminance as Doubles, row-major. Used for both screen and template so NCC
/// compares like-for-like.
private func grayBuffer(_ cg: CGImage, _ w: Int, _ h: Int) -> [Double]? {
    guard w > 0, h > 0 else { return nil }
    let count = w * h
    let raw = UnsafeMutablePointer<UInt8>.allocate(capacity: count)
    defer { raw.deallocate() }
    raw.initialize(repeating: 0, count: count)
    let cs = CGColorSpaceCreateDeviceGray()
    guard let ctx = CGContext(
        data: raw,
        width: w,
        height: h,
        bitsPerComponent: 8,
        bytesPerRow: w,
        space: cs,
        bitmapInfo: CGImageAlphaInfo.none.rawValue
    ) else {
        return nil
    }
    ctx.interpolationQuality = .high
    // Flip so buffer row 0 is the TOP of the image — match coords come out
    // top-left, matching the screen-point convention.
    ctx.translateBy(x: 0, y: CGFloat(h))
    ctx.scaleBy(x: 1, y: -1)
    ctx.draw(cg, in: CGRect(x: 0, y: 0, width: w, height: h))
    var out = [Double](repeating: 0, count: count)
    for i in 0..<count { out[i] = Double(raw[i]) }
    return out
}

// MARK: - Template matching (NCC)

/// Best normalized-cross-correlation match of `tmpl` (tw×th) inside `img`
/// (iw×ih), both row-major top-left grayscale buffers. Returns the score and
/// the top-left (x,y) of the best window, or nil if the template can't fit or
/// either patch is flat. Integral images give O(1) window mean/variance; the
/// cross term is the unavoidable O(template area) per position.
private func nccBestMatch(
    img: [Double], iw: Int, ih: Int,
    tmpl: [Double], tw: Int, th: Int
) -> (score: Double, x: Int, y: Int)? {
    if tw < 2 || th < 2 || tw > iw || th > ih { return nil }
    let area = Double(tw * th)

    // Zero-mean template + its L2 norm.
    var tMean = 0.0
    for v in tmpl { tMean += v }
    tMean /= area
    var tZero = [Double](repeating: 0, count: tw * th)
    var tNorm = 0.0
    for i in 0..<(tw * th) {
        let z = tmpl[i] - tMean
        tZero[i] = z
        tNorm += z * z
    }
    if tNorm <= 1e-9 { return nil }
    let tNormSqrt = tNorm.squareRoot()

    // Integral images of img and img^2.
    let IW = iw + 1
    var integ = [Double](repeating: 0, count: IW * (ih + 1))
    var integSq = [Double](repeating: 0, count: IW * (ih + 1))
    for y in 0..<ih {
        var rowSum = 0.0
        var rowSumSq = 0.0
        for x in 0..<iw {
            let v = img[y * iw + x]
            rowSum += v
            rowSumSq += v * v
            integ[(y + 1) * IW + (x + 1)] = integ[y * IW + (x + 1)] + rowSum
            integSq[(y + 1) * IW + (x + 1)] = integSq[y * IW + (x + 1)] + rowSumSq
        }
    }
    func windowSum(_ I: [Double], _ x: Int, _ y: Int) -> Double {
        let x2 = x + tw, y2 = y + th
        return I[y2 * IW + x2] - I[y * IW + x2] - I[y2 * IW + x] + I[y * IW + x]
    }

    var best = (score: -2.0, x: 0, y: 0)
    for y in 0...(ih - th) {
        for x in 0...(iw - tw) {
            let wsum = windowSum(integ, x, y)
            let wsumSq = windowSum(integSq, x, y)
            let wVar = wsumSq - wsum * wsum / area // Σ(I-mean)²
            if wVar <= 1e-9 { continue }
            // Σ (I-wMean)·tZero == Σ I·tZero since Σ tZero == 0.
            var cross = 0.0
            var ti = 0
            for j in 0..<th {
                let base = (y + j) * iw + x
                for i in 0..<tw {
                    cross += img[base + i] * tZero[ti]
                    ti += 1
                }
            }
            let denom = wVar.squareRoot() * tNormSqrt
            let score = denom > 0 ? cross / denom : 0
            if score > best.score { best = (score, x, y) }
        }
    }
    return best.score > -2 ? best : nil
}

func findImageOnScreen(
    templatePNG: Data,
    threshold: Double,
    scaleInvariant: Bool,
    region: CGRect?
) throws -> JSONValue {
    guard let src = CGImageSourceCreateWithData(templatePNG as CFData, nil),
          let templateCG = CGImageSourceCreateImageAtIndex(src, 0, nil) else {
        throw ScreenError.decodeFailed
    }
    let cap = try captureForAnalysis(region: region)

    // Downscale the screen so NCC is tractable; the template is scaled by the
    // same pixel factor (the asset is assumed captured at the screen's scale).
    let maxDim = 640.0
    let screenPxW = Double(cap.cg.width)
    let screenPxH = Double(cap.cg.height)
    let f = min(1.0, maxDim / max(screenPxW, screenPxH))
    let workW = max(1, Int((screenPxW * f).rounded()))
    let workH = max(1, Int((screenPxH * f).rounded()))
    guard let screenBuf = grayBuffer(cap.cg, workW, workH) else {
        throw ScreenError.decodeFailed
    }
    let tPxW = Double(templateCG.width)
    let tPxH = Double(templateCG.height)

    let scales: [Double] = scaleInvariant ? [0.8, 0.9, 1.0, 1.1, 1.2] : [1.0]
    var best: (score: Double, wx: Int, wy: Int, tw: Int, th: Int)?
    for s in scales {
        let tw = Int((tPxW * f * s).rounded())
        let th = Int((tPxH * f * s).rounded())
        if tw < 2 || th < 2 || tw > workW || th > workH { continue }
        guard let tmplBuf = grayBuffer(templateCG, tw, th) else { continue }
        if let m = nccBestMatch(img: screenBuf, iw: workW, ih: workH, tmpl: tmplBuf, tw: tw, th: th) {
            if best == nil || m.score > best!.score {
                best = (m.score, m.x, m.y, tw, th)
            }
        }
    }

    guard let b = best, b.score >= threshold else {
        return .object([
            "found": .bool(false),
            "score": .double(best?.score ?? 0),
        ])
    }

    // working px -> capture px -> logical points.
    let cxPx = (Double(b.wx) + Double(b.tw) / 2) / f
    let cyPx = (Double(b.wy) + Double(b.th) / 2) / f
    let wPx = Double(b.tw) / f
    let hPx = Double(b.th) / f
    let cx = cap.originX + cxPx / cap.scaleX
    let cy = cap.originY + cyPx / cap.scaleY
    let lw = wPx / cap.scaleX
    let lh = hPx / cap.scaleY
    return .object([
        "found": .bool(true),
        "score": .double(b.score),
        "x": .double(cx - lw / 2),
        "y": .double(cy - lh / 2),
        "w": .double(lw),
        "h": .double(lh),
        "cx": .double(cx),
        "cy": .double(cy),
    ])
}

// MARK: - OCR (Apple Vision)

func ocrScreen(region: CGRect?, languages: [String]) throws -> JSONValue {
    let cap = try captureForAnalysis(region: region)
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = true
    if !languages.isEmpty { request.recognitionLanguages = languages }

    let handler = VNImageRequestHandler(cgImage: cap.cg, options: [:])
    try handler.perform([request])

    let imgW = Double(cap.cg.width)
    let imgH = Double(cap.cg.height)
    var observations: [JSONValue] = []
    var lines: [String] = []
    for obs in (request.results ?? []) {
        guard let top = obs.topCandidates(1).first else { continue }
        lines.append(top.string)
        // Vision boundingBox is normalized, origin BOTTOM-LEFT — flip to top-left.
        let bb = obs.boundingBox
        let ipxX = Double(bb.minX) * imgW
        let ipxTopY = (1 - Double(bb.maxY)) * imgH
        let ipxW = Double(bb.width) * imgW
        let ipxH = Double(bb.height) * imgH
        observations.append(.object([
            "text": .string(top.string),
            "confidence": .double(Double(top.confidence)),
            "x": .double(cap.originX + ipxX / cap.scaleX),
            "y": .double(cap.originY + ipxTopY / cap.scaleY),
            "w": .double(ipxW / cap.scaleX),
            "h": .double(ipxH / cap.scaleY),
        ]))
    }
    return .object([
        "text": .string(lines.joined(separator: "\n")),
        "observations": .array(observations),
    ])
}
