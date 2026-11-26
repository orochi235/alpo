#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { parseArgs } from 'node:util';
import { findRoot, readConfig, tildify, VIAS, type Via } from './config.ts';
import { registered } from './home.ts';
import { joinLib, leaveLib, unwiredViteConfigs } from './join.ts';
import { bump, link, platformOf, Skip, status, unlink } from './ops.ts';
import { depTable, libTable } from './report.ts';
import { check, sweep } from './sweep.ts';
import { EXTENDS } from './typepaths.ts';
import { WIRING, wireVite } from './wire.ts';
import { ownPaths, sharedTsconfig, wireTsconfig } from './wiretypes.ts';

const USAGE = `alpo — serve a library from its checkout until a release carries what you need

  alpo join <lib> [--repo <path>] [--packages <glob>]... [--via vite|file|edit|work] [--serve source]
                          npm takes vite or file, SwiftPM edit, Go work; join picks from the repository
                          --serve source: a vite link serves the checkout's src, not its dist
  alpo leave <lib>
  alpo link <lib> [--for <reason>] [--needs <rev>]... [--from <checkout>]
                          --from serves another checkout (a worktree, say) until unlinked
  alpo unlink <lib>
  alpo bump <lib> [<version>] [--all] [--exact]
                          a range that admits the target, locked to it, is left alone; --exact pins it anyway
  alpo sweep [<lib>]      bump every signed-up repo whose link a release now covers
  alpo ls [--deps]        every signed-up repo: pins, links, and what the latest release covers;
                          --deps gives each package its own row, by manifest
  alpo check              one line per covered link in this repo (for a SessionStart hook)
  alpo --version`;

function parse() {
  try {
    return parseArgs({
      allowPositionals: true,
      options: {
        repo: { type: 'string' },
        packages: { type: 'string', multiple: true },
        via: { type: 'string' },
        serve: { type: 'string' },
        for: { type: 'string' },
        needs: { type: 'string', multiple: true },
        from: { type: 'string' },
        all: { type: 'boolean' },
        deps: { type: 'boolean' },
        exact: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
      },
    });
  } catch (e) {
    console.error(`alpo: ${(e as Error).message}\n\n${USAGE}`);
    process.exit(1);
  }
}

const { values: flags, positionals } = parse();
const [command, lib, extra] = positionals;

function here(): string {
  const root = findRoot(process.cwd());
  if (!root) throw new Error('this repository has not joined anything: run `alpo join <lib>`');
  return root;
}

async function main() {
  if (flags.version) {
    // From `src/` and from `dist/` alike, the manifest is one directory up.
    const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    return console.log(version);
  }
  if (flags.help || !command) return console.log(USAGE);
  const need = () => {
    if (!lib) throw new Error(`usage: alpo ${command} <lib>`);
    return lib;
  };
  switch (command) {
    case 'join': {
      const root = findRoot(process.cwd()) ?? process.cwd();
      const via = flags.via as Via | undefined;
      if (via && !VIAS.includes(via)) throw new Error(`--via is one of ${VIAS.join(', ')}`);
      if (flags.serve && flags.serve !== 'source') throw new Error('--serve takes source; dist is the default');
      const serve = flags.serve as 'source' | undefined;
      const entry = joinLib(root, need(), { repo: flags.repo, packages: flags.packages, via, serve });
      console.log(`${basename(root)} joined ${lib}: ${entry.packages.join(', ')} from ${entry.repo}, via ${entry.via}${entry.serve ? ', serving source' : ''}`);
      for (const p of platformOf(entry.via).pins(root, entry).filter((p) => !p.range))
        console.log(`  ${p.name} is ${p.spec} in ${p.manifest}: \`alpo bump ${lib}\` moves it onto a release`);
      if (entry.via !== 'vite') return;
      let wired = false;
      for (const { file, m } of unwiredViteConfigs(root)) {
        if (wireVite(file, m)) {
          wired = true;
          console.log(`  wired ${tildify(file)}`);
        } else console.log(`  wire ${tildify(file)} by hand: ${WIRING}`);
      }
      const ts = sharedTsconfig(root);
      if (ts && wireTsconfig(ts)) console.log(`  ${tildify(ts)} extends ${EXTENDS}, so tsc sees links too`);
      for (const f of ownPaths(root)) console.log(`  ${f} sets its own paths, which hide linked packages from tsc`);
      if (wired) console.log('  run `npm install` to fetch @msb235/alpo');
      return;
    }
    case 'leave':
      leaveLib(here(), need());
      return console.log(`left ${lib}`);
    case 'link': {
      const entry = link(here(), need(), { for: flags.for, needs: flags.needs, from: flags.from });
      const where = entry.from ? ` from ${entry.from}` : '';
      return console.log(`linked ${lib}${where}, waiting on ${entry.needs.map((s) => s.slice(0, 9)).join(', ')}`);
    }
    case 'unlink':
      return console.log(unlink(here(), need()) ? `unlinked ${lib}` : `${lib} was not linked`);
    case 'bump': {
      const roots = flags.all
        ? registered().filter((r) => need() in readConfig(r).libs)
        : [here()];
      for (const root of roots) {
        try {
          const r = await bump(root, need(), { version: extra, exact: flags.exact });
          const what = r.changed.map((c) => `${c.name} ${c.from} → ${c.to}`).join(', ') || 'already current';
          console.log(`${basename(root)}: ${what}${r.commit ? ` (${r.commit})` : ''}`);
        } catch (e) {
          if (!(e instanceof Skip) || !flags.all) throw e;
          console.log(`${basename(root)}: skipped: ${e.message}`);
        }
      }
      return;
    }
    case 'sweep':
      if (!(await sweep(lib))) process.exitCode = 1;
      return;
    case 'ls': {
      const all = (await Promise.all(registered().map((r) => status(r, { fetch: true })))).flat();
      if (!all.length) return console.log('nothing has joined yet');
      return console.log(flags.deps ? depTable(all) : libTable(all));
    }
    case 'check': {
      const root = findRoot(process.cwd());
      if (root) for (const line of await check(root)) console.log(line);
      return;
    }
    default:
      throw new Error(`unknown command ${command}\n\n${USAGE}`);
  }
}

main().catch((e: Error) => {
  console.error(`alpo: ${e.message}`);
  process.exit(1);
});
