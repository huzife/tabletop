#!/usr/bin/env bash
set -euo pipefail

readonly native_directory="$(
  cd "$(dirname "${BASH_SOURCE[0]}")"
  pwd -P
)"
readonly workspace_directory="$(
  cd "$native_directory/../../.."
  pwd -P
)"

target_directory="${CARGO_TARGET_DIR:-$native_directory/target}"
if [[ "$target_directory" != /* ]]; then
  target_directory="$(pwd -P)/$target_directory"
fi
readonly target_directory

compiler_flags=()
if [[ -n "${CARGO_ENCODED_RUSTFLAGS:-}" ]]; then
  IFS=$'\x1f' read -r -a compiler_flags <<<"$CARGO_ENCODED_RUSTFLAGS"
elif [[ -n "${RUSTFLAGS:-}" ]]; then
  read -r -a compiler_flags <<<"$RUSTFLAGS"
fi

if [[ -n "${HOME:-}" ]]; then
  compiler_flags+=("--remap-path-prefix=$HOME=<user-home>")
fi
if [[ -n "${CARGO_HOME:-}" ]]; then
  compiler_flags+=("--remap-path-prefix=$CARGO_HOME=<cargo-home>")
fi
if [[ -n "${RUSTUP_HOME:-}" ]]; then
  compiler_flags+=("--remap-path-prefix=$RUSTUP_HOME=<rustup-home>")
fi
compiler_flags+=("--remap-path-prefix=$workspace_directory=<workspace>")
compiler_flags+=("--remap-path-prefix=$target_directory=<cargo-target>")

printf -v encoded_rustflags '%s\x1f' "${compiler_flags[@]}"
encoded_rustflags="${encoded_rustflags%$'\x1f'}"
unset RUSTFLAGS

CARGO_ENCODED_RUSTFLAGS="$encoded_rustflags" cargo build \
  --manifest-path "$native_directory/Cargo.toml" \
  --target wasm32-unknown-unknown \
  --release

mkdir -p "$native_directory/generated"
cp \
  "$target_directory/wasm32-unknown-unknown/release/tabletop_billiards_core.wasm" \
  "$native_directory/generated/tabletop_billiards_core.wasm"
