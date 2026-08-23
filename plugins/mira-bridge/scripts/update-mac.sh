#!/bin/sh
set -eu

version="${1:-2.0.0-rc.5}"
case "$version" in
  v*) version=${version#v} ;;
esac
install_root="${MIRABRIDGE_INSTALL_ROOT:-$HOME/Library/Application Support/MiraBridge}"
temporary_root=$(mktemp -d "${TMPDIR:-/tmp}/mirabridge-update.XXXXXX")
trap 'rm -rf "$temporary_root"' EXIT HUP INT TERM
archive="$temporary_root/source.tar.gz"

curl --fail --location --proto '=https' --tlsv1.2 \
  "https://github.com/2387452986/MiraBridge/archive/refs/tags/v$version.tar.gz" \
  --output "$archive"
tar -xzf "$archive" -C "$temporary_root"
source_root=$(find "$temporary_root" -mindepth 1 -maxdepth 1 -type d -name 'MiraBridge-*' | head -n 1)
[ -n "$source_root" ] || { echo "Downloaded release did not contain the MiraBridge source tree." >&2; exit 74; }

MIRABRIDGE_INSTALL_ROOT="$install_root" "$source_root/plugins/mira-bridge/scripts/install-mac.sh"
