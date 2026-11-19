import { existsSync, globSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, relative } from 'node:path';

export interface Manifest {
  /** The manifest's directory. */
  dir: string;
  /** Its path from the repository root, `package.json` for the root itself. */
  path: string;
  json: Record<string, unknown> & { name?: string };
  indent: string;
}

/** Fields whose specs alpo reads and moves; peer ranges are the consumer's contract, not a pin. */
export const DEP_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies'] as const;

function readManifest(root: string, dir: string): Manifest | undefined {
  const file = join(dir, 'package.json');
  if (!existsSync(file)) return undefined;
  const text = readFileSync(file, 'utf8');
  const indent = /^[ \t]+(?=")/m.exec(text)?.[0] ?? '  ';
  return { dir, path: relative(root, file), json: JSON.parse(text), indent };
}

/** The directories npm's workspace patterns name: globs with `*` and `**`, less any `!` pattern. */
function expand(root: string, patterns: string[]): string[] {
  const clean = (p: string) => p.replace(/^!/, '').replace(/\/$/, '');
  const glob = (ps: string[]) =>
    ps.length ? globSync(ps.map(clean), { cwd: root, exclude: (p) => basename(String(p)) === 'node_modules' }) : [];
  const drop = new Set(glob(patterns.filter((p) => p.startsWith('!'))));
  return [...new Set(glob(patterns.filter((p) => !p.startsWith('!'))))]
    .filter((dir) => !drop.has(dir))
    .sort()
    .map((dir) => join(root, dir));
}

/** The root manifest and every npm workspace's, in that order. */
export function manifests(root: string): Manifest[] {
  const top = readManifest(root, root);
  if (!top) return [];
  const ws = top.json.workspaces;
  const patterns = Array.isArray(ws) ? ws : ((ws as { packages?: string[] } | undefined)?.packages ?? []);
  const rest = expand(root, patterns).flatMap((dir) => readManifest(root, dir) ?? []);
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
