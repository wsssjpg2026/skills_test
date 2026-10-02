#!/usr/bin/env bash
# Dependency license gate (architecture doc §6.4):
#   - production trees per workspace: allow MIT / ISC / BSD / Apache-2.0 /
#     MPL-2.0 (+BlueOak-1.0.0 — glob 13 et al. inside @fastify/static's tree);
#   - EPL-2.0 allowed ONLY in packages/drivers/mqtt (sparkplug-payload, #8);
#   - fail on GPL / AGPL / UNKNOWN.
#
# npm workspaces hoist every dependency into the root node_modules, so a
# per-directory license-checker run sees only the workspace package itself.
# The gate therefore runs in two phases:
#   1. root-wide license-checker-rseidelsohn tripwire — broad permissive list
#      (dev deps included, so GPL/AGPL/UNKNOWN anywhere still trips it);
#   2. scripts/license-closures.mjs — strict per-workspace PRODUCTION closure
#      check (npm ls) with the architecture allow list + EPL exception.
set -euo pipefail
cd "$(dirname "$0")/.."

TRIPWIRE_ALLOW="MIT;ISC;0BSD;BSD-2-Clause;BSD-3-Clause;Apache-2.0;MPL-2.0;BlueOak-1.0.0;Python-2.0;CC0-1.0;CC-BY-3.0;CC-BY-4.0;(MIT AND CC-BY-3.0)"

echo "==> license check: root-wide tripwire (any GPL/AGPL/UNKNOWN/EPL fails)"
npx --no-install license-checker-rseidelsohn --excludePrivatePackages --onlyAllow "$TRIPWIRE_ALLOW" --summary

echo "==> license check: production closures per workspace (strict allow list, EPL only in @orch/driver-mqtt)"
node scripts/license-closures.mjs

echo "license check: OK"
