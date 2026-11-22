import { basename } from 'node:path';
import { registered } from './home.ts';
import { bump, realTools, Skip, status } from './ops.ts';
import { latestOf } from './report.ts';

/** Bumps and unlinks every signed-up repo whose link a release now covers; false if any bump failed. */
export async function sweep(only?: string, tools = realTools, log = console.log): Promise<boolean> {
  let ok = true;
  for (const root of registered()) {
    for (const s of await status(root, { fetch: true, fresh: true })) {
      if ((only && s.lib !== only) || !s.link || !s.covered) continue;
      const label = `${basename(root)} ${s.lib}`;
      try {
        // No version: each package moves to its own latest, which need not match its siblings'.
        const r = await bump(root, s.lib, {}, tools);
        const what = r.changed.map((c) => `${c.name} ${c.to}`).join(', ') || 'nothing to move';
        log(`${label}: bumped ${what}${r.commit ? ` in ${r.commit}` : ''}, unlinked`);
      } catch (e) {
        log(`${label}: ${e instanceof Skip ? 'skipped' : 'failed'}: ${(e as Error).message}`);
        if (!(e instanceof Skip)) ok = false;
      }
    }
  }
  return ok;
}

/** One line per link in this repo that a release now covers. */
export async function check(root: string): Promise<string[]> {
  return (await status(root, { fetch: true }))
    .filter((s) => s.link && s.covered)
    .map(
      (s) =>
        `alpo: ${basename(root)} is linked to ${s.lib}${s.link!.for ? ` for "${s.link!.for}"` : ''}, and ${latestOf(s)} carries what it needs: run \`alpo bump ${s.lib}\``,
    );
}
