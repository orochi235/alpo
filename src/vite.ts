import { existsSync, type FSWatcher, readFileSync, watch } from 'node:fs';
import { join, relative } from 'node:path';
import { type Plugin, searchForWorkspaceRoot } from 'vite';
import { CONFIG, findRoot, LOCAL, tildify } from './config.ts';
import { type ActiveLink, activeLinks, linkFor, peersOf, served } from './links.ts';

export { activeLinks, peersOf, sourceOf } from './links.ts';

/** The config and local files' contents, to tell a real change from a stray event. */
const linkFiles = (root: string) =>
  [CONFIG, LOCAL].map((f) => (existsSync(join(root, f)) ? readFileSync(join(root, f), 'utf8') : '')).join('\0');

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
  let active: ActiveLink[] = [];
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
      const a = linkFor(active, source);
      if (!a) return null;
      const built = await this.resolve(source, join(a.checkout, 'package.json'), { skipSelf: true });
      return built && { ...built, id: served(a, built.id) };
    },
  };
  return plugin as AlpoPlugin;
}

export default alpo;
