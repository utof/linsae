#!/usr/bin/env bash
# Fails if the :root { } token block in src/renderer/src/styles/colors_and_type.css
# diverges from v21-design-system/project/colors_and_type.css.
#
# Why pure awk+diff (no normalization): the renderer CSS is excluded from biome
# via biome.json (!!src/renderer/src/styles/colors_and_type.css), so it stays
# byte-identical to the v21 source below the @font-face header.
set -euo pipefail

src=v21-design-system/project/colors_and_type.css
dst=src/renderer/src/styles/colors_and_type.css

diff <(awk '/^:root \{/,/^\}$/' "$src") <(awk '/^:root \{/,/^\}$/' "$dst") || {
  echo "Design tokens have drifted from v21 source. Reconcile manually." >&2
  exit 1
}
