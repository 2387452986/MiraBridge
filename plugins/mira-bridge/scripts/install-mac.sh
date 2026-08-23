#!/bin/sh
set -eu

version="2.0.0-rc.5"
node_version="24.19.0"
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
module_root=$(CDPATH= cd -- "$script_dir/.." && pwd)
repo_root=$(CDPATH= cd -- "$module_root/../.." && pwd)
install_root="${MIRABRIDGE_INSTALL_ROOT:-$HOME/Library/Application Support/MiraBridge}"
case "$install_root" in
  /*) ;;
  *) echo "MIRABRIDGE_INSTALL_ROOT must be an absolute path." >&2; exit 64 ;;
esac
mkdir -p "$install_root"
install_root=$(CDPATH= cd -- "$install_root" && pwd -P)
case "$install_root" in
  /|"$HOME") echo "Refusing an unsafe MiraBridge install root: $install_root" >&2; exit 64 ;;
esac
case "$install_root" in
  /*/*/*|/*/MiraBridge|/*/MiraBridge-*) ;;
  *) echo "Refusing an overly broad MiraBridge install root: $install_root" >&2; exit 64 ;;
esac
cache_root="$install_root/cache"
release_root="$install_root/releases/$version"
staging_root="$install_root/releases/.$version.staging.$$"
bin_root="${MIRABRIDGE_BIN_DIR:-$HOME/.local/bin}"
codex_bin="${MIRABRIDGE_CODEX:-}"

case "$(uname -m)" in
  arm64) node_arch="arm64"; node_sha="8294b7aa9b03997481c06babf1e8b270c859358f27da57a11509afe537ac381d" ;;
  x86_64) node_arch="x64"; node_sha="d1b5e999db158c62fe8f7267a4476b035d8bd93b1a605bac24a3f0dd166e3316" ;;
  *) echo "Unsupported Mac architecture: $(uname -m). MiraBridge supports Apple Silicon and Intel Macs." >&2; exit 65 ;;
esac

for command_name in curl tar shasum; do
  command -v "$command_name" >/dev/null 2>&1 || { echo "Required macOS command is missing: $command_name" >&2; exit 69; }
done

mkdir -p "$cache_root" "$install_root/releases" "$bin_root"
archive="$cache_root/node-v$node_version-darwin-$node_arch.tar.gz"
if [ ! -f "$archive" ] || [ "$(shasum -a 256 "$archive" | awk '{print $1}')" != "$node_sha" ]; then
  temporary="$archive.download.$$"
  trap 'rm -rf "$staging_root" "$temporary"' EXIT HUP INT TERM
  curl --fail --location --proto '=https' --tlsv1.2 \
    "https://nodejs.org/dist/v$node_version/node-v$node_version-darwin-$node_arch.tar.gz" \
    --output "$temporary"
  actual=$(shasum -a 256 "$temporary" | awk '{print $1}')
  [ "$actual" = "$node_sha" ] || { echo "Node.js archive SHA-256 mismatch." >&2; exit 74; }
  mv "$temporary" "$archive"
fi

rm -rf "$staging_root"
mkdir -p "$staging_root/node" "$staging_root/mcp" "$staging_root/cli" "$staging_root/scripts"
tar -xzf "$archive" --strip-components=1 -C "$staging_root/node"

node_bin="$staging_root/node/bin/node"
npm_cli="$staging_root/node/lib/node_modules/npm/bin/npm-cli.js"
managed_node_version=$("$node_bin" --version)
[ "$managed_node_version" = "v$node_version" ] || { echo "Managed Node version check failed." >&2; exit 70; }

if [ -f "$repo_root/release-manifest.json" ]; then
  "$node_bin" "$repo_root/scripts/verify-release-manifest.mjs" "$repo_root/release-manifest.json" "$repo_root"
fi

(cd "$module_root" && PATH="$staging_root/node/bin:$PATH" "$node_bin" "$npm_cli" ci --ignore-scripts=false && PATH="$staging_root/node/bin:$PATH" "$node_bin" "$npm_cli" run build)

cp "$module_root/packages/mcp-server/dist/index.mjs" "$staging_root/mcp/index.mjs"
cp "$module_root/packages/cli/dist/index.mjs" "$staging_root/cli/index.mjs"
cp "$script_dir/install-mac.sh" "$staging_root/scripts/install-mac.sh"
cp "$script_dir/update-mac.sh" "$staging_root/scripts/update-mac.sh"
cp "$script_dir/uninstall-mac.sh" "$staging_root/scripts/uninstall-mac.sh"
chmod 755 "$staging_root/mcp/index.mjs" "$staging_root/cli/index.mjs" "$staging_root/scripts/"*.sh
printf '%s\n' "$version" > "$staging_root/VERSION"

previous=""
if [ -L "$install_root/current" ]; then previous=$(readlink "$install_root/current" || true); fi
rm -rf "$release_root"
mv "$staging_root" "$release_root"
new_link="$install_root/.current.$$"
ln -s "$release_root" "$new_link"
# On macOS, plain `mv -f` follows a destination symlink to a directory and
# moves the new link inside the old release. `-h` replaces the link itself.
mv -fh "$new_link" "$install_root/current"

wrapper="$bin_root/mirabridge"
wrapper_tmp="$wrapper.$$"
{
  printf '%s\n' '#!/bin/sh' 'set -eu'
  printf '%s\n' 'runtime_root="${MIRABRIDGE_INSTALL_ROOT:-$HOME/Library/Application Support/MiraBridge}"'
  printf '%s\n' 'exec "$runtime_root/current/node/bin/node" "$runtime_root/current/cli/index.mjs" "$@"'
} > "$wrapper_tmp"
chmod 755 "$wrapper_tmp"
mv -f "$wrapper_tmp" "$wrapper"

if [ -z "$codex_bin" ]; then
  if command -v codex >/dev/null 2>&1; then codex_bin=$(command -v codex)
  elif [ -x "/Applications/ChatGPT.app/Contents/Resources/codex" ]; then codex_bin="/Applications/ChatGPT.app/Contents/Resources/codex"
  fi
fi

rollback() {
  if [ -n "$previous" ] && [ -d "$previous" ]; then
    rollback_link="$install_root/.current.rollback.$$"
    ln -s "$previous" "$rollback_link"
    mv -fh "$rollback_link" "$install_root/current"
  fi
}

if ! "$wrapper" doctor >/dev/null; then
  rollback
  echo "MiraBridge doctor failed; the previous runtime was restored." >&2
  exit 70
fi

if [ "${MIRABRIDGE_SKIP_PLUGIN_INSTALL:-0}" != "1" ]; then
  [ -n "$codex_bin" ] || { rollback; echo "Codex CLI was not found. Set MIRABRIDGE_CODEX and rerun." >&2; exit 69; }
  marketplace_source="${MIRABRIDGE_MARKETPLACE_SOURCE:-2387452986/MiraBridge}"
  # A Git marketplace remembers the ref used when it was first added. Merely
  # upgrading that snapshot therefore keeps an rc.1 installation pinned to
  # rc.1. Replace only MiraBridge's own registration so an explicit product
  # update also advances the marketplace and plugin cache to the same tag.
  "$codex_bin" plugin remove mira-bridge@mirabridge --json >/dev/null 2>&1 || true
  "$codex_bin" plugin marketplace remove mirabridge --json >/dev/null 2>&1 || true
  if [ -d "$marketplace_source" ]; then
    "$codex_bin" plugin marketplace add "$marketplace_source" --json >/dev/null
  else
    "$codex_bin" plugin marketplace add "$marketplace_source" --ref "v$version" --json >/dev/null
  fi
  "$codex_bin" plugin add mira-bridge@mirabridge --json >/dev/null
fi

# Reassert the selected runtime after Codex has replaced its marketplace and
# plugin cache, then verify the user-visible CLI rather than trusting staging.
final_link="$install_root/.current.final.$$"
ln -s "$release_root" "$final_link"
mv -fh "$final_link" "$install_root/current"
if ! "$wrapper" doctor >/dev/null; then
  rollback
  echo "MiraBridge final doctor failed; the previous runtime was restored." >&2
  exit 70
fi

trap - EXIT HUP INT TERM
printf 'MiraBridge %s installed.\nCLI: %s\nRuntime: %s\n' "$version" "$wrapper" "$release_root"
