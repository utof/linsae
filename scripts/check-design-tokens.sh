#!/usr/bin/env bash
# Fails if the :root { } token block in src/renderer/src/styles/colors_and_type.css
# diverges semantically from v21-design-system/project/colors_and_type.css.
#
# Normalization applied before diffing (biome-safe):
#   1. Extract the :root { … } block via awk
#   2. Normalize CSS variable value formatting to match biome's output:
#      - Ensure space after colon in CSS custom property declarations
#      - Lowercase hex color literals only (not all text)
#      - Add spaces after commas in function arguments
#      - Remove trailing zeros in decimal fractions (0.10→0.1, 0.0→0)
#      - Collapse alignment spaces to single space, strip leading/trailing space
# Why: biome reformats the renderer copy while v21 source stays in original style.
# This check catches token additions/deletions/value changes, not formatting.
set -euo pipefail

src=v21-design-system/project/colors_and_type.css
dst=src/renderer/src/styles/colors_and_type.css

normalize() {
  awk '/^:root \{/,/^\}$/' "$1" | \
    # Ensure space after colon in custom property declarations (--foo:#val → --foo: #val)
    sed 's/\(--[a-zA-Z0-9_-]*\):\([^ ]\)/\1: \2/g' | \
    # Lowercase hex color literals (#RRGGBB or #RGB)
    sed 's/#\([0-9A-Fa-f]\{3,8\}\)/#\L\1/g' 2>/dev/null || \
    sed 's/#\([0-9A-Fa-f]\{3,8\}\)/\L&#/g' 2>/dev/null || true
}

# Use python3 for reliable normalization if sed \L is not supported
normalize_py() {
  local file="$1"
  python3 - "$file" <<'PYEOF'
import sys
import re

with open(sys.argv[1]) as f:
    lines = f.readlines()

in_root = False
result = []
for line in lines:
    stripped = line.rstrip('\n')
    if stripped == ':root {':
        in_root = True
    if in_root:
        # 1. Ensure space after colon in custom property declarations
        stripped = re.sub(r'(--[\w-]+):([^ ])', r'\1: \2', stripped)
        # 2. Lowercase hex color literals (# followed by 3-8 hex chars)
        stripped = re.sub(r'#([0-9A-Fa-f]{3,8})\b',
                          lambda m: '#' + m.group(1).lower(), stripped)
        # 3. Add spaces after commas inside function calls
        stripped = re.sub(r',(?! )', ', ', stripped)
        # 4. Remove trailing zeros: 0.10 → 0.1, but not 0.1 → 0.1
        stripped = re.sub(r'(\.\d*[1-9])0+\b', r'\1', stripped)
        # 5. Remove .0 suffix: 0.0 → 0
        stripped = re.sub(r'\b(\d+)\.0\b', r'\1', stripped)
        # 6. Collapse alignment whitespace (multiple spaces to one)
        stripped = re.sub(r'  +', ' ', stripped)
        # 7. Strip leading/trailing whitespace
        stripped = stripped.strip()
        result.append(stripped)
    if in_root and stripped.rstrip() == '}':
        break

print('\n'.join(result))
PYEOF
}

diff <(normalize_py "$src") <(normalize_py "$dst") || {
  echo "Design tokens have drifted from v21 source. Reconcile manually." >&2
  exit 1
}
