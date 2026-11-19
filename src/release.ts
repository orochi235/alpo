import { readCache, writeCache } from './home.ts';
import { git, run, runAsync } from './sh.ts';

const HOUR = 3_600_000;

/** The version npm's `latest` tag names, cached for an hour unless `fresh`. */
export async function latest(name: string, fresh = false, cwd = process.cwd()): Promise<string | undefined> {
  const hit = readCache().latest[name];
  if (!fresh && hit && Date.now() - hit.at < HOUR) return hit.version;
  // From the consumer, so a scoped registry its `.npmrc` names is the one asked.
  const r = await runAsync('npm', ['view', name, 'version'], cwd);
  if (!r.ok || !r.stdout) return hit?.version;
  const cache = readCache();
  cache.latest[name] = { version: r.stdout, at: Date.now() };
  writeCache(cache);
  return r.stdout;
}

/** Pulls the checkout's tags, which a release made in CI only leaves on the remote; at most hourly unless `fresh`. */
export function fetchTags(checkout: string, fresh = false): { ok: true } | { ok: false; error: string } {
  const cache = readCache();
  if (!fresh && Date.now() - (cache.fetched[checkout] ?? 0) < HOUR) return { ok: true };
  const r = run('git', ['fetch', '--tags', '--quiet'], checkout, 10_000);
  if (!r.ok) return { ok: false, error: r.stderr || 'timed out' };
  cache.fetched[checkout] = Date.now();
  writeCache(cache);
  return { ok: true };
}

/** The tag a release of `name` at `version` left in the checkout, in any of the usual spellings. */
export function tagFor(checkout: string, name: string, version: string): string | undefined {
  return [`${name}@${version}`, `v${version}`, version].find(
    (tag) => git(checkout, 'rev-parse', '--quiet', '--verify', `refs/tags/${tag}`).ok,
  );
}

/** Whether every commit in `needs` is in `tag`. */
export const contains = (checkout: string, tag: string, needs: string[]): boolean =>
  needs.every((sha) => git(checkout, 'merge-base', '--is-ancestor', sha, `refs/tags/${tag}`).ok);

/**
 * The needed commits the remote's default branch does not hold: not pushed yet, or squashed or rebased
 * away, in which case no release will ever contain them.
 */
export function offTrunk(checkout: string, needs: string[]): string[] {
  const trunk = git(checkout, 'rev-parse', '--quiet', '--verify', 'refs/remotes/origin/HEAD');
  if (!trunk.ok) return [];
  return needs.filter((sha) => !git(checkout, 'merge-base', '--is-ancestor', sha, trunk.stdout).ok);
}
