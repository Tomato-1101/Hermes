// HermesNative — Phase 0 sidecar.
//
// Boots a Unix Domain Socket and answers a single JSON-RPC method (`ping`).
// Later phases add AX/CGEvent/ScreenCaptureKit handlers; the dispatch table
// below is the only place they need to be wired in.
//
// Protocol (line-delimited JSON):
//   request : { "jsonrpc": "2.0", "id": <int>, "method": "<name>", "params": {...} }
//   response: { "jsonrpc": "2.0", "id": <int>, "result": {...} }
//             { "jsonrpc": "2.0", "id": <int>, "error":  { "code": <int>, "message": "..." } }
//
// Socket path is taken from `--socket <path>` argv pair, otherwise from the
// `HERMES_NATIVE_SOCKET` env var, otherwise a per-PID default under TMPDIR.

import Darwin
import Foundation

// MARK: - Logging

@inline(__always)
func logErr(_ s: String) {
    FileHandle.standardError.write(Data((s + "\n").utf8))
}

// MARK: - Configuration

struct Config {
    var socketPath: String
    var oneShot: Bool   // true → exit after first connection closes (test helper)
}

func parseConfig() -> Config {
    var socketPath: String? = nil
    var oneShot = false

    var iter = CommandLine.arguments.dropFirst().makeIterator()
    while let arg = iter.next() {
        switch arg {
        case "--socket":
            socketPath = iter.next()
        case "--one-shot":
            oneShot = true
        case "--help", "-h":
            print("""
            hermes-native — Phase 0 sidecar

            Usage:
              hermes-native [--socket <path>] [--one-shot]

            Environment:
              HERMES_NATIVE_SOCKET   default socket path when --socket is absent
            """)
            exit(0)
        default:
            logErr("hermes-native: unknown argument \(arg)")
            exit(64)
        }
    }

    let resolved: String
    if let p = socketPath {
        resolved = p
    } else if let env = ProcessInfo.processInfo.environment["HERMES_NATIVE_SOCKET"], !env.isEmpty {
        resolved = env
    } else {
        let tmp = NSTemporaryDirectory()
        resolved = "\(tmp)hermes-native-\(getpid()).sock"
    }
    return Config(socketPath: resolved, oneShot: oneShot)
}

// MARK: - JSON-RPC types

struct RpcRequest: Decodable {
    let jsonrpc: String
    let id: JSONValue?
    let method: String
    let params: JSONValue?
}

struct RpcError: Encodable {
    let code: Int
    let message: String
}

enum JSONValue: Codable {
    case null
    case bool(Bool)
    case int(Int)
    case double(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null; return }
        if let v = try? c.decode(Bool.self) { self = .bool(v); return }
        if let v = try? c.decode(Int.self) { self = .int(v); return }
        if let v = try? c.decode(Double.self) { self = .double(v); return }
        if let v = try? c.decode(String.self) { self = .string(v); return }
        if let v = try? c.decode([JSONValue].self) { self = .array(v); return }
        if let v = try? c.decode([String: JSONValue].self) { self = .object(v); return }
        throw DecodingError.dataCorruptedError(in: c, debugDescription: "unsupported JSON value")
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .null: try c.encodeNil()
        case .bool(let v): try c.encode(v)
        case .int(let v): try c.encode(v)
        case .double(let v): try c.encode(v)
        case .string(let v): try c.encode(v)
        case .array(let v): try c.encode(v)
        case .object(let v): try c.encode(v)
        }
    }
}

// MARK: - Dispatch

typealias Handler = (JSONValue?) throws -> JSONValue

let handlers: [String: Handler] = [
    "ping": { _ in
        return .object([
            "pong": .bool(true),
            "version": .string("0.0.1"),
            "platform": .string("darwin"),
            "ts": .double(Date().timeIntervalSince1970),
        ])
    }
]

// MARK: - Framing helpers

/// Build a one-line JSON response (no trailing newline; caller adds `\n`).
func encodeResponse(id: JSONValue?, result: JSONValue?, error: RpcError?) -> Data {
    var dict: [String: JSONValue] = [
        "jsonrpc": .string("2.0"),
        "id": id ?? .null,
    ]
    if let err = error {
        dict["error"] = .object([
            "code": .int(err.code),
            "message": .string(err.message),
        ])
    } else {
        dict["result"] = result ?? .null
    }
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.withoutEscapingSlashes]
    return (try? encoder.encode(JSONValue.object(dict))) ?? Data("{}".utf8)
}

