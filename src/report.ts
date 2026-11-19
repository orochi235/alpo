import { basename } from 'node:path';
import { satisfies, validRange } from 'semver';
import type { Status } from './ops.ts';

/** npm's `latest` for the library, read from the first of its packages npm answered for. */
export const latestOf = (s: Status): string | undefined => s.pins.find((p) => p.latest)?.latest;

/** Whether a spec admits `latest`; a spec that is not a version range (`file:`, a git URL) has no answer. */
export function pinState(spec: string, latest: string | undefined): 'current' | 'behind' | '?' | '-' {
  if (!validRange(spec)) return '-';
  if (!latest) return '?';
  return satisfies(latest, spec) ? 'current' : 'behind';
}

export function libState(s: Status): string {
  const latest = latestOf(s);
  if (s.link) {
    if (s.covered) return `covered by ${latest}`;
    const notes = [`latest ${latest ?? '?'}`];
    if (s.offTrunk?.length) notes.push(`${s.offTrunk.map((c) => c.slice(0, 9)).join(', ')} not on origin's trunk: unpushed, or squashed away`);
    if (s.fetchError) notes.push('tag fetch failed');
    return `waiting (${notes.join('; ')})`;
  }
  const behind = s.pins.filter((p) => pinState(p.spec, p.latest) === 'behind');
  if (behind.length) {
    const targets = new Set(behind.map((p) => p.latest));
    return targets.size === 1
      ? `behind ${[...targets][0]}`
      : `behind: ${[...new Set(behind.map((p) => `${p.name} ${p.latest}`))].join(', ')}`;
  }
  if (s.pins.some((p) => pinState(p.spec, p.latest) === '?')) return 'latest unknown';
  return s.pins.length ? 'current' : '-';
}

/** Columns padded to their widest cell; the columns named in `right` align right. */
export function table(rows: string[][], right: number[] = []): string {
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
  return rows
    .map((r) => r.map((c, i) => (right.includes(i) ? c.padStart(widths[i]) : c.padEnd(widths[i]))).join('  ').trimEnd())
    .join('\n');
}

/** One row per repository and library. */
export function libTable(all: Status[]): string {
  const rows = all.map((s) => [
    basename(s.root),
    s.lib,
    s.config.via,
    [...new Set(s.pins.map((p) => p.spec))].join(', ') || '-',
    s.link ? `linked${s.link.for ? `: ${s.link.for}` : ''}` : '-',
    libState(s),
  ]);
  return table([['repo', 'lib', 'via', 'pin', 'link', 'state'], ...rows], [3]);
}

/** One row per dependency on a library, by manifest, so each package's own pin shows. */
export function depTable(all: Status[]): string {
  const rows = all.flatMap((s) =>
    s.pins.length
      ? s.pins.map((p) => [
          basename(s.root),
          p.name,
          p.manifest,
          p.spec,
          p.latest ?? '?',
          s.link ? (s.covered ? 'linked, covered' : 'linked, waiting') : pinState(p.spec, p.latest),
        ])
      : [[basename(s.root), s.lib, '-', '-', '-', '-']],
  );
  return table([['repo', 'package', 'in', 'pin', 'latest', 'state'], ...rows], [3, 4]);
}
