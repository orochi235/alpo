import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { rsort, valid } from 'semver';
import { expandHome, type LibConfig, type Link } from './config.ts';
import { fetchTags } from './release.ts';
import { git, type Result, run } from './sh.ts';

/** The package managers alpo drives; tests swap each for a stub. Go runs with `env` over the process's. */
export interface Tools {
  npm: (root: string, args: string[]) => Result;
  swift: (root: string, args: string[]) => Result;
  go: (root: string, args: string[], env?: Record<string, string>) => Result;
}

export const realTools: Tools = {
  npm: (root, args) => run('npm', args, root),
  swift: (root, args) => run('swift', args, root),
  go: (root, args, env) => run('go', args, root, undefined, env),
};

/** A repository left alone on purpose, which `bump --all` and `sweep` report and pass over. */
export class Skip extends Error {}

export const checkoutOf = (root: string, lib: LibConfig) => expandHome(lib.repo, root);

/** The checkout a link serves: the one it was made `--from`, or the configured one. */
export const linkedCheckout = (root: string, lib: LibConfig, link?: Link) =>
  link?.from ? expandHome(link.from, root) : checkoutOf(root, lib);

/** One dependency of the consumer's on a package the library supplies. */
export interface Pin {
  /** The manifest declaring it, as a path from the root. */
  manifest: string;
  name: string;
  /** The requirement as the manifest spells it. */
  spec: string;
  /** The requirement as a semver range, when it is one; a path or branch has none. */
  range?: string;
  /** The version the spec names alone, when it admits no other. */
  exact?: string;
  /** The version the lockfile resolves it to. */
  locked?: string;
}

export interface BumpResult {
  changed: Array<{ name: string; from: string; to: string }>;
  commit?: string;
}

export interface Platform {
  /** The file marking a directory as a package of this platform's. */
  marker: string;
  /** Every package name the checkout supplies. */
  supplied(checkout: string): string[];
  /** What `join` takes when `--packages` is not given. */
  defaultPackages(checkout: string): string[];
  pins(root: string, lib: LibConfig): Pin[];
  /** The newest release of `name`, as bare semver. */
  latest(name: string, ctx: { root: string; checkout: string; fresh?: boolean }): Promise<string | undefined>;
  /** The tag spellings a release of `name` at `version` may have left in the checkout, most specific first. */
  tags(checkout: string, name: string, version: string): string[];
  /** Files `join` adds to `.gitignore` beside `.alpo.local.json`. */
  ignores?(root: string): string[];
  /** Serves the checkout; `prior` is the link this one replaces, if any. */
  link(root: string, name: string, lib: LibConfig, checkout: string, entry: Link, tools: Tools, prior?: Link): void;
  unlink(root: string, name: string, lib: LibConfig, checkout: string, entry: Link, tools: Tools): void;
  bump(
    root: string,
    name: string,
    lib: LibConfig,
    checkout: string,
    entry: Link | undefined,
    opts: { version?: string; exact?: boolean },
    tools: Tools,
  ): Promise<BumpResult>;
}

/** The newest stable release among a checkout's tags named `<prefix><version>` or `<prefix>v<version>`. */
export function newestTag(checkout: string, prefix = '', keep: (version: string) => boolean = () => true, fresh = false) {
  fetchTags(checkout, fresh);
  const tags = git(checkout, 'tag', '--list').stdout.split('\n');
  const versions = tags.flatMap((t) => {
    if (!t.startsWith(prefix)) return [];
    const v = valid(t.slice(prefix.length).replace(/^v/, ''));
    return v && !v.includes('-') && keep(v) ? [v] : [];
  });
  return rsort(versions)[0] as string | undefined;
}

/** Refuses package files with uncommitted changes; an untracked one is not committed by a bump, so it passes. */
export function requireClean(root: string, files: string[]) {
  const present = files.filter((f) => existsSync(join(root, f)));
  if (!present.length) return;
  const dirty = git(root, 'status', '--porcelain', '--untracked-files=no', '--', ...present).stdout;
  if (dirty) throw new Skip(`package files have uncommitted changes:\n${dirty}`);
}

/** The files' bytes as they stand, and a function writing exactly those back, deleting any that did not exist. */
export function snapshot(root: string, files: string[]): () => void {
  const saved = new Map(files.map((f) => [f, existsSync(join(root, f)) ? readFileSync(join(root, f)) : null]));
  return () => {
    for (const [f, bytes] of saved) {
      if (bytes) writeFileSync(join(root, f), bytes);
      else rmSync(join(root, f), { force: true });
    }
  };
}

/** Commits the tracked ones among `files` alone, leaving the rest of the tree as it is; the short hash. */
export function commitFiles(root: string, files: string[], message: string): string {
  const tracked = files.filter((f) => existsSync(join(root, f)) && git(root, 'ls-files', '--error-unmatch', f).ok);
  const c = git(root, 'commit', '--quiet', '-m', message, '--', ...tracked);
  if (!c.ok) throw new Error(`commit failed; package files put back:\n${c.stderr}`);
  return git(root, 'rev-parse', '--short', 'HEAD').stdout;
}

/** Each pinned package's target: `version` for all, or each one's own latest release. */
export async function targetsFor(
  pins: Pin[],
  version: string | undefined,
  latest: (name: string) => Promise<string | undefined>,
): Promise<Map<string, string>> {
  const targets = new Map<string, string>();
  for (const name of new Set(pins.map((p) => p.name))) {
    const to = version?.replace(/^v/, '') ?? (await latest(name));
    if (!to) throw new Error(`no release of ${name} found`);
    targets.set(name, to);
  }
  return targets;
}

export function bumpMessage(lib: LibConfig, changed: BumpResult['changed']): string {
  const versions = new Set(changed.map((c) => c.to));
  if (versions.size === 1 && changed.length > 1) return `bump ${lib.packages.join(', ')} to ${[...versions][0]}`;
  return `bump ${changed.map((c) => `${c.name} to ${c.to}`).join(', ')}`;
}
