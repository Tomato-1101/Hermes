/**
 * Filesystem layout for a single flow.
 *
 *   flows/<flowId>/
 *     flow.json
 *     meta.json            -- name, createdAt, updatedAt (mirror of SQLite)
 *     variables.json
 *     assets/              -- screenshots, image-selector templates, ...
 *     browser-profile/     -- Playwright browser profile (cookies, localStorage)
 *     history/
 *       run-<runId>.jsonl.gz
 */

import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { assertValidFlow, type Flow } from '@hermes/ir';

export class FlowStore {
  constructor(public readonly rootDir: string) {}

  flowDir(flowId: string): string {
    return join(this.rootDir, flowId);
  }

  flowJsonPath(flowId: string): string {
    return join(this.flowDir(flowId), 'flow.json');
  }

  assetsDir(flowId: string): string {
    return join(this.flowDir(flowId), 'assets');
  }

  browserProfileDir(flowId: string): string {
    return join(this.flowDir(flowId), 'browser-profile');
  }

  historyDir(flowId: string): string {
    return join(this.flowDir(flowId), 'history');
  }

  /** Ensure the flow directory and its standard subfolders exist. */
  async init(flowId: string): Promise<void> {
    await mkdir(this.flowDir(flowId), { recursive: true });
    await mkdir(this.assetsDir(flowId), { recursive: true });
    await mkdir(this.browserProfileDir(flowId), { recursive: true });
    await mkdir(this.historyDir(flowId), { recursive: true });
  }

  /** Atomic write of flow.json (write to .tmp then rename). */
  async writeFlow(flow: Flow): Promise<void> {
    await this.init(flow.id);
    const target = this.flowJsonPath(flow.id);
    const tmp = `${target}.tmp`;
    await writeFile(tmp, JSON.stringify(flow, null, 2), 'utf8');
    await rename(tmp, target);
  }

  async readFlow(flowId: string): Promise<Flow> {
    const buf = await readFile(this.flowJsonPath(flowId), 'utf8');
    const parsed: unknown = JSON.parse(buf);
    return assertValidFlow(parsed);
  }

  /** Save a captured asset (PNG, etc.). Returns the asset reference path. */
  async writeAsset(flowId: string, fileName: string, data: Buffer): Promise<string> {
    await mkdir(this.assetsDir(flowId), { recursive: true });
    const full = join(this.assetsDir(flowId), fileName);
    await writeFile(full, data);
    return `assets/${fileName}`;
  }

  /**
   * Recursively delete the flow's directory. Idempotent — a missing
   * directory is treated as success so callers don't have to special-case
   * already-gone flows.
   */
  async deleteFlow(flowId: string): Promise<void> {
    await rm(this.flowDir(flowId), { recursive: true, force: true });
  }

  /**
   * Copy the IR of `srcFlowId` into a brand-new directory under `dstFlow.id`,
   * preserving steps/defaults/etc. The new flow starts with an empty
   * `browser-profile/` and `history/` — we explicitly do NOT copy cookies or
   * run logs, since they would let one duplicated flow leak the original's
   * session into a fresh-looking run.
   */
  async duplicateFlow(srcFlowId: string, dstFlow: Flow): Promise<Flow> {
    const original = await this.readFlow(srcFlowId);
    const copy: Flow = {
      ...original,
      id: dstFlow.id,
      name: dstFlow.name,
      metadata: { ...original.metadata, ...dstFlow.metadata },
    };
    await this.writeFlow(copy);
    return copy;
  }
}
