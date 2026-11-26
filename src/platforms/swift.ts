import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { major, minor, valid } from 'semver';
import { type LibConfig, type Link, matches } from '../config.ts';
import {
  type BumpResult,
  bumpMessage,
  commitFiles,
  newestTag,
  type Pin,
  type Platform,
  requireClean,
  snapshot,
  targetsFor,
  type Tools,
} from '../platform.ts';
import { settled } from '../pins.ts';
import { git } from '../sh.ts';

const MANIFEST = 'Package.swift';
const RESOLVED = 'Package.resolved';

/** SwiftPM's identity for a location: its last path component, lowercased, less any `.git`. */
export const identityOf = (location: string): string =>
  basename(location.replace(/\/+$/, '').replace(/^.*:/, '')).replace(/\.git$/, '').toLowerCase();

/** One `.package(…)` in a manifest, with where its parts sit in the text. */
export interface Dependency {
  identity: string;
  kind: 'url' | 'path';
  location: string;
  /** The requirement as written (`from: "1.2.0"`); empty for a path. */
  requirement: string;
  /** The span of the whole argument list, between the parentheses. */
  args: [number, number];
  /** The span of the requirement, after the location's comma. */
  req: [number, number];
}

/** The index just past the `)` closing the `(` at `open`, skipping string literals. */
function closing(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === '\\') i++;
    } else if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return i + 1;
  }
  throw new Error(`${MANIFEST}: unbalanced parentheses`);
}

/** Every `.package(url:…)` and `.package(path:…)` in a manifest's text. */
export function dependencies(text: string): Dependency[] {
  const found: Dependency[] = [];
  for (const m of text.matchAll(/\.package\s*\(/g)) {
    const open = m.index + m[0].length - 1;
    const end = closing(text, open);
    const inner = text.slice(open + 1, end - 1);
    const loc = /\b(url|path)\s*:\s*"([^"]+)"\s*,?\s*/.exec(inner);
    if (!loc) continue;
    const reqStart = open + 1 + loc.index + loc[0].length;
    found.push({
      identity: identityOf(loc[2]),
      kind: loc[1] as 'url' | 'path',
      location: loc[2],
      requirement: text.slice(reqStart, end - 1).trim(),
      args: [open + 1, end - 1],
      req: [reqStart, end - 1],
    });
  }
  return found;
}

const bound = (v: string) => (valid(v) ? v : undefined);

