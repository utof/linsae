#!/usr/bin/env sh
# Exit 0 if the staged diff contains any NON-markdown file (heavy pre-commit
# checks should run); exit 1 if the commit is markdown-only (docs/ADRs — skip
# the heavy steps). Lets lefthook stay in charge of every commit (never
# --no-verify) while not paying ~2min of tsc/vitest/knip + a native rebuild for
# a prose-only change. `grep -qv` is true when a line does NOT match, i.e. when
# some staged path doesn't end in `.md`.
git diff --cached --name-only --diff-filter=ACMR | grep -qvE '\.md$'
