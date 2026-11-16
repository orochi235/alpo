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

/** Records npm calls instead of running them. */
export function stubTools(fail: string[] = []): Tools & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    npm: (_root, args) => {
      calls.push(args);
      const ok = !fail.includes(args.join(' '));
      return { ok, stdout: '', stderr: ok ? '' : 'stub failure' };
    },
  };
}
