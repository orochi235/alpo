import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG, expandHome, type LibConfig, LOCAL, readConfig, readLocal, type Via, writeConfig } from './config.ts';
import { register, unregister } from './home.ts';
import { PLATFORMS, platformOf } from './ops.ts';
import type { Platform } from './platform.ts';
import { node, usesVite } from './platforms/node.ts';
import { git } from './sh.ts';
import { type Manifest, manifests } from './workspaces.ts';

/**
 * How the repository takes the library: of the package kinds both it and the checkout are, the one under
 * which it already depends on something the checkout supplies, else the first; npm's by vite when it uses vite.
 */
function viaFor(root: string, checkout: string, repo: string, packages?: string[]): { via: Via; platform: Platform } {
  const both = PLATFORMS.filter(({ platform }) => existsSync(join(checkout, platform.marker)) && existsSync(join(root, platform.marker)));
  const pick =
    both.find(({ platform, vias }) => {
      const probe: LibConfig = { packages: packages ?? platform.defaultPackages(checkout), repo, via: vias[0] };
      return platform.pins(root, probe).length > 0;
    }) ?? both[0];
  if (!pick) throw new Error(`no package at ${repo} of a kind this repository is; pass --repo`);
  const via = pick.platform === node ? (usesVite(root) ? 'vite' : 'file') : pick.vias[0];
  return { via, platform: pick.platform };
}

/** Vite configs under the root that don't load the plugin yet, each with the manifest beside it. */
export function unwiredViteConfigs(root: string): Array<{ file: string; m: Manifest }> {
  return manifests(root).flatMap((m) =>
    readdirSync(m.dir)
      .filter((f) => /^vite\.config\.[cm]?[jt]s$/.test(f))
      .map((f) => ({ file: join(m.dir, f), m }))
      .filter(({ file }) => !readFileSync(file, 'utf8').includes('@msb235/alpo/vite')),
  );
}

function ignore(root: string, entries: string[]) {
  const path = join(root, '.gitignore');
  const text = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const have = new Set(text.split('\n').map((l) => l.trim()));
  const missing = entries.filter((e) => !have.has(e));
  if (!missing.length) return;
  writeFileSync(path, `${text}${text && !text.endsWith('\n') ? '\n' : ''}${missing.map((e) => `${e}\n`).join('')}`);
}

export function joinLib(
  root: string,
  lib: string,
  opts: { repo?: string; packages?: string[]; via?: Via; serve?: 'source' },
): LibConfig {
  const repo = opts.repo ?? `~/src/${lib}`;
  const checkout = expandHome(repo, root);
  const packages = opts.packages?.length ? opts.packages : undefined;
  const { via, platform } = opts.via
    ? { via: opts.via, platform: platformOf(opts.via) }
    : viaFor(root, checkout, repo, packages);
  if (!existsSync(join(checkout, platform.marker))) throw new Error(`no package at ${repo}; pass --repo`);
  const entry: LibConfig = {
    packages: packages ?? platform.defaultPackages(checkout),
    repo,
    via,
    ...(opts.serve ? { serve: opts.serve } : {}),
  };
  if (entry.serve && entry.via !== 'vite') throw new Error('--serve source needs --via vite: a file link installs the package as built');
  const config = readConfig(root);
  config.libs[lib] = entry;
  writeConfig(root, config);
  ignore(root, [LOCAL, ...(platform.ignores?.(root) ?? [])]);
  register(root);
  return entry;
}

export function leaveLib(root: string, lib: string) {
  if (readLocal(root).links[lib]) throw new Error(`${lib} is linked here: run \`alpo unlink ${lib}\` first`);
  const config = readConfig(root);
  delete config.libs[lib];
  if (Object.keys(config.libs).length) writeConfig(root, config);
  else {
    // `git rm` stages the deletion of a committed config; one never committed, or outside git, is just removed.
    if (!git(root, 'rm', '--quiet', '--force', CONFIG).ok) rmSync(join(root, CONFIG), { force: true });
    unregister(root);
  }
}
