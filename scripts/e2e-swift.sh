#!/bin/sh
# alpo's SwiftPM platform through the real swift toolchain: a scratch app taking perch's PerchKit by path,
# bumped onto perch's newest release, then linked and unlinked. Needs the network; leaves nothing behind.
set -eu
A=$(pwd); W=$(mktemp -d); trap 'rm -rf "$W"' EXIT
export ALPO_HOME=$W/.alpo
alpo() { node "$A/src/cli.ts" "$@"; }
git clone -q https://github.com/orochi235/perch "$W/perch"
mkdir -p "$W/app/Sources/App"; cd "$W/app"
cat > Package.swift <<'P'
// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "App",
    platforms: [.macOS(.v14)],
    dependencies: [
        .package(path: "../perch"),
    ],
    targets: [
        .executableTarget(name: "App", dependencies: [.product(name: "PerchKit", package: "perch")]),
    ]
)
P
printf 'import PerchKit\n' > Sources/App/main.swift
printf '.build/\n' > .gitignore
git init -q -b main; git config user.email t@example.com; git config user.name t; git add -A; git commit -qm init
echo '== join'; alpo join perch --repo "$W/perch"; git add -A; git commit -qm join
echo '== ls'; alpo ls
echo '== bump'; alpo bump perch; git log -1 --stat --format=%s; grep -n 'perch"' Package.swift; git status --short
echo '== link'; alpo link perch --for e2e; ls -la Packages; swift build 2>&1 | tail -1; alpo ls
echo '== unlink'; alpo unlink perch; ls Packages 2>&1 || true; alpo ls
echo '== relink, then bump with nothing to move'; alpo link perch; alpo bump perch; alpo ls
