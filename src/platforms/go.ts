import { existsSync, globSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { major } from 'semver';
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

const WORK = 'go.work';
/** Every go command `bump` runs sees the release, never a link's checkout. */
const RELEASED = { GOWORK: 'off' };

const moduleOf = (text: string) => /^module\s+(\S+)/m.exec(text)?.[1];

/** Each module a checkout holds, by path, with its directory relative to the checkout. */
export function modulesIn(checkout: string): Map<string, string> {
  const found = new Map<string, string>();
  const files = globSync('**/go.mod', {
    cwd: checkout,
    exclude: (p) => ['vendor', 'testdata', 'node_modules', '.git'].some((d) => String(p).split('/').includes(d)),
  }).sort();
  for (const f of files) {
    const mod = moduleOf(readFileSync(join(checkout, f), 'utf8'));
    if (mod) found.set(mod, dirname(f));
  }
  return found;
}

/** The `require` entries of a `go.mod`, single-line and in blocks alike. */
export function requires(text: string): Array<{ module: string; version: string }> {
  const out: Array<{ module: string; version: string }> = [];
  const add = (line: string) => {
    const m = /^\s*(\S+)\s+(v\S+)/.exec(line.replace(/\/\/.*$/, ''));
    if (m) out.push({ module: m[1], version: m[2] });
  };
  for (const block of text.matchAll(/^require\s*\(([^)]*)\)/gm)) for (const line of block[1].split('\n')) add(line);
  for (const single of text.matchAll(/^require\s+([^(\s].*)$/gm)) add(single[1]);
  return out;
}

/** A module's major version as its path states it: `/v2` is 2; no suffix admits 0 and 1. */
const majorOf = (module: string) => Number(/\/v(\d+)$/.exec(module)?.[1] ?? 1);

/** The tag prefix a module's releases carry: its directory within the repository, `sub/` for a nested one. */
function prefixOf(checkout: string, module: string): string {
  const dir = modulesIn(checkout).get(module);
  return dir && dir !== '.' ? `${dir}/` : '';
}

function newest(checkout: string, module: string, fresh?: boolean) {
  const want = majorOf(module);
  return newestTag(checkout, prefixOf(checkout, module), (v) => (want <= 1 ? major(v) <= 1 : major(v) === want), fresh);
}

/** The checkout's directories holding the modules the library supplies. */
function dirsFor(checkout: string, lib: LibConfig): string[] {
  return [...modulesIn(checkout)].filter(([mod]) => matches(lib.packages, mod)).map(([, dir]) => join(checkout, dir));
}

function goOrThrow(tools: Tools, root: string, args: string[], env?: Record<string, string>) {
  const r = tools.go(root, args, env);
  if (!r.ok) throw new Error(`go ${args.join(' ')} failed:\n${r.stderr || r.stdout}`);
}

function unlinkWork(root: string, checkout: string, lib: LibConfig, entry: Link, tools: Tools) {
  if (entry.created?.includes(WORK)) {
    for (const f of [WORK, `${WORK}.sum`]) rmSync(join(root, f), { force: true });
    return;
  }
  goOrThrow(tools, root, ['work', 'edit', ...dirsFor(checkout, lib).map((d) => `-dropuse=${d}`)]);
}

/**
 * Moves each module the library supplies to `version` or its newest release tag with `go get`, builds,
 * and commits `go.mod` and `go.sum`, all with the workspace off so the release is what gets built.
 */
async function bump(
  root: string,
  _name: string,
  lib: LibConfig,
  checkout: string,
  entry: Link | undefined,
  { version, exact }: { version?: string; exact?: boolean },
  tools: Tools,
): Promise<BumpResult> {
  const files = ['go.mod', 'go.sum'];
  requireClean(root, files);
  const putBack = snapshot(root, files);
  try {
    const pins = go.pins(root, lib);
    const targets = await targetsFor(pins, version, (mod) => Promise.resolve(newest(checkout, mod, true)));
    const changed: BumpResult['changed'] = [];
    for (const pin of pins) {
      const to = targets.get(pin.name)!;
      if (exact ? pin.exact === to : settled(pin.range, to, pin.locked)) continue;
      goOrThrow(tools, root, ['get', `${pin.name}@v${to}`], RELEASED);
      changed.push({ name: pin.name, from: pin.spec, to });
    }
    if (changed.length || entry) {
      // Into a directory of its own: a lone main package's binary would otherwise land in the repository.
      const out = mkdtempSync(join(tmpdir(), 'alpo-go-'));
      const r = tools.go(root, ['build', '-o', `${out}/`, './...'], RELEASED);
      rmSync(out, { recursive: true, force: true });
      if (!r.ok) throw new Error(`go build failed after the bump; package files put back:\n${r.stderr || r.stdout}`);
    }
    const commit = changed.length ? commitFiles(root, files, bumpMessage(lib, changed)) : undefined;
    if (entry) unlinkWork(root, checkout, lib, entry, tools);
    return commit ? { changed, commit } : { changed };
  } catch (e) {
    putBack();
    throw e;
  }
}

export const go: Platform = {
  marker: 'go.mod',
  supplied: (checkout) => [...modulesIn(checkout).keys()],
  defaultPackages: (checkout) => [...modulesIn(checkout).keys()],
  pins(root, lib) {
    if (!existsSync(join(root, 'go.mod'))) return [];
    return requires(readFileSync(join(root, 'go.mod'), 'utf8'))
      .filter((r) => matches(lib.packages, r.module))
      .map((r): Pin => {
        const v = r.version.slice(1);
        // A requirement is a minimum, and the version it names is the one the build selects.
        return { manifest: 'go.mod', name: r.module, spec: r.version, range: `>=${v}`, exact: v, locked: v };
      });
  },
  latest: (name, { checkout, fresh }) => Promise.resolve(newest(checkout, name, fresh)),
  tags: (checkout, name, version) => [`${prefixOf(checkout, name)}v${version}`],
  // A workspace file alpo writes is this checkout's alone; one the repository tracks is left visible.
  ignores: (root) => (git(root, 'ls-files', '--error-unmatch', WORK).ok ? [] : [WORK, `${WORK}.sum`]),
  link(root, _name, lib, checkout, entry, tools, prior) {
    const dirs = dirsFor(checkout, lib);
    if (!dirs.length) throw new Error(`${checkout} holds no module matching ${lib.packages.join(', ')}`);
    if (existsSync(join(root, WORK))) {
      if (prior?.created) entry.created = prior.created;
      goOrThrow(tools, root, ['work', 'use', ...dirs]);
    } else {
      goOrThrow(tools, root, ['work', 'init', '.', ...dirs]);
      entry.created = [WORK];
    }
  },
  unlink(root, _name, lib, checkout, entry, tools) {
    unlinkWork(root, checkout, lib, entry, tools);
  },
  bump,
};
