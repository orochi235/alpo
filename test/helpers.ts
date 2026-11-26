import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Tools } from '../src/ops.ts';
import { git } from '../src/sh.ts';

export function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'alpo-'));
  process.env.ALPO_HOME = join(dir, '.alpo');
  return dir;
}

export function put(root: string, files: Record<string, unknown>) {
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), typeof body === 'string' ? body : `${JSON.stringify(body, null, 2)}\n`);
  }
}

export function repo(root: string, files: Record<string, unknown>) {
  put(root, files);
  git(root, 'init', '--quiet', '-b', 'main');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'test');
  commitAll(root, 'init');
}

export function commitAll(root: string, message: string): string {
  git(root, 'add', '-A');
  git(root, 'commit', '--quiet', '-m', message);
  return git(root, 'rev-parse', 'HEAD').stdout;
}

/** A library checkout: an npm workspace root supplying `@lib/a` and `@lib/b`. */
export function library(dir: string) {
  repo(dir, {
    'package.json': { name: 'lib-root', private: true, workspaces: ['packages/*'] },
    'packages/a/package.json': { name: '@lib/a', version: '1.0.0', exports: { '.': './dist/index.js' } },
    'packages/a/dist/index.js': 'export const a = 1;\n',
    'packages/b/package.json': { name: '@lib/b', version: '1.0.0' },
  });
}

/**
 * Records package-manager calls instead of running them: npm's as their arguments, swift's and go's led by
 * the command. A call whose words, joined by spaces, are or begin with an entry of `fail` fails.
 */
export function stubTools(fail: string[] = []): Tools & { calls: string[][] } {
  const calls: string[][] = [];
  const record = (call: string[]) => {
    calls.push(call);
    const line = call.join(' ');
    const ok = !fail.some((f) => line === f || line.startsWith(`${f} `));
    return { ok, stdout: '', stderr: ok ? '' : 'stub failure' };
  };
  return {
    calls,
    npm: (_root, args) => record(args),
    swift: (_root, args) => record(['swift', ...args]),
    go: (_root, args) => record(['go', ...args]),
  };
}
