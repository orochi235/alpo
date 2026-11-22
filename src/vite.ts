import { existsSync, type FSWatcher, readFileSync, realpathSync, watch } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { type Plugin, searchForWorkspaceRoot } from 'vite';
import {
  CONFIG,
  expandHome,
  findRoot,
  LOCAL,
  matches,
  packageOf,
  readConfig,
  readLocal,
  tildify,
} from './config.ts';
import { packagesIn } from './workspaces.ts';

interface Active {
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

export function activeLinks(root: string): Active[] {
  const config = readConfig(root);
  const local = readLocal(root);
  return Object.entries(config.libs).flatMap(([lib, cfg]) => {
    if (cfg.via !== 'vite') return [];
    const env = process.env[envKey(lib)];
    if (env === 'npm') return [];
    const link = local.links[lib];
    if (!env && !link) return [];
    const checkout = env ? expandHome(env) : expandHome(cfg.repo, root);
    if (!existsSync(checkout)) throw new Error(`alpo: ${lib} is linked but ${tildify(checkout)} does not exist`);
    const packages = new Map([...packagesIn(checkout)].filter(([name]) => matches(cfg.packages, name)));
    const sourceDirs = cfg.serve === 'source' ? [...packages.values()].map((d) => realpathSync(d)) : undefined;
    return [{ lib, checkout, packages, reason: link?.for, ...(sourceDirs ? { sourceDirs } : {}) }];
  });
}

/** The peer dependencies of every linked package, which must resolve to the app's one copy. */
export function peersOf(active: Active[]): string[] {
  const peers = new Set<string>();
  for (const a of active)
    for (const dir of a.packages.values()) {
      const json = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { peerDependencies?: object };
      for (const name of Object.keys(json.peerDependencies ?? {})) if (!a.packages.has(name)) peers.add(name);
    }
  return [...peers].sort();
}

/** The config and local files' contents, to tell a real change from a stray event. */
const linkFiles = (root: string) =>
  [CONFIG, LOCAL].map((f) => (existsSync(join(root, f)) ? readFileSync(join(root, f), 'utf8') : '')).join('\0');

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

/** How long a checkout's `dist` files stay unwritten before its build is taken as done. */
const BUILD_QUIET_MS = 1500;

/**
 * Vite's `Plugin`, typed without naming vite: a alpo linked from its checkout brings its own vite,
 * and two vites' `Plugin` types are too deep for TypeScript to compare.
 */
export type AlpoPlugin = { name: string; [hook: string]: any };

/**
 * Serves each library this repository has linked (`alpo link`) from its checkout's built output
 * instead of the version npm installed. Imports resolve from the checkout's root, so its own
 * workspace links answer them and every package's `exports` still apply.
 */
export function alpo(opts: { from?: string } = {}): AlpoPlugin {
  let active: Active[] = [];
  let root: string | undefined;
  let loaded = '';
  let closeWatchers = () => {};
  const plugin: Plugin = {
    name: 'alpo',
    enforce: 'pre',
    config(user) {
      root = findRoot(opts.from ?? user.root ?? process.cwd());
      if (!root) return;
      loaded = linkFiles(root);
      active = activeLinks(root);
      if (!active.length) return;
      return {
        // Prebundled, a checkout's build would be frozen at startup; the exclusion also changes the
        // config hash, so vite cannot reuse bundles it made from npm's copy.
        optimizeDeps: { exclude: active.flatMap((a) => [...a.packages.keys()]) },
        // A checkout's `dist` would otherwise take its peers (react, say) from the checkout's own node_modules: a second copy.
        resolve: { dedupe: peersOf(active) },
        // Setting `allow` at all drops vite's default, so the workspace root goes back in beside the checkouts.
        server: { fs: { allow: [searchForWorkspaceRoot(user.root ?? process.cwd()), ...active.map((a) => a.checkout)] } },
      };
    },
    configResolved(config) {
      for (const a of active) {
        const why = a.reason ? ` (for "${a.reason}")` : '';
        config.logger.info(`alpo: serving ${a.lib}${a.sourceDirs ? "'s source" : ''} from ${tildify(a.checkout)}${why}`);
      }
    },
    configureServer(server) {
      if (!root) return;
      const watchers: FSWatcher[] = [];
      // Linking or unlinking rewrites the local file; the server picks it up without a manual restart.
      // FSEvents can deliver a write from just before the watch began, so only a real change restarts.
      const at = root;
      watchers.push(
        watch(at, (_event, name) => {
          if ((name === LOCAL || name === CONFIG) && linkFiles(at) !== loaded) void server.restart();
        }),
      );
      // A source link needs no watch of its own: vite watches the source files it served.
      for (const a of active.filter((x) => !x.sourceDirs)) {
        // Vite watches each file it served, which a rebuild deletes and writes anew, so the new file
        // goes unseen. A watch on each `dist` dies with the directory; one from the checkout outlives it.
        const dists = [...a.packages.values()].map((dir) => `${relative(a.checkout, dir) || '.'}/dist/`.replace(/^\.\//, ''));
        let settled: ReturnType<typeof setTimeout> | undefined;
        watchers.push(
          watch(a.checkout, { recursive: true }, (_event, name) => {
            if (!name || name.includes('node_modules/') || !dists.some((d) => name.startsWith(d))) return;
            clearTimeout(settled);
            settled = setTimeout(() => {
              server.moduleGraph.invalidateAll();
              server.hot.send({ type: 'full-reload' });
            }, BUILD_QUIET_MS);
          }),
        );
      }
      closeWatchers = () => {
        for (const w of watchers) w.close();
      };
      server.httpServer?.once('close', closeWatchers);
    },
    closeBundle() {
      closeWatchers();
    },
    async resolveId(source) {
      const name = packageOf(source);
      if (!name) return null;
      const a = active.find((x) => x.packages.has(name));
      if (!a) return null;
      const built = await this.resolve(source, join(a.checkout, 'package.json'), { skipSelf: true });
      if (!a.sourceDirs || !built) return built;
      const [file, query = ''] = built.id.split('?');
      const src = sourceOf(file, a.sourceDirs);
      return src ? { ...built, id: query ? `${src}?${query}` : src } : built;
    },
  };
  return plugin as AlpoPlugin;
}

export default alpo;
