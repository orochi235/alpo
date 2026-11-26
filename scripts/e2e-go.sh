#!/bin/sh
# alpo's Go platform through the real go toolchain: a scratch app requiring an old release of
# github.com/orochi235/perch/v2, linked, unlinked, and bumped. Needs the network; leaves nothing behind.
set -eu
A=$(pwd); W=$(mktemp -d); trap 'chmod -R u+w "$W"; rm -rf "$W"' EXIT
export ALPO_HOME=$W/.alpo GOPATH=$W/gopath GOFLAGS=-modcacherw
alpo() { node "$A/src/cli.ts" "$@"; }
git clone -q https://github.com/orochi235/perch "$W/perch"
mkdir "$W/app"; cd "$W/app"
printf 'module example.com/app\n\ngo 1.26\n\nrequire github.com/orochi235/perch/v2 v2.5.0\n' > go.mod
printf 'package main\n\nfunc main() {}\n' > main.go
git init -q -b main; git config user.email t@example.com; git config user.name t
GOFLAGS=-mod=mod go list -m all >/dev/null; git add -A; git commit -qm init
echo '== join'; alpo join perch --repo "$W/perch"; cat .gitignore; git add -A; git commit -qm join
echo '== ls'; alpo ls
echo '== link'; alpo link perch --for e2e; cat go.work; alpo ls
echo '== unlink'; alpo unlink perch; ls go.work 2>&1 || true
echo '== link, then bump'; alpo link perch; alpo bump perch
git log -1 --stat --format=%s; cat go.mod; ls go.work 2>&1 || true; git status --short; alpo ls
