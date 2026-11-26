import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { readConfig, readLocal } from '../src/config.ts';
import { joinLib } from '../src/join.ts';
import { bump, link, status, unlink } from '../src/ops.ts';
import { dependencies, rangeOf } from '../src/platforms/swift.ts';
import { git } from '../src/sh.ts';
import { commitAll, repo, scratch, stubTools } from './helpers.ts';

const manifest = (deps: string) => `// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "App",
    dependencies: [
${deps}
    ],
    targets: [
        .executableTarget(name: "App", dependencies: [.product(name: "Lib", package: "lib")]),
    ]
)
`;

const resolved = (version: string) => ({
  pins: [{ identity: 'lib', kind: 'remoteSourceControl', location: 'https://example.com/me/lib.git', state: { revision: 'abc', version } }],
  version: 2,
});

/** A SwiftPM library tagged `v1.0.0` and an app depending on it as `deps` says. */
function setup(deps: string, lock?: string) {
  const dir = scratch();
  const lib = join(dir, 'lib');
  const app = join(dir, 'app');
  repo(lib, { 'Package.swift': '// swift-tools-version:5.9\nimport PackageDescription\nlet package = Package(name: "lib")\n' });
  git(lib, 'tag', 'v1.0.0');
  git(lib, 'remote', 'add', 'origin', join(dir, 'nowhere/lib.git'));
  repo(app, { 'Package.swift': manifest(deps), ...(lock ? { 'Package.resolved': resolved(lock) } : {}) });
  joinLib(app, 'lib', { repo: lib });
  commitAll(app, 'join');
  return { dir, lib, app, file: join(app, 'Package.swift') };
}

test('requirements read as semver ranges, and dependencies are found with their spans', () => {
  assert.deepEqual(rangeOf('from: "1.2.0"'), { range: '>=1.2.0 <2.0.0' });
  assert.deepEqual(rangeOf('.upToNextMajor(from: "0.3.0")'), { range: '>=0.3.0 <1.0.0' });
  assert.deepEqual(rangeOf('.upToNextMinor(from: "1.2.0")'), { range: '>=1.2.0 <1.3.0' });
  assert.deepEqual(rangeOf('exact: "1.2.0"'), { range: '1.2.0', exact: '1.2.0' });
  assert.deepEqual(rangeOf('"1.0.0"..<"3.0.0"'), { range: '>=1.0.0 <3.0.0' });
  assert.deepEqual(rangeOf('branch: "main"'), {});
  const text = manifest(
    '        .package(url: "git@github.com:me/Lib.git", .upToNextMinor(from: "1.2.0")),\n        .package(path: "../other"),',
  );
  const [lib, other] = dependencies(text);
  assert.equal(lib.identity, 'lib');
  assert.equal(lib.requirement, '.upToNextMinor(from: "1.2.0")');
  assert.equal(text.slice(...lib.req), lib.requirement);
  assert.deepEqual([other.kind, other.identity, other.requirement], ['path', 'other', '']);
});

test('join takes a SwiftPM library by edit and ignores the Packages directory edit links from', () => {
  const { app, lib } = setup('        .package(url: "https://example.com/me/lib.git", from: "1.0.0"),');
  assert.deepEqual(readConfig(app).libs.lib, { packages: ['lib'], repo: lib, via: 'edit' });
  assert.match(readFileSync(join(app, '.gitignore'), 'utf8'), /^Packages\/$/m);
});

test('link edits the package onto the checkout, and unlink ends the edit', () => {
  const { app, lib } = setup('        .package(url: "https://example.com/me/lib.git", from: "1.0.0"),');
  const tools = stubTools();
  link(app, 'lib', {}, tools);
  assert.ok(readLocal(app).links.lib);
  unlink(app, 'lib', tools);
  assert.deepEqual(tools.calls, [
    ['swift', 'package', 'edit', 'lib', '--path', lib],
    ['swift', 'package', 'unedit', 'lib'],
  ]);
});

test('link refuses a path dependency, which bump moves onto the origin at the newest release', async () => {
  const { app, lib, file, dir } = setup('        .package(path: "../lib"),');
  assert.throws(() => link(app, 'lib', {}, stubTools()), /path dependency already/);
  git(lib, 'commit', '--quiet', '--allow-empty', '-m', 'next');
  git(lib, 'tag', 'v1.1.0');
  // Untracked, as a library's usually is; a bump neither commits it nor counts it as work in progress.
  writeFileSync(join(app, 'Package.resolved'), `${JSON.stringify(resolved('1.0.0'))}\n`);
  const tools = stubTools();
  const r = await bump(app, 'lib', {}, tools);
  assert.deepEqual(r.changed, [{ name: 'lib', from: 'path: "../lib"', to: '1.1.0' }]);
  assert.match(readFileSync(file, 'utf8'), new RegExp(`\\.package\\(url: "${join(dir, 'nowhere/lib.git')}", from: "1\\.1\\.0"\\)`));
  assert.deepEqual(tools.calls, [['swift', 'package', 'update', 'lib'], ['swift', 'build']]);
  assert.equal(git(app, 'log', '-1', '--format=%s').stdout, 'bump lib to 1.1.0');
});

test('bump ends the edit, keeps the requirement shape, and leaves a settled one alone', async () => {
  const { app, lib, file } = setup('        .package(url: "https://example.com/me/lib.git", from: "1.0.0"),', '1.0.0');
  git(lib, 'commit', '--quiet', '--allow-empty', '-m', 'needed');
  link(app, 'lib', {}, stubTools());
  git(lib, 'tag', 'v1.1.0');
  const [s] = await status(app);
  assert.equal(s.covered, true);
  const tools = stubTools();
  await bump(app, 'lib', {}, tools);
  assert.match(readFileSync(file, 'utf8'), /from: "1\.1\.0"/);
  assert.deepEqual(tools.calls[0], ['swift', 'package', 'unedit', 'lib']);
  assert.ok(!readLocal(app).links.lib);

  writeFileSync(join(app, 'Package.resolved'), `${JSON.stringify(resolved('1.1.0'))}\n`);
  commitAll(app, 'resolve');
  assert.deepEqual((await bump(app, 'lib', { version: '1.1.0' }, stubTools())).changed, []);
});

test('a failed build puts Package.swift back and restores the edit', async () => {
  const { app, lib, file } = setup('        .package(url: "https://example.com/me/lib.git", exact: "1.0.0"),');
  link(app, 'lib', {}, stubTools());
  git(lib, 'tag', 'v1.1.0');
  const before = readFileSync(file, 'utf8');
  const tools = stubTools(['swift build']);
  await assert.rejects(bump(app, 'lib', {}, tools), /swift build failed/);
  assert.equal(readFileSync(file, 'utf8'), before);
  assert.deepEqual(tools.calls.at(-1), ['swift', 'package', 'edit', 'lib', '--path', lib]);
  assert.ok(readLocal(app).links.lib);
});
