# TODO

- **Sign up the other consumers.** Each has its own copy of the linking code today: iconfab and fiddy
  (`weasel.vite.ts`), blinken for blits (`../blits`, `BLITS=npm`; its weasel link is on alpo), brick-icons
  (`PEZLIE=`), and `file:` siblings in flatly (weasel), brainhouse (icehouse) and lbx-editor (obwat, bil-lbx).
  Delete each repo's own code as it joins. astv, collego, klieg and blinken joined for weasel 2026-11-21.
- **No documented way for a config to ask what is linked.** blinken's forge loads its vite plugin from npm even
  when weasel is linked, so the plugin and the workshop it serves can come from different weasels; the old
  `WEASEL=` switch loaded both from the checkout. `activeLinks` would answer it but is not in the README.
- **`join` prints the vite wiring instead of making it.** Editing an arbitrary `vite.config.ts` reliably needs a
  parser; until then the wiring line is printed for each config that lacks the plugin.
- **`bump` across a major leaves npm refusing the install.** Moving weasel 1.x → 2.0.0 (2026-11-21), blinken, dd,
  klieg and collego all hit ERESOLVE or nested per-workspace copies until the lockfile's `node_modules/@weasel-js/*`
  entries were dropped before `npm install`. collego's `scripts/weasel.mjs` does exactly that and then asserts one
  hoisted copy; `bump` should do the same, and collego's script can go once it does.
- **`join` on an already-joined repo rewrites `.alpo.json` in its own formatting**, undoing the repo's formatter
  (seen in blinken and astv, 2026-11-21: biome's one-line `packages` array comes back split). Leave the file alone
  when its content is unchanged.
