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
alpo join weasel                    # once: writes .alpo.json, registers the repo
alpo link weasel --for "F2 Glass lens"   # serve ~/src/weasel; waits on its current HEAD
alpo unlink weasel                  # back to npm
alpo bump weasel [1.20.0]           # exact pins, npm install, typecheck, commit the package files
```

`join` picks `@scope/*` when every package the checkout publishes shares a scope, `~/src/<lib>` as the checkout,
and `vite` when the repo depends on vite (`file` otherwise); `--packages`, `--repo` and `--via` override each.
`link --needs <rev>` (repeatable) names the commits being waited on when `HEAD` is not the right answer.

| File | Tracked | Holds |
|---|---|---|
| `.alpo.json` | yes | which libraries the repo takes: package globs, checkout, `via` |
| `.alpo.local.json` | no (`join` ignores it) | what this checkout is linked to now, why, and the commits it needs |
| `~/.alpo/registry.json` | — | every repo that has joined something |
| `~/.alpo/cache.json` | — | npm `latest` per package and each checkout's last tag fetch, an hour each; one entry per package |

### `via: vite`

Nothing in the manifests changes. Load the plugin, and a linked library's imports resolve from its checkout's
root, so the checkout's own workspace links answer them and each package's `exports` apply. Its packages are kept
out of prebundling, the checkout joins `server.fs.allow`, the page reloads when a `dist` is rewritten, and the
server restarts itself when you link or unlink.

```ts
import { alpo } from '@msb235/alpo/vite';
export default defineConfig({ plugins: [alpo()] });
```

It serves the checkout's **built** `dist`, so a library change needs a library build first. For one run,
`ALPO_WEASEL=npm` turns a link off and `ALPO_WEASEL=<path>` serves another checkout (a worktree, say).

### `via: file`

For consumers outside vite. `link` rewrites each dependency the library supplies to `file:<checkout package>`
and runs `npm install`; `unlink` and `bump` put the saved specs back. While linked, the manifests are modified
in the working tree and must not be committed.

## After a release

```sh
alpo ls       # every registered repo: pin, link, and whether the latest release covers it
alpo sweep    # bump and unlink every repo whose link the latest release now covers
alpo check    # this repo only, one line per covered link: for a SessionStart hook
```

A link is covered when npm's `latest` for its packages has a tag in the checkout (`<name>@<version>`,
`v<version>` or `<version>`; tags are fetched, since a release made in CI only leaves them on the remote) that
contains every commit the link needs. `bump` refuses a repo whose package files have uncommitted changes, and a
failed install or typecheck puts the package files back and keeps the link. Its commit holds only the manifests
and the lockfile, so other work in the tree is left alone.

## Developing

`npm test` runs the suite on Node's own test runner; `npm run build` writes `dist`, which the CLI
(`node dist/cli.js` from a checkout) and the vite plugin both run from.
