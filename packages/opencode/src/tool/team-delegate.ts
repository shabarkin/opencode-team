import z from "zod"
import { Tool } from "./tool"
import { Agent } from "../agent/agent"
import { Config } from "../config/config"
import { MessageV2 } from "../session/message-v2"
import { Session } from "../session"
import { SessionPrompt } from "../session/prompt"
import { MessageID } from "../session/schema"
import { Team } from "../team"
import { TeamMessaging } from "../team/messaging"
import { TEAM_TOOL_IDS } from "./team-ids"
import { TeamNotepad } from "../team/notepad"
import { defer } from "@/util/defer"
import { iife } from "@/util/iife"
import { Log } from "@/util/log"

const log = Log.create({ service: "tool.team-delegate" })

const parameters = z.object({
  description: z.string().describe("A short (3-5 words) description of the delegated task"),
  prompt: z.string().describe("The task for the delegated agent to perform"),
  agent: z.string().describe("The agent type to use for this delegated task"),
  post_to_lead: z
    .boolean()
    .optional()
    .describe("If true, post a short summary of the delegated result to the lead after it finishes"),
})

export const TeamDelegateTool = Tool.define("team_delegate", async () => {
  const agents = await Agent.list().then((list) =>
    list.filter((item) => item.mode !== "primary" && item.hidden !== true),
  )
  const names = agents.map((item) => item.name).sort()

  return {
    description:
      "Run a lightweight delegated subagent for a teammate without adding a new team member. " +
      `Available agent types: ${names.join(", ")}. ` +
      "The delegate does not join the team, has no inbox, and returns its result only to the calling teammate.",
    parameters,
    async execute(params, ctx): Promise<{ title: string; output: string; metadata: Record<string, any> }> {
      const info = await Team.findBySession(ctx.sessionID)
      if (!info || info.role !== "member" || !info.memberName) {
        return {
          title: "Error",
          output: "Only teammates can use team_delegate.",
          metadata: {},
        }
      }

      const agent = await Agent.get(params.agent)
      if (!agent || agent.mode === "primary" || agent.hidden === true) {
        return {
          title: "Error",
          output: `Unknown agent type: ${params.agent}`,
          metadata: {},
        }
      }

      const config = await Config.get()
      const hasTask = agent.permission.some((rule) => rule.permission === "task")
      const note = await TeamNotepad.context(info.team.name).catch(() => "")
      const session = await iife(async () => {
        return Session.create({
          parentID: ctx.sessionID,
          title: `${params.description} (@${agent.name} delegate) [${info.team.name}/${info.memberName}]`,
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
            ...TEAM_TOOL_IDS.map((tool) => ({
              permission: tool,
              pattern: "*",
              action: "deny" as const,
            })),
            ...(hasTask
              ? []
              : [
                  {
                    permission: "task" as const,
                    pattern: "*" as const,
                    action: "deny" as const,
                  },
                ]),
            ...(config.experimental?.primary_tools?.map((tool) => ({
              pattern: "*",
              action: "allow" as const,
              permission: tool,
            })) ?? []),
          ],
        })
      })
      await Team.setTrace(session.id, {
        parentTeam: info.team.name,
        parentMember: info.memberName,
        mode: "delegate",
      })
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

      const prompt = [
        `You are a delegated subagent working for teammate "${info.memberName}" in team "${info.team.name}".`,
        "You are NOT a team member. You cannot message the team, claim tasks, or use team tools.",
        "Your result is returned only to the calling teammate.",
        note ? `Read-only team notepad context:\n${note}` : "",
        params.prompt,
      ]
        .filter(Boolean)
        .join("\n\n")

      const messageID = MessageID.ascending()
      function cancel() {
        void SessionPrompt.cancel(session.id).catch((error) => {
          log.warn("delegate child cancel failed", {
            sessionID: session.id,
            error: error instanceof Error ? error.message : String(error),
          })
        })
      }
      ctx.abort.addEventListener("abort", cancel)
      using _ = defer(() => ctx.abort.removeEventListener("abort", cancel))

      const parts = await SessionPrompt.resolvePromptParts(prompt)
      await Team.bumpDelegations(info.team.name, info.memberName, 1)
      try {
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
            ...Object.fromEntries(TEAM_TOOL_IDS.map((tool) => [tool, false])),
            ...(hasTask ? {} : { task: false }),
            ...Object.fromEntries((config.experimental?.primary_tools ?? []).map((tool) => [tool, false])),
          },
          parts,
        })

        const text = result.parts.findLast((part) => part.type === "text")?.text ?? ""
        if (params.post_to_lead && text) {
          await TeamMessaging.send({
            teamName: info.team.name,
            from: info.memberName,
            to: "lead",
            text,
            type: "result",
            priority: "normal",
          }).catch(() => {})
        }

        return {
          title: params.description,
          metadata: {
            sessionId: session.id,
            model,
          },
          output: [`task_id: ${session.id}`, "", "<delegate_result>", text, "</delegate_result>"].join("\n"),
        }
      } finally {
        await Team.bumpDelegations(info.team.name, info.memberName, -1)
      }
    },
  }
})
