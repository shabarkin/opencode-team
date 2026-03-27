import { Tool } from "./tool"
import DESCRIPTION from "./task.txt"
import z from "zod"
import { Session } from "../session"
import { SessionID, MessageID } from "../session/schema"
import { MessageV2 } from "../session/message-v2"
import { Identifier } from "../id/id"
import { Agent } from "../agent/agent"
import { SessionPrompt } from "../session/prompt"
import { iife } from "@/util/iife"
import { defer } from "@/util/defer"
import { Config } from "../config/config"
import { Permission } from "@/permission"
import { Team } from "../team"
import { TEAM_TOOL_IDS } from "./team-ids"
import { Log } from "@/util/log"

const log = Log.create({ service: "tool.task" })

const parameters = z.object({
  description: z.string().describe("A short (3-5 words) description of the task"),
  prompt: z.string().describe("The task for the agent to perform"),
  subagent_type: z.string().describe("The type of specialized agent to use for this task"),
  task_id: z
    .string()
    .describe(
      "This should only be set if you mean to resume a previous task (you can pass a prior task_id and the task will continue the same subagent session as before instead of creating a fresh one)",
    )
    .optional(),
  command: z.string().describe("The command that triggered this task").optional(),
})

export const TaskTool = Tool.define("task", async (ctx) => {
  const agents = await Agent.list().then((x) => x.filter((a) => a.mode !== "primary"))

  // Filter agents by permissions if agent provided
  const caller = ctx?.agent
  const accessibleAgents = caller
    ? agents.filter((a) => Permission.evaluate("task", a.name, caller.permission).action !== "deny")
    : agents
  const list = accessibleAgents.toSorted((a, b) => a.name.localeCompare(b.name))

  const description = DESCRIPTION.replace(
    "{agents}",
    list
      .map((a) => `- ${a.name}: ${a.description ?? "This subagent should only be called manually by the user."}`)
      .join("\n"),
  )
  return {
    description,
    parameters,
    async execute(params: z.infer<typeof parameters>, ctx) {
      const config = await Config.get()

      // Skip permission check when user explicitly invoked via @ or command subtask
      if (!ctx.extra?.bypassAgentCheck) {
        await ctx.ask({
          permission: "task",
          patterns: [params.subagent_type],
          always: ["*"],
          metadata: {
            description: params.description,
            subagent_type: params.subagent_type,
          },
        })
      }

      const agent = await Agent.get(params.subagent_type)
      if (!agent) throw new Error(`Unknown agent type: ${params.subagent_type} is not a valid agent type`)

      const hasTaskPermission = agent.permission.some((rule) => rule.permission === "task")
      const info = await Team.findBySession(ctx.sessionID)
      const linked =
        info?.role === "member" && info.memberName
          ? { parentTeam: info.team.name, parentMember: info.memberName, mode: "task" as const }
          : await Team.trace(ctx.sessionID).then((item) =>
              item
                ? { parentTeam: item.parentTeam, parentMember: item.parentMember, mode: "task" as const }
                : undefined,
            )
      const allowPad = info?.role === "member" && !!info.memberName
      const tools = TEAM_TOOL_IDS.filter((id) => !allowPad || id !== "team_notepad")

      const session = await iife(async () => {
        if (params.task_id) {
          const found = await Session.get(SessionID.make(params.task_id)).catch(() => {})
          if (found) return found
        }

        return await Session.create({
          parentID: ctx.sessionID,
          title:
            params.description +
            ` (@${agent.name} subagent)` +
            (linked ? ` [${linked.parentTeam}/${linked.parentMember}]` : ""),
          permission: [
            {
              permission: "todowrite",
              pattern: "*",
              action: "deny",
            },
            {
              permission: "todoread",
              pattern: "*",
              action: "deny",
            },
            ...tools.map((t) => ({
              permission: t,
              pattern: "*",
              action: "deny" as const,
            })),
            ...(allowPad
              ? [
                  {
                    permission: "team_notepad",
                    pattern: "read",
                    action: "allow" as const,
                  },
                  {
                    permission: "team_notepad",
                    pattern: "list",
                    action: "allow" as const,
                  },
                  {
                    permission: "team_notepad",
                    pattern: "write",
                    action: "deny" as const,
                  },
                  {
                    permission: "team_notepad",
                    pattern: "delete",
                    action: "deny" as const,
                  },
                ]
              : []),
            ...(hasTaskPermission
              ? []
              : [
                  {
                    permission: "task" as const,
                    pattern: "*" as const,
                    action: "deny" as const,
                  },
                ]),
            ...(config.experimental?.primary_tools?.map((t) => ({
              pattern: "*",
              action: "allow" as const,
              permission: t,
            })) ?? []),
          ],
        })
      })
      if (linked) {
        await Team.setTrace(session.id, linked)
      }
      const msg = await MessageV2.get({ sessionID: ctx.sessionID, messageID: ctx.messageID })
      if (msg.info.role !== "assistant") throw new Error("Not an assistant message")

      const model = agent.model ?? {
        modelID: msg.info.modelID,
        providerID: msg.info.providerID,
      }

      ctx.metadata({
        title: params.description,
        metadata: {
          sessionId: session.id,
          model,
        },
      })

      const messageID = MessageID.ascending()

      function cancel() {
        void SessionPrompt.cancel(session.id).catch((error) => {
          log.warn("task child cancel failed", {
            sessionID: session.id,
            error: error instanceof Error ? error.message : String(error),
          })
        })
      }
      ctx.abort.addEventListener("abort", cancel)
      using _ = defer(() => ctx.abort.removeEventListener("abort", cancel))
      const prompt = allowPad
        ? [
            `You are working for teammate "${linked!.parentMember}" in team "${linked!.parentTeam}".`,
            "You cannot message the team directly.",
            "You may use team_notepad only in read/list mode for team context.",
            params.prompt,
          ].join("\n\n")
        : params.prompt
      const promptParts = await SessionPrompt.resolvePromptParts(prompt)

      const result = await SessionPrompt.prompt({
        messageID,
        sessionID: session.id,
        model: {
          modelID: model.modelID,
          providerID: model.providerID,
        },
        agent: agent.name,
        tools: {
          todowrite: false,
          todoread: false,
          ...Object.fromEntries(tools.map((t) => [t, false])),
          ...(hasTaskPermission ? {} : { task: false }),
          ...Object.fromEntries((config.experimental?.primary_tools ?? []).map((t) => [t, false])),
        },
        parts: promptParts,
      })

      const text = result.parts.findLast((x) => x.type === "text")?.text ?? ""

      const output = [
        `task_id: ${session.id} (for resuming to continue this task if needed)`,
        "",
        "<task_result>",
        text,
        "</task_result>",
      ].join("\n")

      return {
        title: params.description,
        metadata: {
          sessionId: session.id,
          model,
        },
        output,
      }
    },
  }
})