func handleLine(_ line: String) -> Data {
    let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
    if trimmed.isEmpty { return Data() }

    guard let data = trimmed.data(using: .utf8) else {
        return encodeResponse(id: nil, result: nil,
                              error: RpcError(code: -32700, message: "Parse error: non-UTF8"))
    }

    let req: RpcRequest
    do {
        req = try JSONDecoder().decode(RpcRequest.self, from: data)
    } catch {
        return encodeResponse(id: nil, result: nil,
                              error: RpcError(code: -32700, message: "Parse error: \(error.localizedDescription)"))
    }

    guard let handler = handlers[req.method] else {
        return encodeResponse(id: req.id, result: nil,
                              error: RpcError(code: -32601, message: "Method not found: \(req.method)"))
    }

    do {
        let result = try handler(req.params)
        return encodeResponse(id: req.id, result: result, error: nil)
    } catch {
        return encodeResponse(id: req.id, result: nil,
                              error: RpcError(code: -32603, message: "Internal error: \(error.localizedDescription)"))
    }
}

// MARK: - Socket server

func makeAddr(_ path: String) -> sockaddr_un {
    var addr = sockaddr_un()
    addr.sun_family = sa_family_t(AF_UNIX)
    let bytes = Array(path.utf8)
    let cap = MemoryLayout.size(ofValue: addr.sun_path)
    precondition(bytes.count < cap, "socket path too long (max \(cap - 1))")
    withUnsafeMutableBytes(of: &addr.sun_path) { raw in
        for (i, b) in bytes.enumerated() {
            raw.storeBytes(of: Int8(bitPattern: b), toByteOffset: i, as: Int8.self)
        }
    }
    return addr
}

func bindAndListen(_ path: String) -> Int32 {
    unlink(path) // discard stale socket file
    let fd = socket(AF_UNIX, SOCK_STREAM, 0)
    if fd < 0 {
        logErr("hermes-native: socket() failed: \(String(cString: strerror(errno)))")
        exit(74)
    }

    var addr = makeAddr(path)
    let bindResult = withUnsafePointer(to: &addr) { ptr -> Int32 in
        ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sa in
            bind(fd, sa, socklen_t(MemoryLayout<sockaddr_un>.size))
        }
    }
    if bindResult < 0 {
        logErr("hermes-native: bind(\(path)) failed: \(String(cString: strerror(errno)))")
        close(fd)
        exit(74)
    }

    if listen(fd, 4) < 0 {
        logErr("hermes-native: listen() failed: \(String(cString: strerror(errno)))")
        close(fd)
        exit(74)
    }

    // Permissions: only the owning user can connect.
    chmod(path, 0o600)
    return fd
}

func readLine(fd: Int32, buf: inout Data) -> String? {
    var scratch = [UInt8](repeating: 0, count: 4096)
    while true {
        if let nlIdx = buf.firstIndex(of: 0x0A) {
            let lineData = buf.prefix(upTo: nlIdx)
            buf = buf.suffix(from: nlIdx + 1)
            return String(data: lineData, encoding: .utf8) ?? ""
        }
        let n = scratch.withUnsafeMutableBufferPointer { ptr in
            read(fd, ptr.baseAddress, ptr.count)
        }
        if n == 0 {
            if buf.isEmpty { return nil }
            let lineData = buf
            buf = Data()
            return String(data: lineData, encoding: .utf8) ?? ""
        }
        if n < 0 {
            if errno == EINTR { continue }
            logErr("hermes-native: read() error: \(String(cString: strerror(errno)))")
            return nil
        }
        buf.append(scratch, count: n)
    }
}

func writeAll(fd: Int32, data: Data) {
    var remaining = data
    while !remaining.isEmpty {
        let n = remaining.withUnsafeBytes { raw -> Int in
            write(fd, raw.baseAddress, raw.count)
        }
        if n < 0 {
            if errno == EINTR { continue }
            logErr("hermes-native: write() error: \(String(cString: strerror(errno)))")
            return
        }
        remaining = remaining.advanced(by: n)
    }
}

func serveClient(fd: Int32) {
    defer { close(fd) }
    var buf = Data()
    while let line = readLine(fd: fd, buf: &buf) {
        let response = handleLine(line)
        if response.isEmpty { continue }
        writeAll(fd: fd, data: response + Data([0x0A]))
    }
}

// MARK: - Entry

let cfg = parseConfig()
let listenFd = bindAndListen(cfg.socketPath)

// Announce the socket path on stdout so the parent process can pick it up.
print("hermes-native listening on \(cfg.socketPath)")
fflush(stdout)

signal(SIGPIPE, SIG_IGN)
let cleanup: @convention(c) (Int32) -> Void = { _ in
    // Best-effort socket unlink. We can't safely call Swift code from a
    // signal handler, but unlink() is async-signal-safe.
    if let env = getenv("HERMES_NATIVE_SOCKET_RUNTIME") {
        _ = unlink(env)
    }
    _exit(0)
}
setenv("HERMES_NATIVE_SOCKET_RUNTIME", cfg.socketPath, 1)
signal(SIGINT, cleanup)
signal(SIGTERM, cleanup)

while true {
    let clientFd = accept(listenFd, nil, nil)
    if clientFd < 0 {
        if errno == EINTR { continue }
        logErr("hermes-native: accept() error: \(String(cString: strerror(errno)))")
        continue
    }
    serveClient(fd: clientFd)
    if cfg.oneShot { break }
}

close(listenFd)
unlink(cfg.socketPath)
