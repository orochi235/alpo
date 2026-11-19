import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Status } from '../src/ops.ts';
import { pinState, settled } from '../src/pins.ts';
import { depTable, libState } from '../src/report.ts';

const status = (pins: Status['pins'], link?: Status['link']): Status => ({
  root: '/src/app',
  lib: 'lib',
  config: { packages: ['@lib/*'], repo: '~/src/lib', via: 'vite' },
  pins,
  ...(link ? { link } : {}),
});

test('a range that admits latest is current, not behind', () => {
  assert.equal(pinState('^2.3.0', '2.3.0'), 'current');
  assert.equal(pinState('^2.3.0', '2.4.1'), 'current');
  assert.equal(pinState('2.3.0', '2.4.1'), 'behind');
  assert.equal(pinState('~2.3.0', '2.4.0'), 'behind');
  assert.equal(pinState('^2.3.0', undefined), '?');
  assert.equal(pinState('file:../lib/packages/a', '2.3.0'), '-');
});

test('a library is behind only when some pin refuses latest', () => {
  const pin = (spec: string) => ({ manifest: 'package.json', name: '@lib/a', spec, latest: '1.4.0' });
  assert.equal(libState(status([pin('^1.4.0')])), 'current');
  assert.equal(libState(status([pin('^1.4.0'), pin('1.3.0')])), 'behind 1.4.0');
  assert.equal(libState(status([{ ...pin('^1.0.0'), latest: undefined }])), 'latest unknown');
  assert.equal(libState(status([])), '-');
});

test('a library behind on two packages names each one\'s own latest', () => {
  const s = status([
    { manifest: 'package.json', name: '@lib/a', spec: '^1.4.0', latest: '1.4.0' },
    { manifest: 'package.json', name: '@lib/b', spec: '2.0.0', latest: '2.1.0' },
  ]);
  assert.equal(libState(s), 'behind 2.1.0');
  s.pins[0].spec = '1.3.0';
  assert.equal(libState(s), 'behind: @lib/a 1.4.0, @lib/b 2.1.0');
});

test('a joined library with no dependency on it still gets a row', () => {
  assert.equal(depTable([status([])]).split('\n')[1], 'app   lib      -     -       -  -');
});

test('the dependency table gives each package in each manifest its own row', () => {
  const out = depTable([
    status([
      { manifest: 'package.json', name: '@lib/a', spec: '^1.18.1', latest: '1.19.1' },
      { manifest: 'apps/web/package.json', name: '@lib/a', spec: '1.18.1', latest: '1.19.1' },
    ]),
  ]);
  assert.deepEqual(out.split('\n'), [
    'repo  package  in                         pin  latest  state',
    'app   @lib/a   package.json           ^1.18.1  1.19.1  current',
    'app   @lib/a   apps/web/package.json   1.18.1  1.19.1  behind',
  ]);
});

test('a range admitting the target is settled only once the lockfile installs it', () => {
  assert.ok(settled('^1.18.1', '1.19.1', '1.19.1'));
  assert.ok(settled('^1.18.1', '1.19.1'));
  assert.ok(!settled('^1.18.1', '1.19.1', '1.18.1'));
  assert.equal(pinState('^1.18.1', '1.19.1', '1.18.1'), 'behind');
  assert.ok(!settled('~1.18.1', '1.19.1'));
});
