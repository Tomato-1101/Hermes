/**
 * Step handlers for the Excel (exceljs) layer.
 *
 * These are OS-independent and need no target, so they register under the
 * `default` layer. They expect `ctx.providers.excel` to be an ExcelProvider.
 *
 * Steps:
 *  - excel_open  { path }                          load/keep a workbook open
 *  - excel_read  { path, cell, sheet?, into }      cell → variable
 *  - excel_write { path, cell, value, sheet? }     variable/value → cell (+save)
 *  - excel_range { path, range, sheet?, into }     range → variable (2-D array)
 *  - excel_range { path, range, sheet?, values }   2-D array → range (+save)
 *
 * Relative `path`s resolve against `ctx.vars.__hermes_assets_dir__` (the flow
 * dir), mirroring screen-layer image assets; absolute paths pass through.
 */
import { isAbsolute, join } from 'node:path';
import type { Step, StepType } from '@hermes/ir';
import type { HandlerRegistry, RunContext, StepHandler, StepResult } from '@hermes/engine';
import { ExcelProvider, type ExcelCellValue } from './index.js';

function provider(ctx: RunContext): ExcelProvider {
  const p = ctx.providers.excel;
  if (!p) throw new Error('Excel provider not available in this run');
  if (!(p instanceof ExcelProvider)) {
    throw new Error('providers.excel is not an ExcelProvider instance');
  }
  return p;
}

function resolvePath(ctx: RunContext, raw: unknown): string {
  const path = String(raw ?? '');
  if (!path) throw new Error('excel step requires params.path');
  if (isAbsolute(path)) return path;
  const dir = ctx.vars['__hermes_assets_dir__'];
  return typeof dir === 'string' && dir ? join(dir, path) : path;
}

function sheetOf(step: Step): string | undefined {
  const s = step.params?.['sheet'];
  return s === undefined || s === null ? undefined : String(s);
}

function makeHandler(
  type: StepType,
  execute: (step: Step, ctx: RunContext) => Promise<StepResult<Record<string, unknown>>>,
): StepHandler {
  return { type, execute };
}

/** Coerce an interpolated param into a flow-friendly cell primitive. */
function toCellValue(v: unknown): ExcelCellValue {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  return String(v);
}

/** Coerce a param into a 2-D array of cell values (for excel_range writes). */
function toMatrix(v: unknown): ExcelCellValue[][] {
  if (!Array.isArray(v)) throw new Error('excel_range write requires params.values to be a 2-D array');
  return v.map((row) => {
    if (!Array.isArray(row)) throw new Error('excel_range write requires params.values to be a 2-D array');
    return row.map(toCellValue);
  });
}

export const excelStepHandlers: StepHandler[] = [
  makeHandler('excel_open', async (step, ctx) => {
    await provider(ctx).openWorkbook(resolvePath(ctx, step.params?.['path']));
    return { outcome: 'completed' };
  }),

  makeHandler('excel_read', async (step, ctx) => {
    const path = resolvePath(ctx, step.params?.['path']);
    const cell = String(step.params?.['cell'] ?? '');
    if (!cell) throw new Error('excel_read requires params.cell');
    const value = provider(ctx).readCell(path, cell, sheetOf(step));
    const into = String(step.params?.['into'] ?? '');
    if (into) ctx.vars[into] = value;
    return { outcome: 'completed', data: { value } };
  }),

  makeHandler('excel_write', async (step, ctx) => {
    const path = resolvePath(ctx, step.params?.['path']);
    const cell = String(step.params?.['cell'] ?? '');
    if (!cell) throw new Error('excel_write requires params.cell');
    const p = provider(ctx);
    p.writeCell(path, cell, toCellValue(step.params?.['value']), sheetOf(step));
    await p.save(path);
    return { outcome: 'completed' };
  }),

  makeHandler('excel_range', async (step, ctx) => {
    const path = resolvePath(ctx, step.params?.['path']);
    const range = String(step.params?.['range'] ?? '');
    if (!range) throw new Error('excel_range requires params.range');
    const p = provider(ctx);
    // `values` present → write that 2-D array; otherwise read into a variable.
    if (step.params?.['values'] !== undefined) {
      p.writeRange(path, range, toMatrix(step.params['values']), sheetOf(step));
      await p.save(path);
      return { outcome: 'completed' };
    }
    const value = p.readRange(path, range, sheetOf(step));
    const into = String(step.params?.['into'] ?? '');
    if (into) ctx.vars[into] = value;
    return { outcome: 'completed', data: { value } };
  }),
];

/** Convenience: register every excel handler under the `default` layer. */
export function registerExcelHandlers(registry: HandlerRegistry): void {
  for (const h of excelStepHandlers) registry.register(h);
}
