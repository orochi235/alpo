# TODO

- **Sign up the other consumers.** Each has its own copy of the linking code today: iconfab and fiddy
  (`weasel.vite.ts`), blinken for blits (`../blits`, `BLITS=npm`; its weasel link is on alpo), brick-icons
  (`PEZLIE=`), and `file:` siblings in flatly (weasel), brainhouse (icehouse) and lbx-editor (obwat, bil-lbx).
  Delete each repo's own code as it joins. astv, collego, klieg and blinken joined for weasel 2026-11-21.
- **No documented way for a config to ask what is linked.** blinken's forge loads its vite plugin from npm even
  when weasel is linked, so the plugin and the workshop it serves can come from different weasels; the old
  `WEASEL=` switch loaded both from the checkout. `activeLinks` would answer it but is not in the README.
