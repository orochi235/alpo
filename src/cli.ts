#!/usr/bin/env node
import { basename } from 'node:path';
import { parseArgs } from 'node:util';
import { findRoot, readConfig, tildify, type Via } from './config.ts';
import { registered } from './home.ts';
import { joinLib, leaveLib, unwiredViteConfigs } from './join.ts';
import { bump, link, Skip, type Status, status, unlink } from './ops.ts';

const USAGE = `alpo — serve a library from its checkout until a release carries what you need

  alpo join <lib> [--repo <path>] [--packages <glob>]... [--via vite|file]
  alpo leave <lib>
  alpo link <lib> [--for <reason>] [--needs <rev>]...
  alpo unlink <lib>
  alpo bump <lib> [<version>] [--all]
  alpo sweep [<lib>]      bump every signed-up repo whose link a release now covers
  alpo ls                 every signed-up repo: pins, links, and what the latest release covers
  alpo check              one line per covered link in this repo (for a SessionStart hook)`;

const { values: flags, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    repo: { type: 'string' },
    packages: { type: 'string', multiple: true },
    via: { type: 'string' },
    for: { type: 'string' },
    needs: { type: 'string', multiple: true },
    all: { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  },
});
const [command, lib, extra] = positionals;

function here(): string {
  const root = findRoot(process.cwd());
  if (!root) throw new Error('this repository has not joined anything: run `alpo join <lib>`');
  return root;
}

const pad = (rows: string[][]) => {
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
  return rows.map((r) => r.map((c, i) => c.padEnd(widths[i])).join('  ').trimEnd()).join('\n');
};

function pinText(s: Status): string {
  const specs = [...new Set(s.pins.map((p) => p.spec))];
  return specs.join(', ') || '-';
}

function stateText(s: Status): string {
  const latestV = s.pins.find((p) => p.latest)?.latest;
  if (s.link) return s.covered ? `covered by ${latestV}` : `waiting (latest ${latestV ?? '?'})`;
  const behind = s.pins.some((p) => p.latest && p.spec !== p.latest);
  return behind ? `behind ${latestV}` : 'current';
}

async function sweep(only?: string) {
  for (const root of registered()) {
    for (const s of await status(root, { fetch: true, fresh: true })) {
      if ((only && s.lib !== only) || !s.link || !s.covered) continue;
      const version = s.pins.find((p) => p.latest)?.latest;
      const label = `${basename(root)} ${s.lib}`;
      try {
        const r = await bump(root, s.lib, version);
        console.log(`${label}: bumped to ${version}${r.commit ? ` in ${r.commit}` : ''}, unlinked`);
      } catch (e) {
        console.log(`${label}: ${e instanceof Skip ? 'skipped' : 'failed'}: ${(e as Error).message}`);
      }
    }
  }
}

async function main() {
  if (flags.help || !command) return console.log(USAGE);
  const need = () => {
    if (!lib) throw new Error(`usage: alpo ${command} <lib>`);
    return lib;
  };
  switch (command) {
    case 'join': {
      const root = findRoot(process.cwd()) ?? process.cwd();
      const via = flags.via as Via | undefined;
      if (via && via !== 'vite' && via !== 'file') throw new Error('--via is vite or file');
      const entry = joinLib(root, need(), { repo: flags.repo, packages: flags.packages, via });
      console.log(`${basename(root)} joined ${lib}: ${entry.packages.join(', ')} from ${entry.repo}, via ${entry.via}`);
      if (entry.via === 'vite')
        for (const f of unwiredViteConfigs(root))
          console.log(`  wire ${tildify(f)}: import { alpo } from '@msb235/alpo/vite'; plugins: [alpo(), …]`);
      return;
    }
    case 'leave':
      leaveLib(here(), need());
      return console.log(`left ${lib}`);
    case 'link': {
      const entry = link(here(), need(), { for: flags.for, needs: flags.needs });
      return console.log(`linked ${lib}, waiting on ${entry.needs.map((s) => s.slice(0, 9)).join(', ')}`);
    }
    case 'unlink':
      return console.log(unlink(here(), need()) ? `unlinked ${lib}` : `${lib} was not linked`);
    case 'bump': {
      const roots = flags.all
        ? registered().filter((r) => need() in readConfig(r).libs)
        : [here()];
      for (const root of roots) {
        try {
          const r = await bump(root, need(), extra);
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
      return sweep(lib);
    case 'ls': {
      const all = (await Promise.all(registered().map((r) => status(r, { fetch: true })))).flat();
      const rows = all.map((s) => [
        basename(s.root),
        s.lib,
        s.config.via,
        pinText(s),
        s.link ? `linked${s.link.for ? `: ${s.link.for}` : ''}` : '-',
        stateText(s),
      ]);
      return console.log(rows.length ? pad([['repo', 'lib', 'via', 'pin', 'link', 'state'], ...rows]) : 'nothing has joined yet');
    }
    case 'check': {
      const root = findRoot(process.cwd());
      if (!root) return;
      for (const s of await status(root, { fetch: true }))
        if (s.link && s.covered)
          console.log(
            `alpo: ${basename(root)} is linked to ${s.lib}${s.link.for ? ` for "${s.link.for}"` : ''}, and ${s.pins.find((p) => p.latest)?.latest} carries what it needs: run \`alpo bump ${s.lib}\``,
          );
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
