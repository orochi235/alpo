import { existsSync } from 'node:fs';
import {
  type Config,
  expandHome,
  type LibConfig,
  type Link,
  libOf,
  readConfig,
  readLocal,
  tildify,
  today,
  type Via,
  writeLocal,
} from './config.ts';
import { type BumpResult, checkoutOf, linkedCheckout, type Platform, realTools } from './platform.ts';
import { go } from './platforms/go.ts';
import { node } from './platforms/node.ts';
import { swift } from './platforms/swift.ts';
import { contains, fetchTags, offTrunk, tagFor } from './release.ts';
import { git } from './sh.ts';
import { writeTypePaths } from './typepaths.ts';

export { type BumpResult, bumpMessage, checkoutOf, realTools, Skip, type Tools } from './platform.ts';
export { pinsOf } from './platforms/node.ts';

/** The platform a `via` belongs to. */
export const platformOf = (via: Via): Platform => (via === 'edit' ? swift : via === 'work' ? go : node);

export const PLATFORMS: Array<{ platform: Platform; vias: Via[] }> = [
  { platform: node, vias: ['vite', 'file'] },
  { platform: swift, vias: ['edit'] },
  { platform: go, vias: ['work'] },
];

/** Keeps tsc's view of a vite library's links matching the dev server's. */
function syncTypes(root: string, lib: LibConfig) {
  if (lib.via === 'vite') writeTypePaths(root);
}

export function link(
  root: string,
  name: string,
  opts: { for?: string; needs?: string[]; from?: string },
  tools = realTools,
): Link {
  const lib = libOf(readConfig(root), name);
  const from = opts.from ? tildify(expandHome(opts.from)) : undefined;
  const checkout = linkedCheckout(root, lib, from ? { from, needs: [], since: '' } : undefined);
  if (!existsSync(checkout)) throw new Error(`no checkout at ${from ?? lib.repo}`);
  const needs = (opts.needs?.length ? opts.needs : ['HEAD']).map((rev) => {
    const r = git(checkout, 'rev-parse', '--verify', `${rev}^{commit}`);
    if (!r.ok) throw new Error(`${rev} is not a commit in ${lib.repo}`);
    return r.stdout;
  });
  const prior = readLocal(root).links[name];
  const entry: Link = { ...(opts.for ? { for: opts.for } : {}), ...(from ? { from } : {}), needs, since: today() };
  platformOf(lib.via).link(root, name, lib, checkout, entry, tools, prior);
  const local = readLocal(root);
  local.links[name] = entry;
  writeLocal(root, local);
  syncTypes(root, lib);
  return entry;
}

export function unlink(root: string, name: string, tools = realTools) {
  const lib = libOf(readConfig(root), name);
  const local = readLocal(root);
  const entry = local.links[name];
  if (!entry) return false;
  platformOf(lib.via).unlink(root, name, lib, linkedCheckout(root, lib, entry), entry, tools);
  delete local.links[name];
  writeLocal(root, local);
  syncTypes(root, lib);
  return true;
}

/**
 * Moves the library's pins to `version`, or each package's latest release, verifies the result builds against
 * the release, commits just the package files, and drops any link. A failure puts those files back and leaves
 * the link in place.
 */
export async function bump(
  root: string,
  name: string,
  opts: { version?: string; exact?: boolean } = {},
  tools = realTools,
): Promise<BumpResult> {
  const lib = libOf(readConfig(root), name);
  const local = readLocal(root);
  const entry = local.links[name];
  const r = await platformOf(lib.via).bump(root, name, lib, linkedCheckout(root, lib, entry), entry, opts, tools);
  delete local.links[name];
  writeLocal(root, local);
  syncTypes(root, lib);
  return r;
}

export interface Status {
  root: string;
  lib: string;
  config: LibConfig;
  /** One per dependency on the library, by manifest: the same package pinned in two workspaces is two pins. */
  pins: Array<{ manifest: string; name: string; spec: string; range?: string; latest?: string; locked?: string }>;
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
      const platform = platformOf(cfg.via);
      const checkout = linkedCheckout(root, cfg, local.links[lib]);
      const found = platform.pins(root, cfg);
      const names = [...new Set(found.map((p) => p.name))];
      const ctx = { root, checkout, fresh: opts.fresh };
      const versions = new Map(await Promise.all(names.map(async (n) => [n, await platform.latest(n, ctx)] as const)));
      const pins = found.map(({ manifest, name, spec, range, locked }) => ({
        manifest,
        name,
        spec,
        ...(range ? { range } : {}),
        latest: versions.get(name),
        ...(locked ? { locked } : {}),
      }));
      const out: Status = { root, lib, config: cfg, pins, link: local.links[lib] };
      const released = names.flatMap((n) => {
        const v = versions.get(n);
        return v ? [{ name: n, version: v }] : [];
      });
      if (released.length && existsSync(checkout)) {
        if (opts.fetch) {
          const f = fetchTags(checkout, opts.fresh);
          if (!f.ok) out.fetchError = f.error;
        }
        const tags = released.map((r) => ({ ...r, tag: tagFor(checkout, platform.tags(checkout, r.name, r.version)) }));
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
