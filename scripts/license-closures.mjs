/**
 * Strict license gate on per-workspace PRODUCTION dependency closures
 * (architecture doc §6.4): allow MIT / ISC / BSD / Apache-2.0 / MPL-2.0
 * (+BlueOak-1.0.0, forced by glob 13 inside @fastify/static's tree);
 * EPL-2.0 only for @orch/driver-mqtt (sparkplug-payload, ticket #8);
 * everything else — including GPL / AGPL / UNKNOWN — fails.
 *
 * Closures come from `npm ls --omit=dev --all --json` because workspace deps
 * are hoisted to the root node_modules (directory-walking cannot scope them).
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(repoRoot, 'package.json'));

const EPL_EXCEPTION_WORKSPACE = '@orch/driver-mqtt';
const BASE_ALLOWED = new Set(
  ['MIT', 'ISC', '0BSD', 'BSD-2-Clause', 'BSD-3-Clause', 'Apache-2.0', 'MPL-2.0', 'BlueOak-1.0.0'].map((l) =>
    l.toUpperCase(),
  ),
);
const EPL_ALLOWED = new Set(['EPL-2.0'].map((l) => l.toUpperCase()));

function npm(args) {
  return spawnSync('npm', args, { cwd: repoRoot, encoding: 'utf8' }).stdout ?? '';
}

function workspaceNames() {
  return JSON.parse(npm(['query', '.workspace', '--json'])).map((pkg) => pkg.name).filter(Boolean);
}

function prodClosure(wsName) {
  const out = npm(['ls', '--omit=dev', '--all', '--json', '--workspace', wsName]);
  const names = new Set();
  const walk = (node) => {
    for (const [name, child] of Object.entries(node.dependencies ?? {})) {
      // Unmet optional dependencies appear as empty nodes — nothing installed.
      if (child && typeof child === 'object' && child.version !== undefined) {
        names.add(name);
        walk(child);
      }
    }
  };
  walk(JSON.parse(out));
  return names;
}

function licenseOf(pkgName) {
  // Read the physical manifest — workspace packages' `exports` maps block
  // `require.resolve('<pkg>/package.json')`.
  const candidates = [
    join(repoRoot, 'node_modules', ...pkgName.split('/'), 'package.json'),
  ];
  for (const manifest of candidates) {
    try {
      return String(JSON.parse(readFileSync(manifest, 'utf8')).license ?? 'UNKNOWN');
    } catch {
      /* try next */
    }
  }
  try {
    const resolved = require.resolve(pkgName);
    const dir = dirname(resolved);
    return String(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).license ?? 'UNKNOWN');
  } catch {
    return 'UNKNOWN';
  }
}

/** Minimal SPDX-expression evaluator over the allowed set (OR = any, AND = all). */
function expressionAllowed(license, allowed) {
  const evalOr = (expr) =>
    expr
      .split(/\s+OR\s+/i)
      .map((branch) =>
        branch
          .replace(/[()]/g, '')
          .split(/\s+AND\s+/i)
          .every((atom) => allowed.has(atom.trim().toUpperCase())),
      )
      .some(Boolean);
  return evalOr(license);
}

let violations = 0;
for (const ws of workspaceNames()) {
  const allowed = new Set(ws === EPL_EXCEPTION_WORKSPACE ? [...BASE_ALLOWED, ...EPL_ALLOWED] : BASE_ALLOWED);
  for (const pkg of prodClosure(ws)) {
    const license = licenseOf(pkg);
    if (!expressionAllowed(license, allowed)) {
      console.error(
        `LICENSE VIOLATION: ${pkg} (${license}) in production tree of ${ws}` +
          (ws === EPL_EXCEPTION_WORKSPACE ? '' : ` — EPL is allowed only for ${EPL_EXCEPTION_WORKSPACE}`),
      );
      violations += 1;
    }
  }
}

if (violations > 0) {
  process.exit(1);
}
console.log('production closures: OK (strict allow list, EPL confined to @orch/driver-mqtt)');
