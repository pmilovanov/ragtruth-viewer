#!/bin/sh
# Download the dataset into site/data/ (git-ignored), from the upstream commit
# the viewer is pinned to in site/js/config.js. Optional: without a local copy
# the viewer fetches the same files from GitHub. Used by CI and `just fetch-data`.
set -eu
cd "$(dirname "$0")/.."
base=$(node -e 'import("./site/js/config.js").then((m) => process.stdout.write(m.UPSTREAM_BASE))')
mkdir -p site/data
for f in response.jsonl source_info.jsonl; do
  echo "downloading $base$f"
  curl -fsSL --compressed --retry 3 "$base$f" -o "site/data/$f.part"
  mv "site/data/$f.part" "site/data/$f"
done
