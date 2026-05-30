import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { SidecarClient } from './sidecar-client.js';
import { SocketTransport, type Transport } from './transport.js';

// ---------------------------------------------------------------------------
// A fake transport: an in-memory channel with no socket. Lets us drive the
// client's framing/dispatch deterministically and feed split/multi chunks.
// ---------------------------------------------------------------------------
class FakeTransport implements Transport {
  connected = false;
  written: string[] = [];
  private dataHandler: ((c: string) => void) | null = null;
  private closeHandler: (() => void) | null = null;

  connect(): Promise<void> {
    this.connected = true;
    return Promise.resolve();
  }
  write(data: string): Promise<void> {
    this.written.push(data);
    return Promise.resolve();
  }
  onData(handler: (c: string) => void): void {
    this.dataHandler = handler;
  }
  onClose(handler: () => void): void {
    this.closeHandler = handler;
  }
  close(): void {
    this.connected = false;
    this.closeHandler?.();
  }
  /** Test helper: simulate the peer pushing bytes (possibly mid-line). */
  emit(chunk: string): void {
    this.dataHandler?.(chunk);
  }
}

describe('SidecarClient — construction', () => {
  it('throws when neither socketPath nor transport is given', () => {
    expect(() => new SidecarClient({} as never)).toThrow();
  });

  it('accepts an injected transport', () => {
    expect(() => new SidecarClient({ transport: new FakeTransport() })).not.toThrow();
  });
});

// call() awaits connect() before writing, so the request lands on the
// transport a couple of microtasks later. Flush past a macrotask boundary
// before inspecting `written` / emitting a response / closing.
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

describe('SidecarClient — framing over an injected transport', () => {
  it('resolves a call when a matching id response arrives', async () => {
    const t = new FakeTransport();
    const client = new SidecarClient({ transport: t });
    const p = client.call('ping', null);
    await flush();

    // The request was framed with a trailing newline and a numeric id.
    expect(t.written).toHaveLength(1);
    const sent = JSON.parse(t.written[0]!.trimEnd());
    expect(sent).toMatchObject({ jsonrpc: '2.0', method: 'ping', params: null });
    expect(typeof sent.id).toBe('number');

    t.emit(JSON.stringify({ jsonrpc: '2.0', id: sent.id, result: { pong: true } }) + '\n');
    await expect(p).resolves.toEqual({ pong: true });
  });

  it('rejects with the server error envelope', async () => {
    const t = new FakeTransport();
    const client = new SidecarClient({ transport: t });
    const p = client.call('boom');
    await flush();
    const id = JSON.parse(t.written[0]!).id;
    t.emit(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32000, message: 'nope' } }) + '\n');
    await expect(p).rejects.toThrow('-32000: nope');
  });

  it('reassembles a response split across chunks', async () => {
    const t = new FakeTransport();
    const client = new SidecarClient({ transport: t });
    const p = client.call('x');
    await flush();
    const id = JSON.parse(t.written[0]!).id;
    const line = JSON.stringify({ jsonrpc: '2.0', id, result: { ok: 1 } }) + '\n';
    t.emit(line.slice(0, 7));
    t.emit(line.slice(7));
    await expect(p).resolves.toEqual({ ok: 1 });
  });

  it('dispatches responses by id, not by arrival order', async () => {
    const t = new FakeTransport();
    const client = new SidecarClient({ transport: t });
    const p1 = client.call('a');
    const p2 = client.call('b');
    await flush();
    // Reply to each request keyed by its OWN id, in reverse order of arrival.
    // (ids are assigned after connect() resolves, so written[] order is not
    // guaranteed to match call order — route by id, never by position.)
    for (const raw of [...t.written].reverse()) {
      const req = JSON.parse(raw);
      t.emit(
        JSON.stringify({ jsonrpc: '2.0', id: req.id, result: req.method.toUpperCase() }) + '\n',
      );
    }
    await expect(p1).resolves.toBe('A');
    await expect(p2).resolves.toBe('B');
  });

  it('fails all pending calls when the transport closes', async () => {
    const t = new FakeTransport();
    const client = new SidecarClient({ transport: t });
    const p = client.call('hang', null, 10_000);
    await flush();
    t.close();
    await expect(p).rejects.toThrow('Sidecar socket closed');
  });

  it('times out a call that never gets a response', async () => {
    const t = new FakeTransport();
    const client = new SidecarClient({ transport: t });
    await expect(client.call('slow', null, 20)).rejects.toThrow(/timed out/);
  });
});

// ---------------------------------------------------------------------------
// Real end-to-end round trip over an actual Unix Domain Socket, proving the
// SocketTransport path (the production default) behaves unchanged.
// ---------------------------------------------------------------------------
describe('SocketTransport — real UDS round trip', () => {
  const servers: Server[] = [];
  const paths: string[] = [];

  afterEach(() => {
    for (const s of servers.splice(0)) s.close();
    for (const p of paths.splice(0)) {
      try {
        rmSync(p, { force: true });
      } catch {
        /* ignore */
      }
    }
  });

  function startEchoServer(): Promise<string> {
    // Deterministic per-test path (no Date.now/random available in workflows,
    // but this is a plain vitest run — still keep it stable via pid + counter).
    const path = join(tmpdir(), `hermes-transport-test-${process.pid}-${servers.length}.sock`);
    paths.push(path);
    try {
      rmSync(path, { force: true });
    } catch {
      /* ignore */
    }
    const server = createServer((sock: Socket) => {
      sock.setEncoding('utf8');
      let buf = '';
      sock.on('data', (chunk: string) => {
        buf += chunk;
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (!line.trim()) continue;
          const req = JSON.parse(line);
          // Echo the method back as the result so the test can assert routing.
          sock.write(
            JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { echo: req.method } }) + '\n',
          );
        }
      });
    });
    servers.push(server);
    return new Promise((resolve) => server.listen(path, () => resolve(path)));
  }

  it('connects, calls, and resolves over a real socket', async () => {
    const path = await startEchoServer();
    const client = new SidecarClient({ socketPath: path });
    await expect(client.call('ping')).resolves.toEqual({ echo: 'ping' });
    await expect(client.call('mouse.click')).resolves.toEqual({ echo: 'mouse.click' });
    client.dispose();
  });

  it('reports connected state across connect/dispose', async () => {
    const path = await startEchoServer();
    const transport = new SocketTransport({ path });
    expect(transport.connected).toBe(false);
    await transport.connect();
    expect(transport.connected).toBe(true);
    transport.close();
    expect(transport.connected).toBe(false);
  });

  it('rejects connect to a non-existent socket', async () => {
    const transport = new SocketTransport({
      path: join(tmpdir(), `hermes-transport-absent-${process.pid}.sock`),
      connectTimeoutMs: 500,
    });
    await expect(transport.connect()).rejects.toBeTruthy();
  });

  it('rejects a write before connect', async () => {
    const transport = new SocketTransport({ path: join(tmpdir(), 'unused.sock') });
    await expect(transport.write('x\n')).rejects.toThrow('not connected');
  });
});
