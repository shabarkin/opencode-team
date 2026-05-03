import z from "zod"
import { Hono } from "hono"
import { describeRoute, resolver } from "hono-openapi"
import { streamSSE } from "hono/streaming"
import * as Log from "@opencode-ai/core/util/log"
import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { AsyncQueue } from "@/util/queue"

const log = Log.create({ service: "server" })

export function redact(event: { type: string; properties: Record<string, unknown> }) {
  if (!event.type.startsWith("team.")) return event

  const teamName = typeof event.properties.teamName === "string" ? event.properties.teamName : undefined

  switch (event.type) {
    case "team.created": {
      const team = event.properties.team as { name?: string; members?: unknown[]; delegate?: boolean } | undefined
      return {
        type: event.type,
        properties: {
          teamName: team?.name,
          members: team?.members?.length ?? 0,
          delegate: !!team?.delegate,
        },
      }
    }
    case "team.member.spawned": {
      const member = event.properties.member as { name?: string; agent?: string; status?: string } | undefined
      return {
        type: event.type,
        properties: {
          teamName: event.properties.teamName,
          memberName: member?.name,
          agent: member?.agent,
          status: member?.status,
        },
      }
    }
    case "team.message":
      return {
        type: event.type,
        properties: { teamName: event.properties.teamName, from: event.properties.from, to: event.properties.to },
      }
    case "team.broadcast":
      return { type: event.type, properties: { teamName: event.properties.teamName, from: event.properties.from } }
    case "team.task.updated": {
      const tasks = event.properties.tasks as unknown[] | undefined
      return { type: event.type, properties: { teamName: event.properties.teamName, count: tasks?.length ?? 0 } }
    }
    case "team.plan.approval":
      return {
        type: event.type,
        properties: {
          teamName: event.properties.teamName,
          memberName: event.properties.memberName,
          approved: event.properties.approved,
        },
      }
    case "team.spawn.requested": {
      const request = event.properties.request as { id?: string; requested_by?: string; agent?: string } | undefined
      return {
        type: event.type,
        properties: {
          teamName: event.properties.teamName,
          requestID: request?.id,
          requestedBy: request?.requested_by,
          agent: request?.agent,
        },
      }
    }
    case "team.cleaned":
      return {
        type: event.type,
        properties: { teamName: event.properties.teamName, delegate: event.properties.delegate },
      }
    case "team.file.conflict":
      return { type: event.type, properties: { teamName: event.properties.teamName } }
    case "team.member.status":
    case "team.member.execution":
      return {
        type: event.type,
        properties: {
          teamName,
          memberName: event.properties.memberName,
          status: event.properties.status,
        },
      }
    case "team.task.claimed":
      return {
        type: event.type,
        properties: {
          teamName,
          taskId: event.properties.taskId,
          memberName: event.properties.memberName,
        },
      }
    case "team.shutdown.request":
      return {
        type: event.type,
        properties: {
          teamName,
          memberName: event.properties.memberName,
        },
      }
    case "team.result.submitted": {
      const result = event.properties.result as { title?: string; status?: string } | undefined
      return {
        type: event.type,
        properties: {
          teamName,
          memberName: event.properties.memberName,
          title: result?.title,
          status: result?.status,
          taskId: event.properties.taskId,
        },
      }
    }
    case "team.message.undelivered":
      return {
        type: event.type,
        properties: {
          teamName,
          from: event.properties.from,
          to: event.properties.to,
          messageID: event.properties.messageID,
        },
      }
    case "team.message.read":
      return {
        type: event.type,
        properties: {
          teamName,
          agentName: event.properties.agentName,
          count: event.properties.count,
        },
      }
    case "team.all-members-shutdown":
      return {
        type: event.type,
        properties: {
          teamName,
          grace: event.properties.grace,
          cleanupAt: event.properties.cleanupAt,
        },
      }
    case "team.member.timeout":
      return {
        type: event.type,
        properties: {
          teamName,
          memberName: event.properties.memberName,
          elapsed: event.properties.elapsed,
          limit: event.properties.limit,
        },
      }
    case "team.inbox.pruned":
      return {
        type: event.type,
        properties: {
          teamName,
          agentName: event.properties.agentName,
          removed: event.properties.removed,
        },
      }
    case "team.phase.changed":
      return {
        type: event.type,
        properties: {
          teamName,
          phase: event.properties.phase,
          previous: event.properties.previous,
        },
      }
    default:
      return {
        type: event.type,
        properties: teamName ? { teamName } : {},
      }
  }
}

export const EventRoutes = () =>
  new Hono().get(
    "/event",
    describeRoute({
      summary: "Subscribe to events",
      description: "Get events",
      operationId: "event.subscribe",
      responses: {
        200: {
          description: "Event stream",
          content: {
            "text/event-stream": {
              schema: resolver(
                z.union(BusEvent.payloads()).meta({
                  ref: "Event",
                }),
              ),
            },
          },
        },
      },
    }),
    async (c) => {
      log.info("event connected")
      c.header("Cache-Control", "no-cache, no-transform")
      c.header("X-Accel-Buffering", "no")
      c.header("X-Content-Type-Options", "nosniff")
      return streamSSE(c, async (stream) => {
        const q = new AsyncQueue<string | null>()
        let done = false

        q.push(
          JSON.stringify({
            type: "server.connected",
            properties: {},
          }),
        )

        // Send heartbeat every 10s to prevent stalled proxy streams.
        const heartbeat = setInterval(() => {
          q.push(
            JSON.stringify({
              type: "server.heartbeat",
              properties: {},
            }),
          )
        }, 10_000)

        const stop = () => {
          if (done) return
          done = true
          clearInterval(heartbeat)
          unsub()
          q.push(null)
          log.info("event disconnected")
        }

        const unsub = Bus.subscribeAll((event) => {
          q.push(JSON.stringify(redact(event)))
          if (event.type === Bus.InstanceDisposed.type) {
            stop()
          }
        })

        stream.onAbort(stop)

        try {
          for await (const data of q) {
            if (data === null) return
            await stream.writeSSE({ data })
          }
        } finally {
          stop()
        }
      })
    },
  )
