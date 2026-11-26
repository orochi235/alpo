# alpo

When a project needs an unreleased change in one of your libraries, alpo serves that library from its local
checkout, records which commits the project is waiting on, and moves the project's pins once a release contains
them. It replaces the per-repo `WEASEL=` / `BLITS=` / `file:` arrangements, which each repo did its own way and
none of which knew when to stop.

## Install

```sh
brew install orochi235/tap/alpo     # the CLI
npm install -D @msb235/alpo          # in a repo that serves a linked library through vite
```

## In a consumer

```sh
alpo join weasel                        # once: writes .alpo.json, registers the repo
alpo link weasel --for "F2 Glass lens"  # serve ~/src/weasel; waits on its current HEAD
alpo unlink weasel                      # back to npm
alpo bump weasel [1.20.0] [--exact]     # move pins, npm install, typecheck, commit the package files
```

`join` picks `@scope/*` when every package the checkout publishes shares a scope, `~/src/<lib>` as the checkout,
and `vite` when the repo depends on vite (`file` otherwise); `--packages`, `--repo` and `--via` override each.
`bump` leaves a range alone when it already admits the target and the lockfile installs it, which is exactly when
`ls` calls it current; anything else, and everything under `--exact`, is pinned exactly. `link --needs <rev>`
(repeatable) names the commits being waited on when `HEAD` is not the right answer. A relative `--repo` is taken
from the repository root.

| File | Tracked | Holds |
|---|---|---|
| `.alpo.json` | yes | which libraries the repo takes: package globs, checkout, `via` |
| `.alpo.local.json` | no (`join` ignores it) | what this checkout is linked to now, why, and the commits it needs |
| `~/.alpo/registry.json` | — | every repo that has joined something |
| `~/.alpo/cache.json` | — | npm `latest` per package and each checkout's last tag fetch, an hour each; one entry per package |

### `via: vite`

Nothing in the manifests changes when you link. `join` loads the plugin in each `vite.config.*` and adds
`@msb235/alpo` to the devDependencies beside it; a config built in a function gets the wiring line printed
instead, to add by hand. With the plugin loaded, a linked library's imports resolve from its checkout's
root, so the checkout's own workspace links answer them and each package's `exports` apply. Its packages are kept
out of prebundling, their peer dependencies are deduped to the app's copy, the checkout joins `server.fs.allow`, the page reloads when a `dist` is rewritten, and the
server restarts itself when you link or unlink.

```ts
import { alpo } from '@msb235/alpo/vite';
export default defineConfig({ plugins: [alpo()] });
```

It serves the checkout's **built** `dist`, so a library change needs a library build first, and the page reloads
once the build settles. `join --serve source` (`"serve": "source"` in `.alpo.json`) serves `src` instead: each
import resolves through the package's `exports` as usual, then `dist/<path>.js` becomes `src/<path>.ts` (or
`.tsx`, `.js`, …) where that file exists, so edits arrive by hot module replacement with no build. It suits a
library whose build only compiles TypeScript; types still come from `dist`. For one run,
`ALPO_WEASEL=npm` turns a link off and `ALPO_WEASEL=<path>` serves another checkout (a worktree, say).

tsc sees a vite link too. `join` puts `@msb235/alpo/tsconfig.json` first in the `extends` of
`tsconfig.base.json` (or `tsconfig.json`), and `link`, `unlink`, `bump` and each dev-server start fill that
file with `paths`: every export of each linked package to its declarations in the checkout, and each of their
peer dependencies to the app's own copy, which tsc would otherwise take from the checkout's `node_modules` as a
second, incompatible type. A tsconfig that sets `paths` of its own replaces these, and `join` says which do.
`link --from <path>` serves another checkout (a worktree, say) until unlinked, for tsc and vite alike; an
`ALPO_<LIB>` override lasts one run, which tsc cannot see.

An esbuild build beside the dev server (a script bundling a player or a worker, say) takes the same links
with `import { alpo } from '@msb235/alpo/esbuild'` in its `plugins`. Outside any bundler, `activeLinks(root)`
from `@msb235/alpo` says which libraries are linked, from which checkout, and whether as source.

### `via: file`

For consumers outside vite. `link` rewrites each dependency the library supplies to `file:<checkout package>`
and runs `npm install`; `unlink` and `bump` put the saved specs back. While linked, the manifests are modified
in the working tree and must not be committed.

### SwiftPM (`via: edit`) and Go (`via: work`)

`join` works out what kind of package the repository and the checkout are, and takes the library the way
that package manager links natively; neither changes a manifest.

| | SwiftPM | Go |
|---|---|---|
| packages | the checkout's identity: `perch` | its module paths: `github.com/orochi235/perch/v2` |
| `link` | `swift package edit <id> --path <checkout>` | a `go.work` using `.` and the checkout, or `go work use` on the one already there |
| `unlink` | `swift package unedit <id>` | deletes the `go.work` alpo made, or `go work edit -dropuse` |
| latest | the checkout's newest stable `v1.2.3` or `1.2.3` tag | its newest stable `v1.2.3` tag of the major the module path names (`sub/v1.2.3` for a nested module) |
| `bump` | rewrites the requirement in `Package.swift`, `swift package update`, `swift build` | `go get <module>@<version>`, `go build`, with `GOWORK=off` |
| commits | `Package.swift`, and `Package.resolved` when it is tracked | `go.mod`, `go.sum` |
| ignores | `Packages/`, where `edit` leaves its symlink | `go.work` and `go.work.sum`, unless the repository tracks a `go.work` |

A Swift `path:` dependency on the library shows as `unpinned`; `link` refuses it, and `bump` turns it into a
`url:` dependency on the checkout's origin (GitHub's over https) at the release. A requirement keeps its shape
when it moves: `from:` stays `from:`, `exact:` stays `exact:`, `.upToNextMinor` stays itself.
Xcode resolves packages on its own and does not see `swift package edit`.

## After a release

```sh
alpo ls          # every registered repo: pin, link, and whether the latest release covers it
alpo ls --deps   # the same, one row per package in each manifest
alpo sweep       # bump and unlink every repo whose link the latest release now covers
alpo check       # this repo only, one line per covered link: for a SessionStart hook
```

A link is covered when npm's `latest` for its packages has a tag in the checkout (`<name>@<version>`,
`v<version>` or `<version>`; tags are fetched, since a release made in CI only leaves them on the remote) that
contains every commit the link needs, for every package the repo pins. `ls` warns when a needed commit is not on
the remote's default branch: unpushed, or squashed away, in which case `link --needs` should name its replacement. `bump` refuses a repo whose package files have uncommitted changes, and a
failed install or typecheck puts the package files back and keeps the link. Its commit holds only the manifests
and the lockfile, so other work in the tree is left alone.

## Developing

`npm test` runs the suite on Node's own test runner; `npm run build` writes `dist`, which the CLI
(`node dist/cli.js` from a checkout) and the vite plugin both run from. The suite stubs `npm`, `swift` and
`go`; `scripts/e2e-swift.sh` and `scripts/e2e-go.sh`, run from the repository root, drive the real toolchains
against perch from GitHub in a temporary directory.
