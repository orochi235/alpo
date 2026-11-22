import { findRoot } from './config.ts';
import { activeLinks, linkFor, served } from './links.ts';

/** The part of esbuild's plugin API this uses, typed here so alpo needs no esbuild of its own. */
interface Build {
  initialOptions: { absWorkingDir?: string };
  onResolve(
    options: { filter: RegExp },
    callback: (args: { path: string; kind: string; pluginData?: unknown }) => Promise<{ path: string } | undefined>,
  ): void;
  resolve(
    path: string,
    options: { kind: string; resolveDir: string; pluginData: unknown },
  ): Promise<{ path: string; errors: unknown[] }>;
}

/** esbuild's `Plugin`, typed loosely as the vite plugin is: esbuild's own types are not alpo's to depend on. */
export type AlpoEsbuildPlugin = { name: string; setup: (build: any) => void };

const SELF = Symbol('alpo');

/**
 * The vite plugin's resolution for esbuild: each library this repository has linked (`alpo link`) is
 * resolved from its checkout, and from its `src` under `serve: source`.
 */
export function alpo(opts: { from?: string } = {}): AlpoEsbuildPlugin {
  return {
    name: 'alpo',
    setup(build: Build) {
      const root = findRoot(opts.from ?? build.initialOptions.absWorkingDir ?? process.cwd());
      const active = root ? activeLinks(root) : [];
      if (!active.length) return;
      build.onResolve({ filter: /^[^./]/ }, async (args) => {
        const a = args.pluginData === SELF ? undefined : linkFor(active, args.path);
        if (!a) return undefined;
        const r = await build.resolve(args.path, { kind: args.kind, resolveDir: a.checkout, pluginData: SELF });
        return r.errors.length ? undefined : { path: served(a, r.path) };
      });
    },
  };
}

export default alpo;
