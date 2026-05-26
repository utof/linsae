#!/usr/bin/env bash
# Fails if the :root { } token block in src/renderer/src/styles/colors_and_type.css
# diverges from v21-design-system/project/colors_and_type.css.
#
# Why pure awk+diff (no normalization): the renderer CSS is excluded from biome
# via biome.json (!!src/renderer/src/styles/colors_and_type.css), so it stays
# byte-identical to the v21 source below the @font-face header.
set -euo pipefail

# Run from repo root regardless of invoker's cwd.
cd "$(git rev-parse --show-toplevel)"

src=v21-design-system/project/colors_and_type.css
dst=src/renderer/src/styles/colors_and_type.css

src_block=$(awk '/^:root \{/,/^\}$/' "$src")
dst_block=$(awk '/^:root \{/,/^\}$/' "$dst")

# Guard against silent-pass: if the awk pattern stops matching (selector renamed,
# block wrapped in @layer, etc.) both sides return empty and diff would exit 0.
[[ -n "$src_block" ]] || { echo "':root {' block not found in $src — drift check cannot run" >&2; exit 1; }
[[ -n "$dst_block" ]] || { echo "':root {' block not found in $dst — drift check cannot run" >&2; exit 1; }

diff <(printf '%s\n' "$src_block") <(printf '%s\n' "$dst_block") || {
  echo "Design tokens have drifted from v21 source. Reconcile manually." >&2
  exit 1
}
