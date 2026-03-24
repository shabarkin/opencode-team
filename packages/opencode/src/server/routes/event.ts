import { Hono } from "hono"
import { describeRoute, resolver } from "hono-openapi"
import { streamSSE } from "hono/streaming"
import { Log } from "@/util/log"
import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { lazy } from "../../util/lazy"
import { AsyncQueue } from "../../util/queue"
import { Instance } from "@/project/instance"

const log = Log.create({ service: "server" })

export function redact(event: { type: string; properties: Record<string, unknown> }) {
  if (!event.type.startsWith("team.")) return event

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
    case "team.cleaned":
      return {
        type: event.type,
        properties: { teamName: event.properties.teamName, delegate: event.properties.delegate },
      }
    case "team.file.conflict":
      return { type: event.type, properties: { teamName: event.properties.teamName } }
    default:
      return event
  }
}

export const EventRoutes = lazy(() =>
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
              schema: resolver(BusEvent.payloads()),
            },
          },
        },
      },
    }),
    async (c) => {
      log.info("event connected")
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

        const unsub = Bus.subscribeAll((event) => {
          q.push(JSON.stringify(redact(event)))
          if (event.type === Bus.InstanceDisposed.type) {
            stop()
          }
        })

        const stop = () => {
          if (done) return
          done = true
          clearInterval(heartbeat)
          unsub()
          q.push(null)
          log.info("event disconnected")
        }

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
  ),
)
