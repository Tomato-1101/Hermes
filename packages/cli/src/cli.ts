/**
 * `hermes` — headless Flow runner.
 *
 * Reads a Flow IR JSON and executes it through the Engine and only the
 * providers the flow actually uses. No Electron, no UI: built so megaflow
 * replay and CI checks run straight from the terminal.
 *
 *   hermes run <flow.json> [--inputs <json|@file>] [--secrets <@file>]
 *                          [--headed] [--quiet] [--json]
 *
 * Exit codes: 0 ok · 1 flow failed / error · 2 aborted · 64 usage error.
 */
import { readFile } from 'node:fs/promises';
import type { RunEvent } from '@hermes/engine';
import { runFlowFile } from './run-flow.js';

const USAGE = `hermes — headless Flow runner

Usage:
  hermes run <flow.json> [options]

Options:
  --inputs <json|@file>   Seed variables (JSON object, or @path to a JSON file)
  --secrets <@file>       Values for \${secrets.*} (JSON object, or @path to a file)
  --headed                Launch the web browser headed (default: headless)
  --quiet                 Print only the final outcome
  --json                  Emit each run event as one JSON line
  -h, --help              Show this help
`;

interface ParsedArgs {
  file: string;
  inputs?: string;
  secrets?: string;
  headed: boolean;
  quiet: boolean;
  json: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const rest = argv.slice(1); // drop the "run" subcommand
  const out: ParsedArgs = { file: '', headed: false, quiet: false, json: false };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === '--headed') out.headed = true;
    else if (a === '--quiet') out.quiet = true;
    else if (a === '--json') out.json = true;
    else if (a === '--inputs') out.inputs = rest[++i];
    else if (a === '--secrets') out.secrets = rest[++i];
    else if (a.startsWith('-')) throw new Error(`unknown option: ${a}`);
    else if (!out.file) out.file = a;
    else throw new Error(`unexpected argument: ${a}`);
  }
  if (!out.file) throw new Error('missing <flow.json>');
  return out;
}

async function readJsonObject(value: string): Promise<Record<string, unknown>> {
  const text = value.startsWith('@') ? await readFile(value.slice(1), 'utf8') : value;
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('expected a JSON object');
  }
  return parsed as Record<string, unknown>;
}

function formatEvent(e: RunEvent): string | null {
  switch (e.type) {
    case 'run:start':
      return `[run] start ${e.flowId}`;
    case 'run:end':
      return `[run] ${e.outcome}`;
    case 'step:start':
      return `[step] ${e.cursor} ${e.step.type}${e.step.label ? ` — ${e.step.label}` : ''}`;
    case 'step:end':
      return `[step] ${e.cursor} ${e.outcome}${e.error ? `: ${e.error}` : ''}`;
    case 'log':
      return `[${e.level}] ${e.message}`;
    case 'screenshot':
      return `[shot] ${e.cursor} ${e.assetRef}`;
    default:
      return null;
  }
}

async function main(argv: string[]): Promise<number> {
  if (argv.length === 0 || argv.includes('-h') || argv.includes('--help')) {
    process.stdout.write(USAGE);
    return argv.length === 0 ? 64 : 0;
  }
  if (argv[0] !== 'run') {
    process.stderr.write(`error: unknown command '${argv[0]}'\n\n${USAGE}`);
    return 64;
  }

  let args: ParsedArgs;
  try {
    args = parseArgs(argv);
  } catch (e) {
    process.stderr.write(`error: ${(e as Error).message}\n\n${USAGE}`);
    return 64;
  }

  let inputs: Record<string, unknown> | undefined;
  let secrets: Record<string, string | undefined> | undefined;
  try {
    if (args.inputs) inputs = await readJsonObject(args.inputs);
    if (args.secrets) secrets = (await readJsonObject(args.secrets)) as Record<string, string>;
  } catch (e) {
    process.stderr.write(`error: bad --inputs/--secrets: ${(e as Error).message}\n`);
    return 64;
  }

  const onEvent = (e: RunEvent): void => {
    if (args.json) {
      process.stdout.write(JSON.stringify(e) + '\n');
      return;
    }
    if (args.quiet) return;
    const line = formatEvent(e);
    if (line) process.stdout.write(line + '\n');
  };

  try {
    const result = await runFlowFile(args.file, {
      inputs,
      secrets,
      onEvent,
      providers: { web: { headless: !args.headed } },
    });
    if (!args.json) process.stdout.write(`outcome: ${result.outcome}\n`);
    return result.outcome === 'success' ? 0 : result.outcome === 'aborted' ? 2 : 1;
  } catch (e) {
    process.stderr.write(`error: ${(e as Error).message}\n`);
    return 1;
  }
}

void main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e: unknown) => {
    process.stderr.write(`fatal: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
    process.exit(1);
  },
);
