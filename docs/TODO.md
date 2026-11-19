# TODO

- **Sign up the other consumers.** Each has its own copy of the linking code today:
  iconfab, astv, fiddy and collego (`weasel.vite.ts`, all four drifted from segmento's), klieg
  (`dev/shared/weasel.ts`), blinken (`../blits`, `BLITS=npm`), brick-icons (`PEZLIE=`), and `file:` siblings in
  flatly (weasel), brainhouse (icehouse) and lbx-editor (obwat, bil-lbx). Delete each repo's own code as it joins.
- **`join` prints the vite wiring instead of making it.** Editing an arbitrary `vite.config.ts` reliably needs a
  parser; until then the wiring line is printed for each config that lacks the plugin.
- **Does a range that already admits `latest` count as current?** `ls` says `^2.3.0` is current at 2.4.1 (semver),
  but `bump` still rewrites it to the exact `2.4.1`. Either `ls` names that state, or `bump` leaves an admitting
  range alone. Open (2026-11-18).
- **Untested:** `sweep`, `check`, and the vite plugin's restart and `dist` watchers.
