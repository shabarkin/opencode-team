import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { Agent } from "../agent/agent"
import { Config } from "../config"
import { MessageV2 } from "../session/message-v2"
import { Session } from "../session"
import type { TaskPromptOps } from "./task"
import { MessageID } from "../session/schema"
import { Team } from "../team"
import { TeamMessaging } from "../team/messaging"
import { TEAM_TOOL_IDS } from "./team-ids"
import { TeamNotepad } from "../team/notepad"
import { childPermission } from "./child-permission"

export const Parameters = Schema.Struct({
  description: Schema.String.annotate({ description: "A short (3-5 words) description of the delegated task" }),
  prompt: Schema.String.annotate({ description: "The task for the delegated agent to perform" }),
  agent: Schema.String.annotate({ description: "The agent type to use for this delegated task" }),
  post_to_lead: Schema.optional(Schema.Boolean).annotate({
    description: "If true, post a short summary of the delegated result to the lead after it finishes",
  }),
})

type Metadata = {
  sessionId?: string
  model?: { modelID: string; providerID: string }
}

export const TeamDelegateTool = Tool.define<
  typeof Parameters,
  Metadata,
  Agent.Service | Config.Service | Session.Service
>(
  "team_delegate",
  Effect.gen(function* () {
    const agent = yield* Agent.Service
    const config = yield* Config.Service
    const sessions = yield* Session.Service

    // The legacy implementation listed available agent names in the
    // description string. That requires Instance context (Agent.list reads
    // per-instance state), but Tool.define's init now runs at AppRuntime
    // layer build, before any instance is provisioned. Keep the description
    // static and surface unknown-agent errors in execute instead.
    return {
      description:
        "Run a lightweight delegated subagent for a teammate without adding a new team member. " +
        "Pass the desired subagent type as `agent`; if unknown, the tool errors with the available names. " +
        "The delegate does not join the team, has no inbox, and returns its result only to the calling teammate.",
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const info = yield* Effect.promise(() => Team.findBySession(ctx.sessionID))
          if (!info || info.role !== "member" || !info.memberName) {
            return { title: "Error", output: "Only teammates can use team_delegate.", metadata: {} }
          }
          const memberName = info.memberName
          const teamName = info.team.name

          const next = yield* agent.get(params.agent)
          if (!next || next.mode === "primary" || next.hidden === true) {
            const allAgents = yield* agent.list()
            const visible = allAgents
              .filter((item) => item.mode !== "primary" && item.hidden !== true)
              .map((item) => item.name)
              .sort()
            return {
              title: "Error",
              output: `Unknown agent type: ${params.agent}. Available agents: ${visible.join(", ")}`,
              metadata: {},
            }
          }

          const cfg = yield* config.get()
          const hasTask = next.permission.some((rule) => rule.permission === "task")
          const note = yield* Effect.promise(() => TeamNotepad.context(teamName).catch(() => ""))
          const parent = yield* sessions.get(ctx.sessionID)
          const permission = childPermission({
            tools: TEAM_TOOL_IDS,
            task: hasTask,
            primary: cfg.experimental?.primary_tools,
            parent: parent.permission,
          })

          const session = yield* sessions.create({
            parentID: ctx.sessionID,
            title: `${params.description} (@${next.name} delegate) [${teamName}/${memberName}]`,
            permission,
          })

          yield* Effect.promise(() =>
            Team.setTrace(session.id, {
              parentTeam: teamName,
              parentMember: memberName,
              mode: "delegate",
            }),
          )

          const msg = yield* Effect.sync(() => MessageV2.get({ sessionID: ctx.sessionID, messageID: ctx.messageID }))
          if (msg.info.role !== "assistant") return yield* Effect.fail(new Error("Not an assistant message"))

          const model = next.model ?? {
            modelID: msg.info.modelID,
            providerID: msg.info.providerID,
          }

          yield* ctx.metadata({
            title: params.description,
            metadata: { sessionId: session.id, model },
          })

          const promptText = [
            `You are a delegated subagent working for teammate "${memberName}" in team "${teamName}".`,
            "You are NOT a team member. You cannot message the team, claim tasks, or use team tools.",
            "Your result is returned only to the calling teammate.",
            note ? `Read-only team notepad context:\n${note}` : "",
            params.prompt,
          ]
            .filter(Boolean)
            .join("\n\n")

          const ops = ctx.extra?.promptOps as TaskPromptOps
          if (!ops) return yield* Effect.fail(new Error("TeamDelegateTool requires promptOps in ctx.extra"))

          const messageID = MessageID.ascending()
          function cancel() {
            ops.cancel(session.id)
          }

          return yield* Effect.acquireUseRelease(
            Effect.gen(function* () {
              ctx.abort.addEventListener("abort", cancel)
              yield* Effect.promise(() => Team.bumpDelegations(teamName, memberName, 1))
            }),
            () =>
              Effect.gen(function* () {
                const parts = yield* ops.resolvePromptParts(promptText)
                const result = yield* ops.prompt({
                  messageID,
                  sessionID: session.id,
                  model: {
                    modelID: model.modelID,
                    providerID: model.providerID,
                  },
                  agent: next.name,
                  tools: {
                    todowrite: false,
                    todoread: false,
                    ...Object.fromEntries(TEAM_TOOL_IDS.map((tool) => [tool, false])),
                    ...(hasTask ? {} : { task: false }),
                    ...Object.fromEntries((cfg.experimental?.primary_tools ?? []).map((tool: string) => [tool, false])),
                  },
                  parts,
                })

                const text = result.parts.findLast((part) => part.type === "text")?.text ?? ""
                if (params.post_to_lead && text) {
                  yield* Effect.promise(() =>
                    TeamMessaging.send({
                      teamName,
                      from: memberName,
                      to: "lead",
                      text,
                      type: "result",
                      priority: "normal",
                    }).catch(() => {}),
                  )
                }

                return {
                  title: params.description,
                  metadata: { sessionId: session.id, model },
                  output: [
                    `task_id: ${session.id}`,
                    "",
                    "<delegate_result>",
                    text,
                    "</delegate_result>",
                  ].join("\n"),
                }
              }),
            () =>
              Effect.gen(function* () {
                ctx.abort.removeEventListener("abort", cancel)
                yield* Effect.promise(() => Team.bumpDelegations(teamName, memberName, -1))
              }),
          )
        }).pipe(Effect.orDie),
    } satisfies Tool.DefWithoutID<typeof Parameters, Metadata>
  }),
)
