# TODO

- **Publish `@msb235/alpo` to npm.** Until then consumers take it as `file:../alpo`, so a checkout without
  `~/src/alpo` beside it cannot install; segmento is the only one so far. After publishing, move segmento's
  dev dependency to the exact version.
- **Sign up the other consumers** once it is published. Each has its own copy of the linking code today:
  iconfab, astv, fiddy and collego (`weasel.vite.ts`, all four drifted from segmento's), klieg
  (`dev/shared/weasel.ts`), blinken (`../blits`, `BLITS=npm`), brick-icons (`PEZLIE=`), and `file:` siblings in
  flatly (weasel), brainhouse (icehouse) and lbx-editor (obwat, bil-lbx). Delete each repo's own code as it joins.
- **`join` prints the vite wiring instead of making it.** Editing an arbitrary `vite.config.ts` reliably needs a
  parser; until then the wiring line is printed for each config that lacks the plugin.
