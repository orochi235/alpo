import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';

export interface Result {
  ok: boolean;
  stdout: string;
  stderr: string;
}

export function run(cmd: string, args: string[], cwd: string, timeout?: number, env?: Record<string, string>): Result {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout, env: env ? { ...process.env, ...env } : undefined });
  return { ok: r.status === 0, stdout: r.stdout?.trim() ?? '', stderr: (r.stderr ?? r.error?.message ?? '').trim() };
}

const execFileP = promisify(execFile);

export async function runAsync(cmd: string, args: string[], cwd: string, timeout = 15_000): Promise<Result> {
  try {
    const { stdout, stderr } = await execFileP(cmd, args, { cwd, timeout });
    return { ok: true, stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message: string };
    return { ok: false, stdout: err.stdout?.trim() ?? '', stderr: (err.stderr || err.message).trim() };
  }
}

export const git = (cwd: string, ...args: string[]) => run('git', args, cwd);
