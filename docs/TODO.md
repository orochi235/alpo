# TODO

- **Sign up the other consumers.** Each has its own copy of the linking code today:
  iconfab, astv, fiddy and collego (`weasel.vite.ts`, all four drifted from segmento's), klieg
  (`dev/shared/weasel.ts`), blinken (`../blits`, `BLITS=npm`), brick-icons (`PEZLIE=`), and `file:` siblings in
  flatly (weasel), brainhouse (icehouse) and lbx-editor (obwat, bil-lbx). Delete each repo's own code as it joins.
- **`join` prints the vite wiring instead of making it.** Editing an arbitrary `vite.config.ts` reliably needs a
  parser; until then the wiring line is printed for each config that lacks the plugin.
- **Coverage checks one package's release, and `sweep` acts on it.** `status` takes the first pin with a `latest`
  and tests only that package's tag, so `@lib/a@1.5.0` holding the needed commit marks the link covered while
  `@lib/b`'s latest lacks it; `sweep` then pins b there and unlinks. Every package's latest tag should contain
  `needs`. (Review, 2026-11-18; reproduced.)
- **`bump` on a `file` link with nothing to move drops the link without reinstalling.** `restore` puts the specs
  back, but install runs only `if (changed.length)`, so the lockfile and `node_modules` still point at the
  checkout with no link recording it. (Reproduced 2026-11-18.)
- **Linking again loses a dependency added since the first link.** `saved` is written only when there is no prior
  link, yet every supplied dep is rewritten to `file:`; unlinking leaves the new dep as `file:…`. Save per
  dependency whenever none is recorded and the spec isn't already `file:`. (Reproduced 2026-11-18.)
- **A relative `--repo` resolves against the process's cwd, not the repo root** (`expandHome` → `resolve`), so
  `ls`, `sweep`, the vite plugin, and `link` from a subdirectory find the wrong checkout. Resolve against the root,
  or store it absolute at `join`. (2026-11-18.)
- **Workspace patterns other than a trailing `/*` are ignored** (`packages/**`, `apps/*/*`, `tools/*-cli`,
  `!negations`), in consumers and in library checkouts alike. (Reproduced 2026-11-18.)
- **`leave` with an uncommitted `.alpo.json` prints "left" and changes nothing but the registry**: the `git rm`
  result is ignored. (Reproduced 2026-11-18.)
- **`bump` on a `file` link refuses when the alpo root is a subdirectory of its git repo**: `git show HEAD:<f>`
  resolves from the top level; use `HEAD:./<f>`. (2026-11-18.)
- **Failures that vanish:** `sweep` exits 0 when bumps fail; `putBack` ignores its own `npm install`; `fetchTags`
  ignores a failed or timed-out fetch and records it as done for an hour. (2026-11-18.)
- **Hazards:** under `via: vite` a checkout's `dist` imports shared deps (`react`) from the checkout's own
  `node_modules`, which can load two copies (wants `resolve.dedupe`). A link taken at a feature-branch HEAD that is
  then squash-merged never becomes covered. `latest()` runs `npm view` from the process's cwd, so a scoped registry
  set in a consumer's `.npmrc` is missed. (2026-11-18.)
- **Untested:** `status`, `sweep`, `check`, and the CLI have no tests; nor do the cases above or the vite plugin's
  restart and `dist` watchers. Every test passes an absolute `--repo` and a `*/`-style workspace.
