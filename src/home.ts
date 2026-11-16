import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CONFIG } from './config.ts';

/** Alpo's own state: the registry of signed-up repositories and a cache of npm lookups. */
export const home = () => process.env.ALPO_HOME ?? join(homedir(), '.alpo');

const file = (name: string) => join(home(), name);

function read<T>(name: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(file(name), 'utf8')) as T;
  } catch {
    return fallback;
  }
}

function write(name: string, value: unknown) {
  mkdirSync(home(), { recursive: true });
  writeFileSync(file(name), `${JSON.stringify(value, null, 2)}\n`);
}

/** Every repository that has joined a library, dropping any whose `.alpo.json` is gone. */
export function registered(): string[] {
  const { repos } = read<{ repos: string[] }>('registry.json', { repos: [] });
  const live = repos.filter((r) => existsSync(join(r, CONFIG)));
  if (live.length !== repos.length) write('registry.json', { repos: live });
  return live;
}

export function register(root: string) {
  const repos = registered();
  if (!repos.includes(root)) write('registry.json', { repos: [...repos, root].sort() });
}

export function unregister(root: string) {
  write('registry.json', { repos: registered().filter((r) => r !== root) });
}

/** One entry per package name and per checkout, so the cache stays as small as the set of libraries. */
interface Cache {
  latest: Record<string, { version: string; at: number }>;
  fetched: Record<string, number>;
}

export const readCache = (): Cache => ({ latest: {}, fetched: {}, ...read<Partial<Cache>>('cache.json', {}) });
export const writeCache = (cache: Cache) => write('cache.json', cache);
