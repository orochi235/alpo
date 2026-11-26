import { existsSync, globSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXTENDS } from './typepaths.ts';

/** The config a repository's projects share: `tsconfig.base.json` where there is one, else `tsconfig.json`. */
export function sharedTsconfig(root: string): string | undefined {
  return ['tsconfig.base.json', 'tsconfig.json'].map((f) => join(root, f)).find((f) => existsSync(f));
}

/**
 * Puts alpo's generated config first in the shared tsconfig's `extends`, so the repository's own settings
 * still win. Edits the text, comments and all; false when the config already extends it.
 */
export function wireTsconfig(file: string): boolean {
  const text = readFileSync(file, 'utf8');
  if (text.includes(EXTENDS)) return false;
  const quoted = JSON.stringify(EXTENDS);
  let next: string;
  if (/"extends"\s*:\s*"/.test(text)) next = text.replace(/("extends"\s*:\s*)("[^"]*")/, `$1[${quoted}, $2]`);
  else if (/"extends"\s*:\s*\[/.test(text)) next = text.replace(/("extends"\s*:\s*\[)/, `$1${quoted}, `);
  else {
    const indent = /\n([ \t]+)"/.exec(text)?.[1] ?? '  ';
    next = text.replace('{', `{\n${indent}"extends": ${quoted},`);
  }
  writeFileSync(file, next);
  return true;
}

/** Tsconfigs under the root that set `paths` of their own, which replace the generated ones wholesale. */
export function ownPaths(root: string): string[] {
  return globSync('**/tsconfig*.json', { cwd: root, exclude: (p) => String(p).split('/').includes('node_modules') })
    .filter((f) => /"paths"\s*:/.test(readFileSync(join(root, f), 'utf8')))
    .sort();
}
