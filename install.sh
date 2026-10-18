#!/bin/bash
# Installs or updates seats from its latest GitHub release:
#   curl -fsSL https://raw.githubusercontent.com/gelzinn/seats/main/install.sh | bash
# SEATS_VERSION=0.1.0 installs that release instead, SEATS_INSTALL_DIR changes
# where the binary goes (default ~/.local/bin), and SEATS_DOWNLOAD_URL replaces
# the download URL, e.g. file:///path/to/binaries for local testing.
set -euo pipefail

fail() {
    echo "seats: $*" >&2
    exit 1
}

command -v curl > /dev/null || fail "curl is needed to download seats"

case "$(uname -s)" in
    Linux) os=linux ;;
    Darwin) os=darwin ;;
    *) fail "$(uname -s) is not supported; seats switches seats with symlinks and runs on Linux and macOS" ;;
esac
arch=$(uname -m)
# A shell running under Rosetta reports x86_64 on Apple Silicon; install the native build.
if [ "$os" = darwin ] && [ "$(sysctl -n sysctl.proc_translated 2> /dev/null)" = 1 ]; then
    arch=arm64
fi
case "$arch" in
    x86_64 | amd64) arch=x64 ;;
    aarch64 | arm64) arch=arm64 ;;
    *) fail "$arch is not supported; seats has binaries for x64 and arm64" ;;
esac
asset="seats-$os-$arch"

releases=https://github.com/gelzinn/seats/releases
if [ -n "${SEATS_DOWNLOAD_URL:-}" ]; then
    base=${SEATS_DOWNLOAD_URL%/}
elif [ -n "${SEATS_VERSION:-}" ]; then
    base="$releases/download/v${SEATS_VERSION#v}"
else
    base="$releases/latest/download"
fi
install_dir=${SEATS_INSTALL_DIR:-$HOME/.local/bin}
staged="$install_dir/.seats-install-$$"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"; rm -f "$staged"' EXIT

echo "Downloading $asset from $base"
curl -fsSL "$base/$asset" -o "$tmp/$asset" || fail "could not download $base/$asset"
curl -fsSL "$base/SHA256SUMS" -o "$tmp/SHA256SUMS" || fail "could not download $base/SHA256SUMS"

expected=$(awk -v name="$asset" '$2 == name || $2 == "*" name { print $1; exit }' "$tmp/SHA256SUMS")
[ -n "$expected" ] || fail "SHA256SUMS has no entry for $asset"
if command -v sha256sum > /dev/null; then
    actual=$(sha256sum "$tmp/$asset" | awk '{ print $1 }')
elif command -v shasum > /dev/null; then
    actual=$(shasum -a 256 "$tmp/$asset" | awk '{ print $1 }')
else
    fail "sha256sum or shasum is needed to verify the download"
fi
[ "$actual" = "$expected" ] || fail "checksum mismatch for $asset; nothing was installed"

mkdir -p "$install_dir"
# Copy next to the old binary and rename over it: overwriting a running seats
# in place fails with "Text file busy".
cp "$tmp/$asset" "$staged"
chmod +x "$staged"
version=$("$staged" --version) || fail "the downloaded binary doesn't run on this machine; nothing was installed"
mv -f "$staged" "$install_dir/seats"
echo "Installed seats $version to $install_dir/seats"

case ":$PATH:" in
    *":$install_dir:"*) ;;
    *)
        echo
        echo "$install_dir is not on your PATH. Add it in your shell config:"
        echo "  export PATH=\"$install_dir:\$PATH\"   # bash, zsh"
        echo "  fish_add_path $install_dir   # fish"
        ;;
esac
