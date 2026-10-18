#!/bin/bash
set -euo pipefail

# Builds one release binary on its own platform and smoke-tests it there.
# Usage: build_binary.sh <linux-x64|linux-arm64|darwin-x64|darwin-arm64>
TARGET=${1:?Usage: build_binary.sh <linux-x64|linux-arm64|darwin-x64|darwin-arm64>}
case "$(uname -s)-$(uname -m)" in
    Linux-x86_64) NATIVE=linux-x64 ;;
    Linux-aarch64) NATIVE=linux-arm64 ;;
    Darwin-x86_64) NATIVE=darwin-x64 ;;
    Darwin-arm64) NATIVE=darwin-arm64 ;;
    *) NATIVE="unsupported $(uname -s)-$(uname -m)" ;;
esac
# A cross-compiled binary could not be smoke-tested, so only build natively.
if [ "$TARGET" != "$NATIVE" ]; then
    echo "Build seats-$TARGET on a $TARGET runner; this one is $NATIVE" >&2
    exit 1
fi

BINARY="dist/release/seats-$TARGET"
bun build src/cli.ts --compile --target="bun-$TARGET" --outfile "$BINARY"

case "$TARGET" in darwin-*)
    # macOS kills binaries without a valid signature, so ad-hoc sign if needed.
    if ! codesign --verify "$BINARY" 2>/dev/null; then
        codesign --force --sign - "$BINARY"
    fi
    codesign --verify --verbose "$BINARY"
esac

# Run with a throwaway HOME and no inherited env, so SEATS_HOME, CODEX_HOME and
# the like can't point the smoke tests at a real store.
SMOKE_HOME=$(mktemp -d)
trap 'rm -rf "$SMOKE_HOME"' EXIT
run() {
    env -i HOME="$SMOKE_HOME" PATH="$PATH" "./$BINARY" "$@"
}

expected=$(bun -p 'require("./package.json").version')
actual=$(run --version)
if [ "$actual" != "$expected" ]; then
    echo "seats-$TARGET --version printed '$actual', expected '$expected'" >&2
    exit 1
fi
run sync --dry-run
run help > /dev/null
echo "seats-$TARGET $actual passed the smoke tests"
