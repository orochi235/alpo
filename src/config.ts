import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

/** How a consumer is pointed at a checkout: its dev server resolves imports there, or its manifests say `file:`. */
export type Via = 'vite' | 'file';

export interface LibConfig {
  /** Package names this library supplies, `*` matching within one path segment: `@weasel-js/*`. */
  packages: string[];
  /** The library's checkout; `~/` is the home directory. */
  repo: string;
  via: Via;
}

/** `.alpo.json`, committed: which libraries this repository takes, and from where. */
export interface Config {
  libs: Record<string, LibConfig>;
}

export interface Link {
  for?: string;
  /** Commits of the library this repository is waiting on; a release whose tag contains all of them covers the link. */
  needs: string[];
  since: string;
  /** For `file` links, each manifest's specs as they were before linking, by manifest path from the root. */
  saved?: Record<string, Record<string, string>>;
}

/** `.alpo.local.json`, untracked: what this checkout is linked to right now. */
export interface Local {
  links: Record<string, Link>;
}

export const CONFIG = '.alpo.json';
export const LOCAL = '.alpo.local.json';

export const expandHome = (path: string): string => resolve(path.replace(/^~(?=\/|$)/, homedir()));

export const tildify = (path: string): string => {
  const home = homedir();
  return path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
};

/** The nearest directory at or above `from` holding a `.alpo.json`. */
export function findRoot(from: string): string | undefined {
  for (let dir = resolve(from); ; dir = dirname(dir)) {
    if (existsSync(join(dir, CONFIG))) return dir;
    if (dirname(dir) === dir) return undefined;
  }
}

const readJson = <T>(path: string, fallback: T): T =>
  existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as T) : fallback;

const writeJson = (path: string, value: unknown) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);

export const readConfig = (root: string): Config => readJson(join(root, CONFIG), { libs: {} });
export const writeConfig = (root: string, config: Config) => writeJson(join(root, CONFIG), config);

export const readLocal = (root: string): Local => readJson(join(root, LOCAL), { links: {} });

export function writeLocal(root: string, local: Local) {
  const path = join(root, LOCAL);
  if (Object.keys(local.links).length) writeJson(path, local);
  else rmSync(path, { force: true });
}

export function libOf(config: Config, lib: string): LibConfig {
  const found = config.libs[lib];
  if (!found) throw new Error(`this repository has not joined ${lib}: run \`alpo join ${lib}\``);
  return found;
}

const globRe = (glob: string) =>
  new RegExp(`^${glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')}$`);

export const matches = (globs: string[], name: string): boolean => globs.some((g) => globRe(g).test(name));

/** The package a bare import names: `@scope/pkg/sub` → `@scope/pkg`. */
export function packageOf(source: string): string | undefined {
  if (source.startsWith('.') || source.startsWith('/') || source.startsWith('\0')) return undefined;
  const parts = source.split('/');
  return source.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

export const today = () => new Date().toLocaleDateString('en-CA');
