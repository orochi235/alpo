import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Status } from '../src/ops.ts';
import { depTable, libState, pinState } from '../src/report.ts';

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
