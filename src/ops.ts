import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { join, relative } from 'node:path';
import {
  type Config,
  expandHome,
  type LibConfig,
  type Link,
  libOf,
  matches,
  readConfig,
  readLocal,
  today,
  writeLocal,
} from './config.ts';
import { contains, fetchTags, latest, offTrunk, tagFor } from './release.ts';
import { git, type Result, run } from './sh.ts';
import { depsOf, type Manifest, manifests, packagesIn, setSpec, writeManifest } from './workspaces.ts';

export interface Tools {
  /** Runs npm in the repository root; tests swap it for a stub. */
  npm: (root: string, args: string[]) => Result;
}

export const realTools: Tools = { npm: (root, args) => run('npm', args, root) };

export class Skip extends Error {}

export const checkoutOf = (root: string, lib: LibConfig) => expandHome(lib.repo, root);

/** The consumer's dependencies this library supplies, by manifest. */
export function pinsOf(root: string, lib: LibConfig): Array<{ m: Manifest; name: string; spec: string }> {
  return manifests(root).flatMap((m) =>
    depsOf(m)
      .filter((d) => matches(lib.packages, d.name))
      .map((d) => ({ m, name: d.name, spec: d.spec })),
  );
}

export function link(root: string, name: string, opts: { for?: string; needs?: string[] }, tools = realTools): Link {
  const lib = libOf(readConfig(root), name);
  const checkout = checkoutOf(root, lib);
  if (!existsSync(checkout)) throw new Error(`no checkout at ${lib.repo}`);
  const needs = (opts.needs?.length ? opts.needs : ['HEAD']).map((rev) => {
    const r = git(checkout, 'rev-parse', '--verify', `${rev}^{commit}`);
    if (!r.ok) throw new Error(`${rev} is not a commit in ${lib.repo}`);
    return r.stdout;
  });
  const local = readLocal(root);
  const prior = local.links[name];
  const entry: Link = { ...(opts.for ? { for: opts.for } : {}), needs, since: today() };

  if (lib.via === 'file') {
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
    local.links[name] = entry;
    writeLocal(root, local);
    const r = tools.npm(root, ['install']);
    if (!r.ok) throw new Error(`npm install failed after linking; \`alpo unlink ${name}\` puts the specs back:\n${r.stderr}`);
    return entry;
  }
  local.links[name] = entry;
  writeLocal(root, local);
  return entry;
}

/** Puts a `file` link's manifests back as they were; a `vite` link needs nothing but the local file. */
function restore(root: string, saved: Link['saved']) {
  for (const m of manifests(root)) {
    const specs = saved?.[m.path];
    if (!specs) continue;
    for (const [dep, spec] of Object.entries(specs)) setSpec(m, dep, spec);
    writeManifest(m);
  }
}

export function unlink(root: string, name: string, tools = realTools) {
  const lib = libOf(readConfig(root), name);
  const local = readLocal(root);
  const entry = local.links[name];
  if (!entry) return false;
  if (lib.via === 'file') {
    restore(root, entry.saved);
    const r = tools.npm(root, ['install']);
    if (!r.ok) throw new Error(`npm install failed after unlinking:\n${r.stderr}`);
  }
  delete local.links[name];
  writeLocal(root, local);
  return true;
}

export interface BumpResult {
  changed: Array<{ name: string; from: string; to: string }>;
  commit?: string;
}

/**
 * Pins every package the library supplies to an exact version — `version` for all of them, or each
 * one's npm `latest` — installs, typechecks, and commits just the manifests and lockfile. A failure
 * puts those files back and leaves any link in place.
 */
