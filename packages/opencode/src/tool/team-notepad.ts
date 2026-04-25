import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { Team } from "../team"
import { TeamNotepad } from "../team/notepad"

export const Parameters = Schema.Struct({
  action: Schema.Literals(["read", "write", "list", "delete"]).annotate({
    description: "What to do: read a key, write a key, list all, or delete a key",
  }),
  key: Schema.optional(Schema.String).annotate({
    description: "The notepad key (required for read/write/delete)",
  }),
  value: Schema.optional(Schema.String).annotate({
    description: "The value to write (required for write action)",
  }),
})

type Metadata = {
  action?: string
  key?: string
  count?: number
}

export const TeamNotepadTool = Tool.define<typeof Parameters, Metadata, never>(
  "team_notepad",
  Effect.gen(function* () {
    return {
      description:
        "Read or write to the shared team notepad — a persistent key-value store " +
        "that all teammates can access. Use this to share discoveries, conventions, " +
        "and decisions that teammates should know. New teammates automatically see " +
        "notepad contents when they are spawned.",
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          yield* ctx.ask({
            permission: "team_notepad",
            patterns: [params.action],
            always: [params.action],
            metadata: {
              action: params.action,
              key: params.key,
            },
          })

          const info = yield* Effect.promise(() => Team.findBySession(ctx.sessionID))
          if (!info) {
            return { title: "Error", output: "You are not part of any team.", metadata: {} }
          }
          const teamName = info.team.name

          switch (params.action) {
            case "list": {
              const data = yield* Effect.promise(() => TeamNotepad.list(teamName))
              const entries = Object.entries(data)
              if (entries.length === 0) {
                return { title: "Notepad", output: "Team notepad is empty.", metadata: {} }
              }
              const output = entries.map(([k, v]) => `[${k}]: ${v}`).join("\n")
              return { title: "Notepad", output, metadata: { count: entries.length } }
            }
            case "read": {
              if (!params.key) {
                return { title: "Error", output: "Key is required for read action.", metadata: {} }
              }
              const value = yield* Effect.promise(() => TeamNotepad.read(teamName, params.key!))
              if (value === undefined) {
                return { title: "Notepad", output: `Key "${params.key}" not found in notepad.`, metadata: {} }
              }
              return { title: `Notepad: ${params.key}`, output: value, metadata: {} }
            }
            case "write": {
              if (!params.key) {
                return { title: "Error", output: "Key is required for write action.", metadata: {} }
              }
              if (!params.value) {
                return { title: "Error", output: "Value is required for write action.", metadata: {} }
              }
              yield* Effect.promise(() => TeamNotepad.write(teamName, params.key!, params.value!))
              return {
                title: `Notepad updated: ${params.key}`,
                output: `Wrote "${params.key}" to team notepad. All teammates can now access this.`,
                metadata: {},
              }
            }
            case "delete": {
              if (!params.key) {
                return { title: "Error", output: "Key is required for delete action.", metadata: {} }
              }
              yield* Effect.promise(() => TeamNotepad.remove(teamName, params.key!))
              return {
                title: `Notepad deleted: ${params.key}`,
                output: `Removed "${params.key}" from notepad.`,
                metadata: {},
              }
            }
          }
        }).pipe(Effect.orDie),
    } satisfies Tool.DefWithoutID<typeof Parameters, Metadata>
  }),
)
