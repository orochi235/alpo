import { existsSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { valid } from 'semver';
import { type LibConfig, type Link, matches, readLocal, writeLocal } from '../config.ts';
import {
  type BumpResult,
  bumpMessage,
  commitFiles,
  type Pin,
  type Platform,
  requireClean,
  Skip,
  snapshot,
  targetsFor,
  type Tools,
} from '../platform.ts';
import { lockedOf, readLock, settled } from '../pins.ts';
import { latest } from '../release.ts';
import { git } from '../sh.ts';
import { depsOf, type Manifest, manifests, packagesIn, setSpec, writeManifest } from '../workspaces.ts';

/** `@scope/*` when every package the checkout publishes shares one scope; otherwise their names. */
export function defaultPackages(checkout: string): string[] {
  const names = manifests(checkout).flatMap((m) => (m.json.name && !m.json.private ? [m.json.name] : []));
  const scopes = new Set(names.map((n) => (n.startsWith('@') ? n.split('/')[0] : '')));
  const [scope] = scopes;
  return scopes.size === 1 && scope ? [`${scope}/*`] : names.sort();
}

/** The consumer's dependencies this library supplies, by manifest. */
export function pinsOf(root: string, lib: LibConfig): Array<{ m: Manifest; name: string; spec: string }> {
  return manifests(root).flatMap((m) =>
    depsOf(m)
      .filter((d) => matches(lib.packages, d.name))
      .map((d) => ({ m, name: d.name, spec: d.spec })),
  );
}

/** Puts a `file` link's manifests back as they were. */
function restore(root: string, saved: Link['saved']) {
  for (const m of manifests(root)) {
    const specs = saved?.[m.path];
    if (!specs) continue;
    for (const [dep, spec] of Object.entries(specs)) setSpec(m, dep, spec);
    writeManifest(m);
  }
}

function linkFile(root: string, name: string, lib: LibConfig, checkout: string, entry: Link, tools: Tools, prior?: Link) {
  entry.saved = prior?.saved ?? {};
  const supplied = packagesIn(checkout);
  for (const { m, name: dep, spec } of pinsOf(root, lib)) {
    const dir = supplied.get(dep);
    if (!dir) continue;
    // Per dependency, so one added since the first link still gets its spec saved.
    const saved = (entry.saved[m.path] ??= {});
    if (!(dep in saved) && !spec.startsWith('file:')) saved[dep] = spec;
    setSpec(m, dep, `file:${relative(m.dir, dir)}`);
    writeManifest(m);
  }
  // Saved before installing, so a failed install still leaves `unlink` the original specs.
  const local = readLocal(root);
  local.links[name] = entry;
  writeLocal(root, local);
  const r = tools.npm(root, ['install']);
  if (!r.ok) throw new Error(`npm install failed after linking; \`alpo unlink ${name}\` puts the specs back:\n${r.stderr}`);
}

/**
 * Moves every package the library supplies to `version`, or each one's npm `latest`, installs, typechecks,
 * and commits just the manifests and lockfile. A range that already admits the target, over a lockfile that
 * installs it, is left alone unless `exact`, which pins every package exactly. A failure puts those files
 * back and leaves any link in place.
 */
async function bump(
  root: string,
  _name: string,
  lib: LibConfig,
  _checkout: string,
  entry: Link | undefined,
  { version, exact }: { version?: string; exact?: boolean },
  tools: Tools,
): Promise<BumpResult> {
  const manifestPaths = manifests(root).map((m) => m.path);
  const files = [...new Set([...manifestPaths, 'package-lock.json'])];
  const linked = lib.via === 'file' && !!entry;
  // A `file` link has its manifests modified on purpose; anything else in them is someone's work in progress.
  if (!linked) requireClean(root, files);

  // The bytes as they stood, so a failure anywhere below restores exactly this, link included.
  const putFilesBack = snapshot(root, files);
  let installed = false;
  const putBack = () => {
    putFilesBack();
    if (!installed) return '';
    const r = tools.npm(root, ['install']);
    return r.ok ? '' : `\nnpm install failed while putting the package files back; node_modules may not match them:\n${r.stderr}`;
  };

  try {
    if (linked) {
      restore(root, entry?.saved);
      const edited = manifestPaths.filter((f) => {
        const head = git(root, 'show', `HEAD:./${f}`);
        return head.ok && !isDeepStrictEqual(JSON.parse(head.stdout), JSON.parse(readFileSync(join(root, f), 'utf8')));
      });
      if (edited.length) throw new Skip(`package files have uncommitted changes beyond the link:\n${edited.join('\n')}`);
    }

    const pins = pinsOf(root, lib);
    // A `file` link's working lockfile resolves to the checkout; the committed one says what npm installs.
    const head = linked ? git(root, 'show', 'HEAD:./package-lock.json') : undefined;
    const lock = head ? (head.ok ? JSON.parse(head.stdout) : undefined) : readLock(root);
    const targets = await targetsFor(
      pins.map((p) => ({ manifest: p.m.path, name: p.name, spec: p.spec })),
      version,
      (dep) => latest(dep, true, root),
    );
    const changed: BumpResult['changed'] = [];
    for (const { m, name: dep, spec } of pins) {
      const to = targets.get(dep)!;
      if (exact ? spec === to : settled(spec, to, lockedOf(lock, m.path, dep))) continue;
      setSpec(m, dep, to);
      writeManifest(m);
      if (!changed.some((c) => c.name === dep)) changed.push({ name: dep, from: spec, to });
    }

    // A `file` link's restored specs need an install even when no pin moved, or node_modules stays on the checkout.
    if (changed.length || linked) {
      const steps: Array<[string, string[]]> = [
        ['npm install', ['install']],
        ['typecheck', ['run', 'typecheck', '--if-present']],
      ];
      for (const [label, args] of steps) {
        installed ||= label === 'npm install';
        const r = tools.npm(root, args);
        if (!r.ok) throw new Error(`${label} failed after the bump; package files put back:\n${r.stderr || r.stdout}`);
      }
    }
    return changed.length ? { changed, commit: commitFiles(root, files, bumpMessage(lib, changed)) } : { changed };
  } catch (e) {
    const trouble = putBack();
    if (trouble && e instanceof Error) e.message += trouble;
    throw e;
  }
}

export const node: Platform = {
  marker: 'package.json',
  supplied: (checkout) => [...packagesIn(checkout).keys()],
  defaultPackages,
  pins(root, lib) {
    const lock = readLock(root);
    return pinsOf(root, lib).map(({ m, name, spec }): Pin => {
      const locked = lockedOf(lock, m.path, name);
      return { manifest: m.path, name, spec, range: spec, ...(valid(spec) ? { exact: spec } : {}), ...(locked ? { locked } : {}) };
    });
  },
  latest: (name, { root, fresh }) => latest(name, fresh, root),
  tags: (_checkout, name, version) => [`${name}@${version}`, `v${version}`, version],
  link(root, name, lib, checkout, entry, tools, prior) {
    if (lib.via === 'file') linkFile(root, name, lib, checkout, entry, tools, prior);
  },
  unlink(root, _name, lib, _checkout, entry, tools) {
    if (lib.via !== 'file') return;
    restore(root, entry.saved);
    const r = tools.npm(root, ['install']);
    if (!r.ok) throw new Error(`npm install failed after unlinking:\n${r.stderr}`);
  },
  bump,
};

export const usesVite = (root: string) =>
  existsSync(join(root, 'package.json')) && manifests(root).some((m) => depsOf(m).some((d) => d.name === 'vite'));