export async function bump(root: string, name: string, version?: string, tools = realTools): Promise<BumpResult> {
  const lib = libOf(readConfig(root), name);
  const local = readLocal(root);
  const entry = local.links[name];
  const manifestPaths = manifests(root).map((m) => m.path);
  const files = [...new Set([...manifestPaths, 'package-lock.json'])].filter((f) => existsSync(join(root, f)));
  const linked = lib.via === 'file' && !!entry;
  // A `file` link has its manifests modified on purpose; anything else in them is someone's work in progress.
  if (!linked) {
    const dirty = git(root, 'status', '--porcelain', '--', ...files).stdout;
    if (dirty) throw new Skip(`package files have uncommitted changes:\n${dirty}`);
  }

  // The bytes as they stood, so a failure anywhere below restores exactly this, link included.
  const snapshot = new Map<string, Buffer | null>(
    [...manifestPaths, 'package-lock.json'].map((f) => [f, existsSync(join(root, f)) ? readFileSync(join(root, f)) : null]),
  );
  let installed = false;
  const putBack = () => {
    for (const [f, bytes] of snapshot) {
      if (bytes) writeFileSync(join(root, f), bytes);
      else rmSync(join(root, f), { force: true });
    }
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
    const targets = new Map<string, string>();
    for (const dep of new Set(pins.map((p) => p.name))) {
      const to = version ?? (await latest(dep, true, root));
      if (!to) throw new Error(`npm has no version of ${dep}`);
      targets.set(dep, to);
    }
    const changed: BumpResult['changed'] = [];
    for (const { m, name: dep, spec } of pins) {
      const to = targets.get(dep)!;
      if (spec === to) continue;
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

    let commit: string | undefined;
    if (changed.length) {
      const tracked = files.filter((f) => git(root, 'ls-files', '--error-unmatch', f).ok);
      const c = git(root, 'commit', '--quiet', '-m', bumpMessage(lib, changed), '--', ...tracked);
      if (!c.ok) throw new Error(`commit failed; package files put back:\n${c.stderr}`);
      commit = git(root, 'rev-parse', '--short', 'HEAD').stdout;
    }
    delete local.links[name];
    writeLocal(root, local);
    return commit ? { changed, commit } : { changed };
  } catch (e) {
    const trouble = putBack();
    if (trouble && e instanceof Error) e.message += trouble;
    throw e;
  }
}

export function bumpMessage(lib: LibConfig, changed: BumpResult['changed']): string {
  const versions = new Set(changed.map((c) => c.to));
  if (versions.size === 1 && changed.length > 1) return `bump ${lib.packages.join(', ')} to ${[...versions][0]}`;
  return `bump ${changed.map((c) => `${c.name} to ${c.to}`).join(', ')}`;
}

export interface Status {
  root: string;
  lib: string;
  config: LibConfig;
  /** One per dependency on the library, by manifest: the same package pinned in two workspaces is two pins. */
  pins: Array<{ manifest: string; name: string; spec: string; latest?: string }>;
  link?: Link;
  /** For a link: whether every package's latest release has a tag containing every commit it needs. */
  covered?: boolean;
  /** Packages whose latest release left no tag in the checkout. */
  untagged?: string[];
  /** For a link: needed commits the remote's default branch lacks, so no release will contain them. */
  offTrunk?: string[];
  /** Why the checkout's tags could not be fetched, when they could not. */
  fetchError?: string;
}

export async function status(root: string, opts: { fetch?: boolean; fresh?: boolean } = {}): Promise<Status[]> {
  const config: Config = readConfig(root);
  const local = readLocal(root);
  return Promise.all(
    Object.entries(config.libs).map(async ([lib, cfg]) => {
      const found = pinsOf(root, cfg);
      const names = [...new Set(found.map((p) => p.name))];
      const versions = new Map(await Promise.all(names.map(async (n) => [n, await latest(n, opts.fresh, root)] as const)));
      const pins = found.map(({ m, name, spec }) => ({ manifest: m.path, name, spec, latest: versions.get(name) }));
      const out: Status = { root, lib, config: cfg, pins, link: local.links[lib] };
      const checkout = checkoutOf(root, cfg);
      const released = names.flatMap((n) => {
        const v = versions.get(n);
        return v ? [{ name: n, version: v }] : [];
      });
      if (released.length && existsSync(checkout)) {
        if (opts.fetch) {
          const f = fetchTags(checkout, opts.fresh);
          if (!f.ok) out.fetchError = f.error;
        }
        const tags = released.map((r) => ({ ...r, tag: tagFor(checkout, r.name, r.version) }));
        const untagged = tags.filter((t) => !t.tag).map((t) => t.name);
        if (untagged.length) out.untagged = untagged;
        if (out.link) {
          // Every package, not the first: each moves to its own latest on a bump, so each must carry the commits.
          out.covered =
            released.length === names.length &&
            tags.every((t) => t.tag && contains(checkout, t.tag, out.link!.needs));
          const off = offTrunk(checkout, out.link.needs);
          if (off.length && !out.covered) out.offTrunk = off;
        }
      }
      return out;
    }),
  );
}
