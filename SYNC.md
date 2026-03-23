# Upstream Sync Strategy

## Architecture

```
anomalyco/opencode (upstream)  ──fetch──>  local upstream/dev
                                                  │
                                              rebase onto
                                                  │
                                           feat/agent-teams (our work)
```

## Change Surface

### New files (11) — NEVER conflict
These are entirely additive. Upstream will never touch them.

```
src/team/events.ts          # 163 lines
src/team/inbox.ts           # 117 lines
src/team/index.ts           # 978 lines
src/team/messaging.ts       # 324 lines
src/tool/team.ts            # 687 lines
src/server/routes/team.ts   # 160 lines
src/cli/cmd/tui/component/dialog-team.tsx  # 179 lines
test/team/*.test.ts         # 3 files
test/tool/task-team-isolation.test.ts
```

### Modified files (6) — conflict risk, but tiny changes

| File | Lines added | What was added | Conflict risk |
|------|-------------|----------------|---------------|
| `id/id.ts` | 1 | `team: "tea"` in prefixes | LOW — rarely touched |
| `flag/flag.ts` | 11 | `OPENCODE_EXPERIMENTAL_AGENT_TEAMS` declare + getter | LOW — additive at end |
| `bootstrap.ts` | 21 | `Team.init()` block after existing code | MEDIUM — init order changes |
| `server/server.ts` | 2 | import + `.route("/team", TeamRoutes())` | LOW — additive |
| `tool/registry.ts` | 2 | import + `...(Flag... ? TeamTools : [])` | MEDIUM — tool list changes |
| `sync.tsx` | 52 | team store type + initial value + event handler | HIGH — actively developed |

## Sync Procedure

### Step 1: Fetch upstream
```bash
cd /Users/shabarkin/personal-projects/opencode-team
git fetch upstream
```

### Step 2: Dry-run rebase to check for conflicts
```bash
git rebase --dry-run upstream/dev 2>&1 || true
# If this isn't available in your git version, just proceed to step 3
```

### Step 3: Rebase
```bash
git rebase upstream/dev
```

### Step 4: If conflicts occur
The rebase will pause on each conflict. For each file:

```bash
# See what conflicted
git diff --name-only --diff-filter=U

# For each conflicted file, the fix is almost always:
# "accept upstream changes, then re-add our small addition"
```

**Conflict resolution cheatsheet:**

| File | Resolution |
|------|-----------|
| `id/id.ts` | Accept upstream, re-add `team: "tea"` to prefixes object |
| `flag/flag.ts` | Accept upstream, re-add the `declare` line after last experimental flag + the `Object.defineProperty` block at end of file |
| `bootstrap.ts` | Accept upstream, re-add the `if (Flag.OPENCODE_EXPERIMENTAL_AGENT_TEAMS)` block at the end of `InstanceBootstrap()` |
| `server/server.ts` | Accept upstream, re-add `import { TeamRoutes }` and `.route("/team", TeamRoutes())` near other routes |
| `registry.ts` | Accept upstream, re-add `import { TeamTools }` and the `...(Flag.OPENCODE_EXPERIMENTAL_AGENT_TEAMS ? TeamTools : [])` line |
| `sync.tsx` | Most likely to conflict. Accept upstream, then re-add: (1) `team: { ... }` type in store, (2) `team: {}` in initial value, (3) the `if (type.startsWith("team."))` block after the switch |

After resolving each file:
```bash
git add <resolved-file>
git rebase --continue
```

### Step 5: Verify
```bash
cd packages/opencode
bun run typecheck        # Must pass clean
bun test                 # Run tests
bun run build --single   # Build binary
```

### Step 6: If rebase is too messy, abort and re-apply
```bash
git rebase --abort

# Nuclear option: create fresh branch from upstream, re-apply our commit
git checkout -b feat/agent-teams-v2 upstream/dev
git cherry-pick feat/agent-teams  # our single commit
# Resolve conflicts, then rename branches
```

## Automation Script

Save as `sync.sh` in the repo root:

```bash
#!/bin/bash
set -e

echo "=== Fetching upstream ==="
git fetch upstream

echo "=== Current position ==="
BEFORE=$(git rev-parse HEAD)
UPSTREAM=$(git rev-parse upstream/dev)

if [ "$BEFORE" = "$UPSTREAM" ]; then
  echo "Already up to date."
  exit 0
fi

BEHIND=$(git rev-list --count HEAD..upstream/dev)
echo "Behind upstream by $BEHIND commits"

echo "=== Rebasing onto upstream/dev ==="
if ! git rebase upstream/dev; then
  echo ""
  echo "!!! CONFLICTS DETECTED !!!"
  echo "Conflicted files:"
  git diff --name-only --diff-filter=U
  echo ""
  echo "Resolve conflicts, then run:"
  echo "  git add <files>"
  echo "  git rebase --continue"
  echo ""
  echo "Or abort with: git rebase --abort"
  exit 1
fi

echo "=== Verifying build ==="
cd packages/opencode
bun run typecheck
echo ""
echo "=== Sync complete ==="
echo "Rebased $BEHIND commits from upstream."
echo "New HEAD: $(git rev-parse --short HEAD)"
```

## When to sync

- **Before starting new work** on the agent teams feature
- **Weekly** at minimum if upstream is active
- **After major upstream releases** (check tags with `git tag --sort=-creatordate | head -5`)

## If upstream adds their own agent teams

PR #18753 on anomalyco/opencode is a DB-based agent teams implementation created March 23.
If that merges into dev, you'll need to decide:
1. **Replace ours** with theirs (if theirs is more complete)
2. **Merge approaches** (keep our features, adopt their DB schema)
3. **Keep ours** and resolve the overlap

Monitor with:
```bash
gh pr view 18753 --repo anomalyco/opencode --json state,mergedAt
```
