import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { expandHome, matches, packageOf, readConfig, readLocal, tildify } from './config.ts';
import { packagesIn } from './workspaces.ts';

/** A library this repository is serving from its checkout right now. */
export interface ActiveLink {
  lib: string;
  checkout: string;
  /** The packages it supplies here, by name, with their directories. */
  packages: Map<string, string>;
  reason?: string;
  /** When serving `src` in place of `dist`: the packages' directories, symlinks resolved as vite resolves ids. */
  sourceDirs?: string[];
}

/** `ALPO_WEASEL=npm` turns a link off for one run; `ALPO_WEASEL=<path>` serves another checkout. */
const envKey = (lib: string) => `ALPO_${lib.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;

/**
 * The vite links in force: as recorded, under any `ALPO_<LIB>` override for this run unless `env` is false,
 * as it is for what outlives the run (the types tsc reads).
 */
export function activeLinks(root: string, { env: useEnv = true }: { env?: boolean } = {}): ActiveLink[] {
  const config = readConfig(root);
  const local = readLocal(root);
  return Object.entries(config.libs).flatMap(([lib, cfg]) => {
    if (cfg.via !== 'vite') return [];
    const env = useEnv ? process.env[envKey(lib)] : undefined;
    if (env === 'npm') return [];
    const link = local.links[lib];
    if (!env && !link) return [];
    const checkout = env ? expandHome(env) : expandHome(link?.from ?? cfg.repo, root);
    if (!existsSync(checkout)) throw new Error(`alpo: ${lib} is linked but ${tildify(checkout)} does not exist`);
    const packages = new Map([...packagesIn(checkout)].filter(([name]) => matches(cfg.packages, name)));
    const sourceDirs = cfg.serve === 'source' ? [...packages.values()].map((d) => realpathSync(d)) : undefined;
    return [{ lib, checkout, packages, reason: link?.for, ...(sourceDirs ? { sourceDirs } : {}) }];
  });
}

/** The peer dependencies of every linked package, which must resolve to the app's one copy. */
export function peersOf(active: ActiveLink[]): string[] {
  const peers = new Set<string>();
  for (const a of active)
    for (const dir of a.packages.values()) {
      const json = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { peerDependencies?: object };
      for (const name of Object.keys(json.peerDependencies ?? {})) if (!a.packages.has(name)) peers.add(name);
    }
  return [...peers].sort();
}

const SOURCE_EXTS = ['.ts', '.tsx', '.mts', '.js', '.jsx', '.mjs'];

/**
 * The source file a package's built `dist/<path>.js` came from, at `src/<path>` under any usual extension,
 * when the package mirrors `src` into `dist`; undefined when it does not.
 */
export function sourceOf(file: string, packageDirs: string[]): string | undefined {
  for (const dir of packageDirs) {
    const rel = relative(dir, file);
    if (!rel.startsWith(`dist${sep}`)) continue;
    const stem = join(dir, 'src', rel.slice('dist/'.length)).replace(/\.[cm]?js$/, '');
    return SOURCE_EXTS.map((ext) => stem + ext).find((f) => existsSync(f));
  }
  return undefined;
}

/** The active link supplying the package an import names, if any. */
export const linkFor = (active: ActiveLink[], spec: string): ActiveLink | undefined => {
  const name = packageOf(spec);
  return name ? active.find((a) => a.packages.has(name)) : undefined;
};

/** What to serve for a file an import resolved to in the checkout: its source, for a source link that has one. */
export function served(a: ActiveLink, id: string): string {
  if (!a.sourceDirs) return id;
  const [file, query] = id.split('?');
  const src = sourceOf(file, a.sourceDirs);
  return src ? (query === undefined ? src : `${src}?${query}`) : id;
}
