import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { satisfies, validRange } from 'semver';

type Lock = { packages?: Record<string, { version?: string }> };

export const readLock = (root: string): Lock | undefined => {
  const path = join(root, 'package-lock.json');
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as Lock) : undefined;
};

/** The version a lockfile installs for `name` as `manifest` (a path from the root) sees it. */
export function lockedOf(lock: Lock | undefined, manifest: string, name: string): string | undefined {
  const dir = dirname(manifest);
  const keys = [...(dir === '.' ? [] : [`${dir}/node_modules/${name}`]), `node_modules/${name}`];
  for (const k of keys) {
    const v = lock?.packages?.[k]?.version;
    if (v) return v;
  }
  return undefined;
}

/**
 * Whether a pin already gets `target` without a rewrite: it names it exactly, or its range admits it and
 * the lockfile, when there is one, installs it. A range admitting `target` over a stale lock still moves.
 */
export function settled(spec: string | undefined, target: string, locked?: string): boolean {
  if (!spec) return false;
  if (spec === target) return true;
  return !!validRange(spec) && satisfies(target, spec) && (locked === undefined || locked === target);
}

/** What `ls` says of one pin: `current` exactly when a plain `bump` would leave it alone. */
export function pinState(spec: string | undefined, latest: string | undefined, locked?: string): 'current' | 'behind' | '?' | '-' {
  // `validRange('')` is `*`, so an absent range has to be ruled out before asking.
  if (!spec || !validRange(spec)) return '-';
  if (!latest) return '?';
  return settled(spec, latest, locked) ? 'current' : 'behind';
}