/** A requirement as a semver range, and the one version it admits when it admits only one. */
export function rangeOf(requirement: string): { range?: string; exact?: string } {
  const r = requirement.replace(/\s+/g, ' ');
  let m: RegExpExecArray | null;
  if ((m = /^(?:from: |\.upToNextMajor\(from: )"([^"]+)"\)?$/.exec(r)) && bound(m[1]))
    return { range: `>=${m[1]} <${major(m[1]) + 1}.0.0` };
  if ((m = /^\.upToNextMinor\(from: "([^"]+)"\)$/.exec(r)) && bound(m[1]))
    return { range: `>=${m[1]} <${major(m[1])}.${minor(m[1]) + 1}.0` };
  if ((m = /^(?:exact: |\.exact\()"([^"]+)"\)?$/.exec(r)) && bound(m[1])) return { range: m[1], exact: m[1] };
  if ((m = /^"([^"]+)" ?\.\.< ?"([^"]+)"$/.exec(r)) && bound(m[1]) && bound(m[2])) return { range: `>=${m[1]} <${m[2]}` };
  if ((m = /^"([^"]+)" ?\.\.\. ?"([^"]+)"$/.exec(r)) && bound(m[1]) && bound(m[2])) return { range: `>=${m[1]} <=${m[2]}` };
  return {};
}

/** The requirement that moves `dep` to `to`, keeping its shape where the shape still fits. */
function moved(dep: Dependency, to: string, exact: boolean): string {
  if (exact || /^(exact:|\.exact\()/.test(dep.requirement)) return `exact: "${to}"`;
  if (dep.requirement.startsWith('.upToNextMinor')) return `.upToNextMinor(from: "${to}")`;
  return `from: "${to}"`;
}

type Resolved = { pins?: Array<{ identity: string; state?: { version?: string } }>; object?: { pins?: Array<{ package: string; repositoryURL: string; state?: { version?: string } }> } };

/** The version `Package.resolved` holds for each identity. */
function lockedVersions(root: string): Map<string, string> {
  const path = join(root, RESOLVED);
  if (!existsSync(path)) return new Map();
  const json = JSON.parse(readFileSync(path, 'utf8')) as Resolved;
  const pins = json.pins?.map((p) => [p.identity, p.state?.version] as const) ??
    json.object?.pins?.map((p) => [identityOf(p.repositoryURL), p.state?.version] as const) ?? [];
  return new Map(pins.flatMap(([id, v]) => (v ? [[id, v] as [string, string]] : [])));
}

const depsIn = (root: string, lib: LibConfig) =>
  existsSync(join(root, MANIFEST))
    ? dependencies(readFileSync(join(root, MANIFEST), 'utf8')).filter((d) => matches(lib.packages, d.identity))
    : [];

/** The identity a checkout is known by: its origin's last path component, or its directory's name. */
function identityOfCheckout(checkout: string): string {
  const origin = git(checkout, 'remote', 'get-url', 'origin');
  return identityOf(origin.ok ? origin.stdout : checkout);
}

/** A URL a manifest can name the checkout's origin by: GitHub's over https, so it resolves without an ssh key. */
function urlOf(checkout: string): string {
  const origin = git(checkout, 'remote', 'get-url', 'origin');
  if (!origin.ok) throw new Error(`${checkout} has no origin for ${MANIFEST} to name`);
  return origin.stdout.replace(/^git@github\.com:/, 'https://github.com/');
}

function edit(root: string, ids: string[], checkout: string, tools: Tools) {
  for (const id of ids) {
    const r = tools.swift(root, ['package', 'edit', id, '--path', checkout]);
    if (!r.ok) throw new Error(`swift package edit ${id} failed:\n${r.stderr || r.stdout}`);
  }
}

/** Ends editing; a package no longer in edit mode (its `.build` cleaned, say) is already where unedit leaves it. */
function unedit(root: string, ids: string[], tools: Tools) {
  for (const id of ids) {
    const r = tools.swift(root, ['package', 'unedit', id]);
    if (!r.ok && !/not in edit mode/i.test(r.stderr + r.stdout)) throw new Error(`swift package unedit ${id} failed:\n${r.stderr || r.stdout}`);
  }
}

/**
 * Moves each dependency the library supplies to `version` or the checkout's newest release tag, a `path:`
 * dependency becoming one on the checkout's origin; ends any edit, resolves, builds, and commits
 * `Package.swift` and a tracked `Package.resolved`. A failure puts both back and the edit with them.
 */
async function bump(
  root: string,
  _name: string,
  lib: LibConfig,
  checkout: string,
  entry: Link | undefined,
  { version, exact = false }: { version?: string; exact?: boolean },
  tools: Tools,
): Promise<BumpResult> {
  const files = [MANIFEST, RESOLVED];
  requireClean(root, files);
  const putFilesBack = snapshot(root, files);
  const deps = depsIn(root, lib);
  const ids = [...new Set(deps.map((d) => d.identity))];
  const pins = swift.pins(root, lib);
  let ended = false;
  let resolved = false;
  try {
    const targets = await targetsFor(pins, version, () => Promise.resolve(newestTag(checkout, '', undefined, true)));
    const changed: BumpResult['changed'] = [];
    let text = readFileSync(join(root, MANIFEST), 'utf8');
    // From the end, so each splice leaves the spans before it where they were.
    for (const dep of [...deps].reverse()) {
      const pin = pins.find((p) => p.name === dep.identity)!;
      const to = targets.get(dep.identity)!;
      if (exact ? pin.exact === to : dep.kind === 'url' && settled(pin.range, to, pin.locked)) continue;
      const [start, end] = dep.kind === 'path' ? dep.args : dep.req;
      const next =
        dep.kind === 'path' ? `url: "${urlOf(checkout)}", ${moved(dep, to, exact)}` : moved(dep, to, exact);
      text = text.slice(0, start) + next + text.slice(end);
      changed.unshift({ name: dep.identity, from: pin.spec, to });
    }
    writeFileSync(join(root, MANIFEST), text);

    if (entry) {
      unedit(root, ids, tools);
      ended = true;
    }
    if (changed.length || entry) {
      resolved = true;
      const steps: Array<[string, string[]]> = [
        ['swift package update', ['package', 'update', ...changed.map((c) => c.name)]],
        ['swift build', ['build']],
      ];
      for (const [label, args] of steps) {
        const r = tools.swift(root, args);
        if (!r.ok) throw new Error(`${label} failed after the bump; package files put back:\n${r.stderr || r.stdout}`);
      }
    }
    return changed.length ? { changed, commit: commitFiles(root, files, bumpMessage(lib, changed)) } : { changed };
  } catch (e) {
    putFilesBack();
    const trouble: string[] = [];
    if (resolved && !tools.swift(root, ['package', 'resolve']).ok) trouble.push('swift package resolve failed while putting the package files back');
    if (ended) {
      try {
        edit(root, ids, checkout, tools);
      } catch (err) {
        trouble.push(`the edit could not be restored: ${(err as Error).message}`);
      }
    }
    if (trouble.length && e instanceof Error) e.message += `\n${trouble.join('\n')}`;
    throw e;
  }
}

export const swift: Platform = {
  marker: MANIFEST,
  supplied: (checkout) => [identityOfCheckout(checkout)],
  defaultPackages: (checkout) => [identityOfCheckout(checkout)],
  pins(root, lib) {
    const locked = lockedVersions(root);
    return depsIn(root, lib).map((d): Pin => {
      const v = locked.get(d.identity);
      const spec = d.kind === 'path' ? `path: "${d.location}"` : d.requirement;
      return { manifest: MANIFEST, name: d.identity, spec, ...rangeOf(d.requirement), ...(v ? { locked: v } : {}) };
    });
  },
  latest: (_name, { checkout, fresh }) => Promise.resolve(newestTag(checkout, '', undefined, fresh)),
  tags: (_checkout, _name, version) => [`v${version}`, version],
  // `swift package edit --path` leaves a symlink to the checkout here.
  ignores: () => ['Packages/'],
  link(root, _name, lib, checkout, _entry, tools) {
    const deps = depsIn(root, lib);
    const path = deps.find((d) => d.kind === 'path');
    if (path) throw new Error(`${path.identity} is a path dependency already; \`alpo bump\` moves it onto a release first`);
    edit(root, [...new Set(deps.map((d) => d.identity))], checkout, tools);
  },
  unlink(root, _name, lib, _checkout, _entry, tools) {
    unedit(root, [...new Set(depsIn(root, lib).map((d) => d.identity))], tools);
  },
  bump,
};
