# TODO

- **Sign up blinken's blits link and brick-icons.** Both serve a sibling checkout's *source*, not its `dist`:
  blinken's `blits.config.ts` aliases `@msb235/blits` to `../blits/src` whenever that exists (`BLITS=npm` turns it
  off), and brick-icons' `lab/vite.config.ts` aliases `pezlie` to `$PEZLIE/wall/src` and has `WEASEL_SRC`. alpo
  serves built `dist` only, so moving them over means either a build step in those workflows or a source mode
  in alpo; undecided (2026-11-21). brick-icons also had uncommitted edits to that config.
  iconfab, fiddy, astv, collego, klieg, and blinken's weasel link are on alpo. flatly and lbx-editor take
  everything from npm and have no linking code to replace. brainhouse's `file:../../icehouse` is not alpo's
  case: icehouse is unpublished, so no release will ever carry it.
