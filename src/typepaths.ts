import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { activeLinks, peersOf } from './links.ts';

/** How a consumer's tsconfig names the file alpo writes its links' types into. */
export const EXTENDS = '@msb235/alpo/tsconfig.json';

type Paths = Record<string, string[]>;

/** The nearest `node_modules/<name>` at or above `from`, symlinks resolved. */
function installed(from: string, name: string): string | undefined {
  for (let dir = from; ; dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', name);
    if (existsSync(join(candidate, 'package.json'))) return realpathSync(candidate);
    if (dirname(dir) === dir) return undefined;
  }
}

/** The declaration file an export target names: its `types` condition, or the `.d.ts` beside its `.js`. */
function typesOf(target: unknown, dir: string): string | undefined {
  if (typeof target === 'string') {
    if (/\.d\.[cm]?ts$/.test(target)) return target;
    const dts = target.replace(/\.([cm]?)js$/, '.d.$1ts');
    return dts !== target && (dts.includes('*') || existsSync(join(dir, dts))) ? dts : undefined;
  }
  if (!target || typeof target !== 'object' || Array.isArray(target)) return undefined;
  const conditions = target as Record<string, unknown>;
  for (const key of ['types', 'import', 'default', 'require', 'node']) {
    const found = key in conditions ? typesOf(conditions[key], dir) : undefined;
    if (found) return found;
  }
  return undefined;
}

/** `paths` entries sending every import of the package `name` to its declarations in `dir`, export by export. */
export function pathsOf(name: string, dir: string): Paths {
  const json = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
    exports?: unknown;
    types?: string;
    typings?: string;
  };
  const out: Paths = {};
  const { exports } = json;
  const map =
    exports && typeof exports === 'object' && !Array.isArray(exports) && Object.keys(exports).every((k) => k.startsWith('.'))
      ? (exports as Record<string, unknown>)
      : exports !== undefined
        ? { '.': exports }
        : undefined;
  if (map) {
    for (const [key, target] of Object.entries(map)) {
      const types = typesOf(target, dir);
      if (types) out[key === '.' ? name : `${name}/${key.slice(2)}`] = [join(dir, types)];
    }
    return out;
  }
  // No `exports`: the package's root says where its types are, and any subpath is a file in it.
  out[name] = [join(dir, json.types ?? json.typings ?? 'index.d.ts')];
  out[`${name}/*`] = [join(dir, '*')];
  return out;
}

/** Where `@types` keeps the declarations for `name`: `@scope/x` becomes `@types/scope__x`. */
const typesPackage = (name: string) => `@types/${name.replace(/^@/, '').replace('/', '__')}`;

/**
 * The `paths` that give tsc what the vite plugin gives the dev server: each linked package's exports from its
 * checkout, and their peer dependencies from the consumer's own copy, so the two never meet as strangers.
 */
export function typePaths(root: string): Paths {
  const active = activeLinks(root, { env: false });
  const paths: Paths = {};
  for (const a of active) for (const [name, dir] of a.packages) Object.assign(paths, pathsOf(name, dir));
  for (const peer of peersOf(active)) {
    const own = installed(root, peer);
    if (own && shipsTypes(own)) {
      Object.assign(paths, pathsOf(peer, own));
      continue;
    }
    const typed = installed(root, typesPackage(peer));
    if (typed) Object.assign(paths, rename(pathsOf(typesPackage(peer), typed), typesPackage(peer), peer));
  }
  return paths;
}

/** Whether a package carries its own declarations; one that doesn't has them in `@types`. */
function shipsTypes(dir: string): boolean {
  const json = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as Record<string, unknown>;
  if (json.types || json.typings || existsSync(join(dir, 'index.d.ts'))) return true;
  return json.exports !== undefined && Object.keys(pathsOf('_', dir)).length > 0;
}

const rename = (paths: Paths, from: string, to: string): Paths =>
  Object.fromEntries(Object.entries(paths).map(([k, v]) => [to + k.slice(from.length), v]));

/** The config file the consumer's installed alpo ships for its tsconfig to extend, if alpo is installed. */
export function typesConfigOf(root: string): string | undefined {
  const dir = installed(root, '@msb235/alpo');
  const file = dir && join(dir, 'dist', 'tsconfig.json');
  return file && existsSync(file) ? file : undefined;
}

/**
 * Writes the links' `paths` into the config the consumer extends, or empties it when nothing is linked.
 * The file where it went, or undefined when this alpo ships none to write.
 */
export function writeTypePaths(root: string): string | undefined {
  const file = typesConfigOf(root);
  if (!file) return undefined;
  const paths = typePaths(root);
  const body = Object.keys(paths).length ? { compilerOptions: { paths } } : {};
  const text = `${JSON.stringify(body, null, 2)}\n`;
  if (readFileSync(file, 'utf8') !== text) writeFileSync(file, text);
  return file;
}
