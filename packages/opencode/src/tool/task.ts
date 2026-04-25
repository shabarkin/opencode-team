import * as Tool from "./tool"
import DESCRIPTION from "./task.txt"
import { Session } from "../session"
import { SessionID, MessageID } from "../session/schema"
import { MessageV2 } from "../session/message-v2"
import { Agent } from "../agent/agent"
import type { SessionPrompt } from "../session/prompt"
import { Config } from "../config"
import { Effect, Schema } from "effect"
import { Team } from "../team"
import { TEAM_TOOL_IDS } from "./team-ids"
import { childPermission } from "./child-permission"
import { Log } from "@/util"

const log = Log.create({ service: "tool.task" })

export interface TaskPromptOps {
  cancel(sessionID: SessionID): void
  resolvePromptParts(template: string): Effect.Effect<SessionPrompt.PromptInput["parts"]>
  prompt(input: SessionPrompt.PromptInput): Effect.Effect<MessageV2.WithParts>
}

const id = "task"

export const Parameters = Schema.Struct({
  description: Schema.String.annotate({ description: "A short (3-5 words) description of the task" }),
  prompt: Schema.String.annotate({ description: "The task for the agent to perform" }),
  subagent_type: Schema.String.annotate({ description: "The type of specialized agent to use for this task" }),
  task_id: Schema.optional(Schema.String).annotate({
    description:
      "This should only be set if you mean to resume a previous task (you can pass a prior task_id and the task will continue the same subagent session as before instead of creating a fresh one)",
  }),
  command: Schema.optional(Schema.String).annotate({ description: "The command that triggered this task" }),
})

export const TaskTool = Tool.define(
  id,
  Effect.gen(function* () {
    const agent = yield* Agent.Service
    const config = yield* Config.Service
    const sessions = yield* Session.Service

    const run = Effect.fn("TaskTool.execute")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context,
    ) {
      const cfg = yield* config.get()

      if (!ctx.extra?.bypassAgentCheck) {
        yield* ctx.ask({
          permission: id,
          patterns: [params.subagent_type],
          always: ["*"],
          metadata: {
            description: params.description,
            subagent_type: params.subagent_type,
          },
        })
      }

      const next = yield* agent.get(params.subagent_type)
      if (!next) {
        return yield* Effect.fail(new Error(`Unknown agent type: ${params.subagent_type} is not a valid agent type`))
      }

      const canTask = next.permission.some((rule) => rule.permission === id)
      const canTodo = next.permission.some((rule) => rule.permission === "todowrite")

      // Team-task isolation: if the parent session belongs to a team member,
      // restrict the spawned subagent to read-only notepad and team tools off,
      // and tag the spawned session with a trace pointing back to the team.
      const info = yield* Effect.promise(() => Team.findBySession(ctx.sessionID).catch(() => undefined))
      const linked = yield* Effect.promise(async () => {
        if (info?.role === "member" && info.memberName) {
          return { parentTeam: info.team.name, parentMember: info.memberName, mode: "task" as const }
        }
        const item = await Team.trace(ctx.sessionID).catch(() => undefined)
        return item
          ? { parentTeam: item.parentTeam, parentMember: item.parentMember, mode: "task" as const }
          : undefined
      })
      const allowPad = info?.role === "member" && !!info.memberName
      const teamTools = TEAM_TOOL_IDS.filter((tid) => !allowPad || tid !== "team_notepad")
      const parent = yield* sessions.get(ctx.sessionID).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
      const permission = childPermission({
        tools: teamTools,
        pad: allowPad,
        task: canTask,
        primary: cfg.experimental?.primary_tools,
        parent: parent?.permission,
      })

      const taskID = params.task_id
      const session = taskID
        ? yield* sessions.get(SessionID.make(taskID)).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
        : undefined
      if (session && session.parentID !== ctx.sessionID) {
        return yield* Effect.fail(new Error(`task_id "${taskID}" does not belong to this session.`))
      }
      let nextSession: NonNullable<typeof session>
      if (session) {
        yield* sessions
          .setPermission({ sessionID: session.id, permission })
          .pipe(Effect.catchCause(() => Effect.void))
        nextSession = session
      } else {
        nextSession = yield* sessions.create({
          parentID: ctx.sessionID,
          title:
            params.description +
            ` (@${next.name} subagent)` +
            (linked ? ` [${linked.parentTeam}/${linked.parentMember}]` : ""),
          permission,
        })
      }
      if (linked && nextSession) {
        yield* Effect.promise(() => Team.setTrace(nextSession!.id, linked).catch(() => {}))
      }

      const msg = yield* Effect.sync(() => MessageV2.get({ sessionID: ctx.sessionID, messageID: ctx.messageID }))
      if (msg.info.role !== "assistant") return yield* Effect.fail(new Error("Not an assistant message"))

      const model = next.model ?? {
        modelID: msg.info.modelID,
        providerID: msg.info.providerID,
      }

      yield* ctx.metadata({
        title: params.description,
        metadata: {
          sessionId: nextSession.id,
          model,
        },
      })

      const ops = ctx.extra?.promptOps as TaskPromptOps
      if (!ops) return yield* Effect.fail(new Error("TaskTool requires promptOps in ctx.extra"))

      const messageID = MessageID.ascending()

      function cancel() {
        try {
          ops.cancel(nextSession.id)
        } catch (error) {
          log.warn("task child cancel failed", {
            sessionID: nextSession.id,
            error: error instanceof Error ? error.message : String(error),
          })
        }
      }

      return yield* Effect.acquireUseRelease(
        Effect.sync(() => {
          ctx.abort.addEventListener("abort", cancel)
        }),
        () =>
          Effect.gen(function* () {
            const promptText = allowPad
              ? [
                  `You are working for teammate "${linked!.parentMember}" in team "${linked!.parentTeam}".`,
                  "You cannot message the team directly.",
                  "You may use team_notepad only in read/list mode for team context.",
                  params.prompt,
                ].join("\n\n")
              : params.prompt
            const parts = yield* ops.resolvePromptParts(promptText)
            const result = yield* ops.prompt({
              messageID,
              sessionID: nextSession.id,
              model: {
                modelID: model.modelID,
                providerID: model.providerID,
              },
              agent: next.name,
              tools: {
                ...(canTodo ? {} : { todowrite: false }),
                ...(canTask ? {} : { task: false }),
                ...Object.fromEntries(teamTools.map((tid) => [tid, false])),
                ...Object.fromEntries((cfg.experimental?.primary_tools ?? []).map((item) => [item, false])),
              },
              parts,
            })

            return {
              title: params.description,
              metadata: {
                sessionId: nextSession.id,
                model,
              },
              output: [
                `task_id: ${nextSession.id} (for resuming to continue this task if needed)`,
                "",
                "<task_result>",
                result.parts.findLast((item) => item.type === "text")?.text ?? "",
                "</task_result>",
              ].join("\n"),
            }
          }),
        () =>
          Effect.sync(() => {
            ctx.abort.removeEventListener("abort", cancel)
          }),
      )
    })

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        run(params, ctx).pipe(Effect.orDie),
    }
  }),
)
