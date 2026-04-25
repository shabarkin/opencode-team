- To regenerate the JavaScript SDK, run `./packages/sdk/js/script/build.ts`.
- ALWAYS USE PARALLEL TOOLS WHEN APPLICABLE.
- The default branch in this repo is `dev`.
- Local `main` ref may not exist; use `dev` or `origin/dev` for diffs.
- Prefer automation: execute requested actions without confirmation unless blocked by missing info or safety/irreversibility.

## Fork Context: Agent Teams

This repo is a fork of `anomalyco/opencode` with the **Agent Teams** feature ported from blog post PRs #12730, #12731, #12732.

### Repository setup
- `upstream` remote = `anomalyco/opencode` (the canonical OpenCode repo)
- Work branch = `feat/agent-teams`, based on upstream `dev`
- Feature gated behind `OPENCODE_EXPERIMENTAL_AGENT_TEAMS=1` env var

### What we added
- `src/team/` — 4 files: events.ts, inbox.ts, index.ts, messaging.ts (core team state, messaging, recovery)
- `src/tool/team.ts` — 9 MCP tools (team_create, team_spawn, team_message, team_broadcast, team_tasks, team_claim, team_approve_plan, team_shutdown, team_cleanup)
- `src/server/routes/team.ts` — HTTP routes for team management
- `src/cli/cmd/tui/component/dialog-team.tsx` — TUI team dialog
- `test/team/` and `test/tool/task-team-isolation.test.ts` — tests

### What we modified (conflict surface — keep these minimal)
Only 6 files were modified with small, localized additions:

| File | What was added | Lines |
|------|---------------|-------|
| `src/id/id.ts` | `team: "tea"` in Identifier prefixes | 1 |
| `src/flag/flag.ts` | `OPENCODE_EXPERIMENTAL_AGENT_TEAMS` flag (declare + dynamic getter) | 11 |
| `src/project/bootstrap.ts` | Team recovery block at end of `InstanceBootstrap()` | 21 |
| `src/server/server.ts` | TeamRoutes import + `.route("/team", TeamRoutes())` | 2 |
| `src/tool/registry.ts` | TeamTools import + conditional spread in tool list | 2 |
| `src/cli/cmd/tui/context/sync.tsx` | `team` store type/initial value + event handler | 52 |

### Upstream sync procedure
Run `./sync.sh` to rebase onto latest upstream. See `SYNC.md` for full details.

If conflicts occur during rebase, the resolution is always: **accept upstream, re-add our small addition**. The new files (`src/team/`, `src/tool/team.ts`, etc.) never conflict.

### Key adaptations for current codebase (v1.3.0+)
The original PRs were written against a Feb 2026 codebase. These adaptations were needed:
- `Session.update()` does not exist — replaced with `Session.get()` + `Session.setPermission()`
- Branded types required everywhere: `SessionID.make()`, `MessageID.ascending()`, `PartID.ascending()`, `ProviderID.make()`, `ModelID.make()`
- `SessionStatus.get()` is async (Effect-based service) — must be awaited
- Dynamic imports for `SessionID` schema to avoid circular deps

### Rules for modifying team code
- All new team code goes in `src/team/`, `src/tool/team.ts`, `src/server/routes/team.ts`, or `dialog-team.tsx` — these are ours and never conflict
- Minimize changes to shared files (the 6 listed above) — every added line is a potential conflict on next sync
- Always gate behind `Flag.OPENCODE_EXPERIMENTAL_AGENT_TEAMS` so the feature can be fully disabled
- Use branded types (`SessionID.make()` etc.) for all session/message/part/provider IDs
- After any change, run `bun run typecheck` from `packages/opencode`

### Watch: upstream PR #18753
PR #18753 on `anomalyco/opencode` is a DB-based agent teams implementation. If it merges, we need to evaluate overlap. Check with: `gh pr view 18753 --repo anomalyco/opencode --json state`

## Style Guide

### General Principles

- Keep things in one function unless composable or reusable
- Avoid `try`/`catch` where possible
- Avoid using the `any` type
- Use Bun APIs when possible, like `Bun.file()`
- Rely on type inference when possible; avoid explicit type annotations or interfaces unless necessary for exports or clarity
- Prefer functional array methods (flatMap, filter, map) over for loops; use type guards on filter to maintain type inference downstream
- In `src/config`, follow the existing self-export pattern at the top of the file (for example `export * as ConfigAgent from "./agent"`) when adding a new config module.

Reduce total variable count by inlining when a value is only used once.

```ts
// Good
const journal = await Bun.file(path.join(dir, "journal.json")).json()

// Bad
const journalPath = path.join(dir, "journal.json")
const journal = await Bun.file(journalPath).json()
```

### Destructuring

Avoid unnecessary destructuring. Use dot notation to preserve context.

```ts
// Good
obj.a
obj.b

// Bad
const { a, b } = obj
```

### Variables

Prefer `const` over `let`. Use ternaries or early returns instead of reassignment.

```ts
// Good
const foo = condition ? 1 : 2

// Bad
let foo
if (condition) foo = 1
else foo = 2
```

### Control Flow

Avoid `else` statements. Prefer early returns.

```ts
// Good
function foo() {
  if (condition) return 1
  return 2
}

// Bad
function foo() {
  if (condition) return 1
  else return 2
}
```

### Schema Definitions (Drizzle)

Use snake_case for field names so column names don't need to be redefined as strings.

```ts
// Good
const table = sqliteTable("session", {
  id: text().primaryKey(),
  project_id: text().notNull(),
  created_at: integer().notNull(),
})

// Bad
const table = sqliteTable("session", {
  id: text("id").primaryKey(),
  projectID: text("project_id").notNull(),
  createdAt: integer("created_at").notNull(),
})
```

## Testing

- Avoid mocks as much as possible
- Test actual implementation, do not duplicate logic into tests
- Tests cannot run from repo root (guard: `do-not-run-tests-from-root`); run from package dirs like `packages/opencode`.

## Type Checking

- Always run `bun typecheck` from package directories (e.g., `packages/opencode`), never `tsc` directly.
