#!/usr/bin/env bash
# Fails when a commit in <base>..<head> or the pull request description ($BODY) credits Claude: a Co-Authored-By line
# naming Claude or anthropic.com, or "Generated with Claude Code". Run by CI (the `attribution` job); locally:
#   bash scripts/no-ai-credit.sh origin/main HEAD
set -euo pipefail
base="$1"
head="$2"
pattern='co-authored-by:.*(claude|anthropic\.com)|generated with \[?claude'
found=$(git log --format='%h %s%n%b' "$base..$head" | grep -iE "$pattern" || true)
if [ -n "$found" ]; then
  echo "::error::A commit credits Claude. Remove the line (git commit --amend, or an interactive rebase) and push again:"
  echo "$found"
  exit 1
fi
if printf '%s' "${BODY:-}" | grep -qiE "$pattern"; then
  echo "::error::The pull request description credits Claude. Edit the description to remove it, then re-run this check."
  exit 1
fi
echo "No AI credit found in $(git rev-list --count "$base..$head") commit(s) or the description."
