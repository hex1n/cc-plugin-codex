#!/usr/bin/env bash
set -euo pipefail
source_fixture="/private/tmp/cc-plugin-codex-e2e.XcSnh0"
target="${1:-/private/tmp/cc-plugin-codex-e2e-rerun}"
if [[ ! -d "$source_fixture/.git" ]]; then echo "Retained source fixture is unavailable" >&2; exit 1; fi
if [[ -e "$target" ]]; then echo "Refusing to overwrite: $target" >&2; exit 1; fi
cp -R "$source_fixture" "$target"
echo "$target"

