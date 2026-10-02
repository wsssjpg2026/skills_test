/**
 * Plugin manifest discovery (architecture doc §6.1, adjudication
 * A-PLUGIN-IDS): `plugins/<id>/plugin.json`, where the manifest `id` MUST
 * equal the directory name. Relative paths inside `args` resolve against the
 * plugins directory root (the layout in the doc sample:
 * `plugins/driver-modbus/plugin.json` with args `["../packages/…"]`).
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

export interface PluginManifest {
  /** Equals the manifest directory name (A-PLUGIN-IDS). */
  id: string;
  language: 'node' | 'python';
  command: string;
  args: string[];
  /** Absolute path of the manifest file. */
  manifestPath: string;
}

export class ManifestError extends Error {
  constructor(path: string, reason: string) {
    super(`invalid plugin manifest ${path}: ${reason}`);
    this.name = 'ManifestError';
  }
}

function resolveArg(pluginsDir: string, arg: string): string {
  if (isAbsolute(arg)) return arg;
  // Sample layout: relative to the plugins directory root.
  const fromPluginsDir = resolve(pluginsDir, arg);
  return fromPluginsDir;
}

/**
 * Scan a plugins directory for manifests. Invalid manifests throw (boot is
 * explicit about bad config); an absent directory yields an empty list.
 */
export async function discoverManifests(pluginsDir: string): Promise<PluginManifest[]> {
  let entries: string[];
  try {
    entries = await readdir(pluginsDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }

  const manifests: PluginManifest[] = [];
  for (const entry of entries.sort()) {
    const manifestPath = join(pluginsDir, entry, 'plugin.json');
    let info;
    try {
      info = await stat(manifestPath);
      if (!info.isFile()) continue;
    } catch {
      continue; // not a plugin directory
    }
    manifests.push(await loadManifest(manifestPath, pluginsDir));
  }
  return manifests;
}

/** Load and validate one manifest file. */
export async function loadManifest(manifestPath: string, pluginsDir: string): Promise<PluginManifest> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch (err) {
    throw new ManifestError(manifestPath, err instanceof Error ? err.message : String(err));
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ManifestError(manifestPath, 'must be a JSON object');
  }
  const m = raw as Record<string, unknown>;

  const id = m.id;
  if (typeof id !== 'string' || id.length === 0) {
    throw new ManifestError(manifestPath, 'id must be a non-empty string');
  }
  // A-PLUGIN-IDS: plugin id = manifest id = `plugins/<id>` directory name.
  const dirName = manifestPath.split(/[\\/]/).at(-2);
  if (id !== dirName) {
    throw new ManifestError(manifestPath, `id "${id}" must equal directory name "${dirName}"`);
  }

  const language = m.language;
  if (language !== 'node' && language !== 'python') {
    throw new ManifestError(manifestPath, 'language must be "node" or "python"');
  }
  if (typeof m.command !== 'string' || m.command.length === 0) {
    throw new ManifestError(manifestPath, 'command must be a non-empty string');
  }
  if (!Array.isArray(m.args) || m.args.some((a) => typeof a !== 'string')) {
    throw new ManifestError(manifestPath, 'args must be an array of strings');
  }

  return {
    id,
    language,
    command: m.command,
    args: (m.args as string[]).map((a) => resolveArg(pluginsDir, a)),
    manifestPath,
  };
}
