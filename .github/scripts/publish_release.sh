#!/bin/bash
set -euo pipefail

# Release Please creates a draft first. This also resumes an existing draft
# after a failed upload, even when Release Please has no new outputs on retry.
VERSION=$(python3 -c 'import json; print(json.load(open("package.json", encoding="utf-8"))["version"])')
TAG="v$VERSION"
ASSET_DIR=${ASSET_DIR:?ASSET_DIR must point at the downloaded binaries}
WORK_DIR=$(mktemp -d)
trap 'rm -rf "$WORK_DIR"' EXIT
gh release view "$TAG" --repo "$GITHUB_REPOSITORY" --json isDraft,isPrerelease,tagName > "$WORK_DIR/release.json"
if [ "$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(d["isDraft"] and not d["isPrerelease"])' "$WORK_DIR/release.json")" != True ]; then
    echo "$TAG is already published; nothing to upload."
    exit 0
fi

# Every platform is named, so a missing build fails instead of shipping a partial release.
names=(seats-linux-x64 seats-linux-arm64 seats-darwin-x64 seats-darwin-arm64)
patterns=(--pattern SHA256SUMS)
for name in "${names[@]}"; do
    if [ ! -f "$ASSET_DIR/$name" ]; then
        echo "Missing release asset: $name" >&2
        exit 1
    fi
    patterns+=(--pattern "$name")
done
# Bare filenames, so install.sh can find the line for its own binary.
(cd "$ASSET_DIR" && sha256sum "${names[@]}" > SHA256SUMS)
(cd "$ASSET_DIR" && gh release upload "$TAG" "${names[@]}" SHA256SUMS \
    --repo "$GITHUB_REPOSITORY" --clobber)

# Test the actual uploaded bytes before making them visible through latest.
mkdir "$WORK_DIR/downloaded"
gh release download "$TAG" --repo "$GITHUB_REPOSITORY" "${patterns[@]}" \
    --dir "$WORK_DIR/downloaded"
(cd "$WORK_DIR/downloaded" && sha256sum --check SHA256SUMS)
gh release edit "$TAG" --repo "$GITHUB_REPOSITORY" --draft=false --latest
