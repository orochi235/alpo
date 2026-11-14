import { existsSync } from 'node:fs';
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
import { contains, fetchTags, latest, tagFor } from './release.ts';
import { git, type Result, run } from './sh.ts';
import { depsOf, type Manifest, manifests, packagesIn, setSpec, writeManifest } from './workspaces.ts';

export interface Tools {
  /** Runs npm in the repository root; tests swap it for a stub. */
  npm: (root: string, args: string[]) => Result;
}

export const realTools: Tools = { npm: (root, args) => run('npm', args, root) };

export class Skip extends Error {}

export const checkoutOf = (lib: LibConfig) => expandHome(lib.repo);

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
  const checkout = checkoutOf(lib);
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
      if (!prior) (entry.saved[m.path] ??= {})[dep] = spec;
      setSpec(m, dep, `file:${relative(m.dir, dir)}`);
      writeManifest(m);
    }
    const r = tools.npm(root, ['install']);
    if (!r.ok) throw new Error(`npm install failed after linking:\n${r.stderr}`);
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
  const files = [...new Set([...manifests(root).map((m) => m.path), 'package-lock.json'])].filter((f) =>
    existsSync(join(root, f)),
  );
  // A `file` link has its manifests modified on purpose; anything else in them is someone's work in progress.
  if (!(lib.via === 'file' && entry)) {
    const dirty = git(root, 'status', '--porcelain', '--', ...files).stdout;
    if (dirty) throw new Skip(`package files have uncommitted changes:\n${dirty}`);
  }
  if (lib.via === 'file' && entry) restore(root, entry.saved);

  const pins = pinsOf(root, lib);
  const targets = new Map<string, string>();
  for (const dep of new Set(pins.map((p) => p.name))) {
    const to = version ?? (await latest(dep, true));
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

  const putBack = () => {
    git(root, 'checkout', '--', ...files);
    tools.npm(root, ['install']);
  };
  if (changed.length) {
    const steps: Array<[string, string[]]> = [
      ['npm install', ['install']],
      ['typecheck', ['run', 'typecheck', '--if-present']],
    ];
    for (const [label, args] of steps) {
      const r = tools.npm(root, args);
      if (!r.ok) {
        putBack();
        if (lib.via === 'file' && entry) link(root, name, { for: entry.for, needs: entry.needs }, tools);
        throw new Error(`${label} failed after the bump; package files put back:\n${r.stderr || r.stdout}`);
      }
    }
  }
  delete local.links[name];
  writeLocal(root, local);
  if (!changed.length) return { changed };

  const tracked = files.filter((f) => git(root, 'ls-files', '--error-unmatch', f).ok);
  const commit = git(root, 'commit', '--quiet', '-m', bumpMessage(lib, changed), '--', ...tracked);
  if (!commit.ok) throw new Error(`commit failed:\n${commit.stderr}`);
  return { changed, commit: git(root, 'rev-parse', '--short', 'HEAD').stdout };
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
  pins: Array<{ name: string; spec: string; latest?: string }>;
  link?: Link;
  /** The tag of the latest release, when the checkout has it. */
  tag?: string;
  /** For a link: whether the latest release contains every commit it needs. */
  covered?: boolean;
}

export async function status(root: string, opts: { fetch?: boolean; fresh?: boolean } = {}): Promise<Status[]> {
  const config: Config = readConfig(root);
  const local = readLocal(root);
  return Promise.all(
    Object.entries(config.libs).map(async ([lib, cfg]) => {
      const seen = new Map<string, string>();
      for (const p of pinsOf(root, cfg)) if (!seen.has(p.name)) seen.set(p.name, p.spec);
      const pins = await Promise.all(
        [...seen].map(async ([name, spec]) => ({ name, spec, latest: await latest(name, opts.fresh) })),
      );
      const out: Status = { root, lib, config: cfg, pins, link: local.links[lib] };
      const lead = pins.find((p) => p.latest);
      const checkout = checkoutOf(cfg);
      if (lead?.latest && existsSync(checkout)) {
        if (opts.fetch) fetchTags(checkout, opts.fresh);
        out.tag = tagFor(checkout, lead.name, lead.latest);
        if (out.link) out.covered = !!out.tag && contains(checkout, out.tag, out.link.needs);
      }
      return out;
    }),
  );
}
