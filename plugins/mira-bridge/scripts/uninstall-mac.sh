#!/bin/sh
set -eu

install_root="${MIRABRIDGE_INSTALL_ROOT:-$HOME/Library/Application Support/MiraBridge}"
bin_root="${MIRABRIDGE_BIN_DIR:-$HOME/.local/bin}"
case "$install_root" in
  /*) ;;
  *) echo "MIRABRIDGE_INSTALL_ROOT must be an absolute path." >&2; exit 64 ;;
esac
if [ -d "$install_root" ]; then install_root=$(CDPATH= cd -- "$install_root" && pwd -P); fi
case "$install_root" in
  /|"$HOME") echo "Refusing an unsafe MiraBridge uninstall root: $install_root" >&2; exit 64 ;;
esac
case "$install_root" in
  /*/*/*|/*/MiraBridge|/*/MiraBridge-*) ;;
  *) echo "Refusing an overly broad MiraBridge uninstall root: $install_root" >&2; exit 64 ;;
esac
codex_bin="${MIRABRIDGE_CODEX:-}"
purge=0
[ "${1:-}" = "--purge-data" ] && purge=1

if [ -z "$codex_bin" ]; then
  if command -v codex >/dev/null 2>&1; then codex_bin=$(command -v codex)
  elif [ -x "/Applications/ChatGPT.app/Contents/Resources/codex" ]; then codex_bin="/Applications/ChatGPT.app/Contents/Resources/codex"
  fi
fi
[ -z "$codex_bin" ] || "$codex_bin" plugin remove mira-bridge@mirabridge --json >/dev/null 2>&1 || true

rm -f "$bin_root/mirabridge"
rm -rf "$install_root/releases" "$install_root/current" "$install_root/cache"
if [ "$purge" -eq 1 ]; then
  config_root="${XDG_CONFIG_HOME:-$HOME/.config}/mirabridge"
  case "$config_root" in
    /|"$HOME") echo "Refusing an unsafe MiraBridge config root: $config_root" >&2; exit 64 ;;
  esac
  case "$config_root" in
    /*/*/*|/*/mirabridge) ;;
    *) echo "Refusing an overly broad MiraBridge config root: $config_root" >&2; exit 64 ;;
  esac
  rm -rf "$install_root" "$config_root"
  echo "MiraBridge runtime and local pairing/configuration data were removed."
else
  echo "MiraBridge runtime was removed. Pairing/configuration data was preserved in ${XDG_CONFIG_HOME:-$HOME/.config}/mirabridge."
fi
