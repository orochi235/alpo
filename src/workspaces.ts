import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

export interface Manifest {
  /** The manifest's directory. */
  dir: string;
  /** Its path from the repository root, `package.json` for the root itself. */
  path: string;
  json: Record<string, unknown> & { name?: string };
  indent: string;
}

/** Fields whose specs tether reads and moves; peer ranges are the consumer's contract, not a pin. */
export const DEP_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies'] as const;

function readManifest(root: string, dir: string): Manifest | undefined {
  const file = join(dir, 'package.json');
  if (!existsSync(file)) return undefined;
  const text = readFileSync(file, 'utf8');
  const indent = /^[ \t]+(?=")/m.exec(text)?.[0] ?? '  ';
  return { dir, path: relative(root, file), json: JSON.parse(text), indent };
}

function expand(root: string, pattern: string): string[] {
  const clean = pattern.replace(/\/$/, '');
  if (!clean.endsWith('/*')) return [join(root, clean)];
  const base = join(root, clean.slice(0, -2));
  if (!existsSync(base)) return [];
  return readdirSync(base, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => join(base, e.name));
}

/** The root manifest and every npm workspace's, in that order. */
export function manifests(root: string): Manifest[] {
  const top = readManifest(root, root);
  if (!top) return [];
  const ws = top.json.workspaces;
  const patterns = Array.isArray(ws) ? ws : ((ws as { packages?: string[] } | undefined)?.packages ?? []);
  const rest = patterns.flatMap((p: string) => expand(root, p)).flatMap((dir) => readManifest(root, dir) ?? []);
  return [top, ...rest];
}

/** Each package a checkout supplies, by name, with its directory. */
export function packagesIn(checkout: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const m of manifests(checkout)) if (m.json.name) found.set(m.json.name, m.dir);
  return found;
}

export function depsOf(m: Manifest): Array<{ field: string; name: string; spec: string }> {
  return DEP_FIELDS.flatMap((field) =>
    Object.entries((m.json[field] as Record<string, string> | undefined) ?? {}).map(([name, spec]) => ({ field, name, spec })),
  );
}

export function setSpec(m: Manifest, name: string, spec: string) {
  for (const field of DEP_FIELDS) {
    const deps = m.json[field] as Record<string, string> | undefined;
    if (deps && name in deps) deps[name] = spec;
  }
}

export const writeManifest = (m: Manifest) =>
  writeFileSync(join(m.dir, 'package.json'), `${JSON.stringify(m.json, null, m.indent)}\n`);
