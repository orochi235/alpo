# TODO

- **Sign up the other consumers.** Each has its own copy of the linking code today:
  iconfab, astv, fiddy and collego (`weasel.vite.ts`, all four drifted from segmento's), klieg
  (`dev/shared/weasel.ts`), blinken (`../blits`, `BLITS=npm`), brick-icons (`PEZLIE=`), and `file:` siblings in
  flatly (weasel), brainhouse (icehouse) and lbx-editor (obwat, bil-lbx). Delete each repo's own code as it joins.
- **`join` prints the vite wiring instead of making it.** Editing an arbitrary `vite.config.ts` reliably needs a
  parser; until then the wiring line is printed for each config that lacks the plugin.
- **`ls` calls a range "behind" when it already admits `latest`.** `stateText` compares the spec string to the
  version, so `^2.3.0` against `latest` 2.3.0 reads `behind 2.3.0` (x-helm, x-xstitch on 2026-11-18). Either test
  the range with semver or name the state for what it is (not exact-pinned).
- **No per-package view.** `ls` collapses a library's packages into one row of distinct specs, and `status` keeps
  only the first manifest's spec for each package, so a repo pinning `@weasel-js/core` and `@weasel-js/react`
  differently shows `^1.18.1, 1.18.1` with no way to tell which is which.
