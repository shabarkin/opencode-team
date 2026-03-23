#!/bin/bash
set -e

cd "$(dirname "$0")"

echo "=== Fetching upstream ==="
git fetch upstream

BEFORE=$(git rev-parse HEAD)
UPSTREAM=$(git rev-parse upstream/dev)

if [ "$BEFORE" = "$UPSTREAM" ]; then
  echo "Already up to date."
  exit 0
fi

BEHIND=$(git rev-list --count HEAD..upstream/dev)
echo "Behind upstream by $BEHIND commits"

# Check which of our modified files were also touched upstream
echo ""
echo "=== Conflict risk check ==="
MODIFIED_FILES=(
  "packages/opencode/src/id/id.ts"
  "packages/opencode/src/flag/flag.ts"
  "packages/opencode/src/project/bootstrap.ts"
  "packages/opencode/src/server/server.ts"
  "packages/opencode/src/tool/registry.ts"
  "packages/opencode/src/cli/cmd/tui/context/sync.tsx"
)

RISK=0
for f in "${MODIFIED_FILES[@]}"; do
  UPSTREAM_CHANGES=$(git log --oneline HEAD..upstream/dev -- "$f" | wc -l | tr -d ' ')
  if [ "$UPSTREAM_CHANGES" -gt 0 ]; then
    echo "  WARNING: $f changed $UPSTREAM_CHANGES times upstream"
    RISK=1
  fi
done

if [ "$RISK" -eq 0 ]; then
  echo "  No upstream changes to our modified files — clean rebase expected"
fi

echo ""
echo "=== Rebasing onto upstream/dev ==="
if ! git rebase upstream/dev; then
  echo ""
  echo "!!! CONFLICTS DETECTED !!!"
  echo ""
  echo "Conflicted files:"
  git diff --name-only --diff-filter=U
  echo ""
  echo "Resolution guide:"
  echo "  For each file: accept upstream, re-add our small additions."
  echo "  See SYNC.md for per-file instructions."
  echo ""
  echo "After resolving:  git add <files> && git rebase --continue"
  echo "To abort:         git rebase --abort"
  exit 1
fi

echo ""
echo "=== Verifying typecheck ==="
cd packages/opencode
if bun run typecheck 2>&1 | tail -1 | grep -q "error"; then
  echo "!!! TYPECHECK FAILED — review errors above !!!"
  exit 1
fi

echo ""
echo "=== Sync complete ==="
echo "Rebased $BEHIND commits from upstream."
echo "Previous HEAD: $(echo $BEFORE | cut -c1-10)"
echo "New HEAD:      $(git rev-parse --short HEAD)"
