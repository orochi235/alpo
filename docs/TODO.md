# TODO

- **Move brent and colm onto alpo.** Both take perch as `.package(path: "../perch")`, and colm takes brent the
  same way; `alpo join perch` then `alpo bump perch` moves perch onto 2.6.0, which carries PerchKit (checked
  on a scratch app, 2026-11-25). brent has no release tags yet, so colm's link to it has nothing to bump to.
- **Go: `replace` directives and nested modules.** `pins` reads only the root `go.mod`'s `require`s, so a
  consumer already pointing at a checkout through `replace` shows as pinned to the version it replaces, and a
  repository with several modules shows only the root's. `link` puts only `.` in a new `go.work`.

- **Move blinken's blits link and brick-icons' `PEZLIE` onto alpo, once a release carries source mode.** Both
  serve a sibling checkout's source, which `join --serve source` and `@msb235/alpo/esbuild` now cover, but
  consumers install alpo from npm, where 0.1.0 has neither. blinken: `alpo join blits --serve source --packages`
  naming blits' five packages (`@msb235/*` would also match alpo), then delete `blits.config.ts` and its uses in
  both vite configs, `vitest.config.ts`, `site/astro.config.ts`, `scripts/bundle.mjs`, and
  `test/program.test.ts`, plus the `../blits` paths in `tsconfig.json`; `prepack`'s `BLITS=npm` becomes
  `ALPO_BLITS=npm`. brick-icons also had uncommitted edits to `lab/vite.config.ts` (2026-11-21).
  iconfab, fiddy, astv, collego, klieg, and blinken's weasel link are on alpo. flatly and lbx-editor take
  everything from npm and have no linking code to replace. brainhouse's `file:../../icehouse` is not alpo's
  case: icehouse is unpublished, so no release will ever carry it.
