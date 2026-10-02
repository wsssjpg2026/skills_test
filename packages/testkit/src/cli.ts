#!/usr/bin/env node
/**
 * `orch-driver-testkit --plugin "<spawn command>"` (architecture doc §2.3.6).
 * Spawns the plugin with a synthetic host, drives the SPI lifecycle, prints
 * one line per assertion, and exits 0 only when everything passed.
 *
 * Options:
 *   --plugin "<cmd>"          spawn command, split on whitespace
 *                             (quoted paths with spaces are not supported —
 *                             use --cwd instead)
 *   --cwd <dir>               working directory for the spawned plugin
 *   --timeout <ms>            overall budget (default 30000)
 *   --channel-config <json>   driver-private channel config (literal JSON or
 *                             @file). Default: the mock-driver §5.2 script.
 *   --quiet                   assertion lines only
 */
import { readFileSync } from 'node:fs';
import { runContractSuite } from './suite.js';

interface CliArgs {
  plugin?: string;
  cwd?: string;
  timeoutMs?: number;
  channelConfig?: Record<string, unknown>;
  quiet?: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--plugin':
        args.plugin = argv[++i];
        break;
      case '--cwd':
        args.cwd = argv[++i];
        break;
      case '--timeout':
        args.timeoutMs = Number(argv[++i]);
        break;
      case '--channel-config': {
        const raw = argv[++i] ?? '';
        const text = raw.startsWith('@') ? readFileSync(raw.slice(1), 'utf8') : raw;
        args.channelConfig = JSON.parse(text) as Record<string, unknown>;
        break;
      }
      case '--quiet':
        args.quiet = true;
        break;
      default:
        throw new Error(`unknown option "${a}"`);
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));

if (!args.plugin || args.plugin.trim().length === 0) {
  console.error('orch-driver-testkit: --plugin "<spawn command>" is required');
  process.exit(2);
}
if (args.timeoutMs !== undefined && (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0)) {
  console.error('orch-driver-testkit: --timeout must be a positive number of milliseconds');
  process.exit(2);
}

const [command, ...commandArgs] = args.plugin.trim().split(/\s+/);

if (!args.quiet) {
  console.log('orch-driver-testkit: driver SPI contract suite (§2.3.6)');
  console.log(`plugin: ${command} ${commandArgs.join(' ')}`.trimEnd());
  console.log('');
}

const result = await runContractSuite({
  command,
  args: commandArgs,
  cwd: args.cwd,
  timeoutMs: args.timeoutMs,
  channelConfig: args.channelConfig,
  quiet: args.quiet,
});

const passed = result.assertions.filter((a) => a.status === 'pass').length;
const failed = result.assertions.filter((a) => a.status === 'fail');
const skipped = result.assertions.filter((a) => a.status === 'skipped').length;

if (!args.quiet) console.log('');
if (failed.length === 0) {
  console.log(`contract suite PASS — ${passed} passed, ${skipped} skipped`);
  process.exit(0);
}
for (const f of failed) {
  console.error(`FAIL ${f.name}: ${f.detail ?? 'no detail'}`);
}
console.error(`contract suite FAIL — ${passed} passed, ${failed.length} failed, ${skipped} skipped`);
process.exit(1);
