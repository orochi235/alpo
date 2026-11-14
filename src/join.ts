import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expandHome, type LibConfig, LOCAL, readConfig, readLocal, type Via, writeConfig } from './config.ts';
import { register, unregister } from './home.ts';
import { git } from './sh.ts';
import { depsOf, manifests, packagesIn } from './workspaces.ts';

/** `@scope/*` when every package the checkout supplies shares one scope; otherwise their names. */
export function defaultPackages(checkout: string): string[] {
  const names = [...packagesIn(checkout).keys()];
  const scopes = new Set(names.map((n) => (n.startsWith('@') ? n.split('/')[0] : '')));
  const [scope] = scopes;
  return scopes.size === 1 && scope ? [`${scope}/*`] : names.sort();
}

const usesVite = (root: string) => manifests(root).some((m) => depsOf(m).some((d) => d.name === 'vite'));

/** Vite configs under the root that don't load the plugin yet. */
export function unwiredViteConfigs(root: string): string[] {
  const dirs = manifests(root).map((m) => m.dir);
  return dirs.flatMap((dir) =>
    readdirSync(dir)
      .filter((f) => /^vite\.config\.[cm]?[jt]s$/.test(f))
      .map((f) => join(dir, f))
      .filter((f) => !readFileSync(f, 'utf8').includes('@msb235/tether/vite')),
  );
}

function ignoreLocal(root: string) {
  const path = join(root, '.gitignore');
  const text = existsSync(path) ? readFileSync(path, 'utf8') : '';
  if (text.split('\n').some((l) => l.trim() === LOCAL)) return;
  writeFileSync(path, `${text}${text && !text.endsWith('\n') ? '\n' : ''}${LOCAL}\n`);
}

export function joinLib(root: string, lib: string, opts: { repo?: string; packages?: string[]; via?: Via }): LibConfig {
  const repo = opts.repo ?? `~/src/${lib}`;
  const checkout = expandHome(repo);
  if (!existsSync(join(checkout, 'package.json'))) throw new Error(`no package at ${repo}; pass --repo`);
  const entry: LibConfig = {
    packages: opts.packages?.length ? opts.packages : defaultPackages(checkout),
    repo,
    via: opts.via ?? (usesVite(root) ? 'vite' : 'file'),
  };
  const config = readConfig(root);
  config.libs[lib] = entry;
  writeConfig(root, config);
  ignoreLocal(root);
  register(root);
  return entry;
}

export function leaveLib(root: string, lib: string) {
  if (readLocal(root).links[lib]) throw new Error(`${lib} is linked here: run \`tether unlink ${lib}\` first`);
  const config = readConfig(root);
  delete config.libs[lib];
  if (Object.keys(config.libs).length) writeConfig(root, config);
  else {
    git(root, 'rm', '--quiet', '--force', '.tether.json');
    unregister(root);
  }
}
