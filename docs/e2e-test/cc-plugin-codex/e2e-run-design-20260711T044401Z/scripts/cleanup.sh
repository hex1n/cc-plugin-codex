#!/usr/bin/env bash
set -euo pipefail
fixture="/private/tmp/cc-plugin-codex-e2e.XcSnh0"
archive="/private/tmp/cc-plugin-codex-e2e-archive-20260711T044401Z"
if [[ -e "$archive" ]]; then echo "Archive exists; refusing to overwrite" >&2; exit 1; fi
mkdir -p "$archive/jobs"
if [[ -d "$fixture" ]]; then mv "$fixture" "$archive/fixture"; fi
job_dir="$HOME/.codex/claude-companion/jobs/7a2cf055c8e438b3"
for id in 850e2349-de2e-4c66-97f6-52587130b9c1 49cd15ac-1749-4151-964c-c2ec4d349d49; do
  for suffix in json stdout.log stderr.log; do
    path="$job_dir/$id.$suffix"
    if [[ -e "$path" ]]; then mv "$path" "$archive/jobs/"; fi
  done
done
echo "$archive"

