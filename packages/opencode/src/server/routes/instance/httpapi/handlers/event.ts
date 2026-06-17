import { EventV2Bridge } from "@/event-v2-bridge"
import { InstanceState } from "@/effect/instance-state"
import { GlobalBus } from "@/bus/global"
import { EventV2 } from "@opencode-ai/core/event"
import { Effect, Queue } from "effect"
import * as Stream from "effect/Stream"
import { HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import * as Sse from "effect/unstable/encoding/Sse"
import { EventApi } from "../groups/event"

export function redact(event: { id?: string; type: string; properties: Record<string, unknown> }) {
  if (!event.type.startsWith("team.")) return event

  const teamName = typeof event.properties.teamName === "string" ? event.properties.teamName : undefined
  const base = { id: event.id, type: event.type }

  switch (event.type) {
    case "team.created": {
      const team = event.properties.team as { name?: string; members?: unknown[]; delegate?: boolean } | undefined
      return {
        ...base,
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
        ...base,
        properties: {
          teamName: event.properties.teamName,
          memberName: member?.name,
          agent: member?.agent,
          status: member?.status,
        },
      }
    }
    case "team.message":
      return { ...base, properties: { teamName, from: event.properties.from, to: event.properties.to } }
    case "team.broadcast":
      return { ...base, properties: { teamName, from: event.properties.from } }
    case "team.task.updated": {
      const tasks = event.properties.tasks as unknown[] | undefined
      return { ...base, properties: { teamName, count: tasks?.length ?? 0 } }
    }
    case "team.plan.approval":
      return {
        ...base,
        properties: {
          teamName,
          memberName: event.properties.memberName,
          approved: event.properties.approved,
        },
      }
    case "team.spawn.requested": {
      const request = event.properties.request as { id?: string; requested_by?: string; agent?: string } | undefined
      return {
        ...base,
        properties: {
          teamName,
          requestID: request?.id,
          requestedBy: request?.requested_by,
          agent: request?.agent,
        },
      }
    }
    case "team.cleaned":
      return { ...base, properties: { teamName, delegate: event.properties.delegate } }
    case "team.file.conflict":
      return { ...base, properties: { teamName } }
    case "team.member.status":
    case "team.member.execution":
      return { ...base, properties: { teamName, memberName: event.properties.memberName, status: event.properties.status } }
    case "team.task.claimed":
      return { ...base, properties: { teamName, taskId: event.properties.taskId, memberName: event.properties.memberName } }
    case "team.shutdown.request":
      return { ...base, properties: { teamName, memberName: event.properties.memberName } }
    case "team.result.submitted": {
      const result = event.properties.result as { title?: string; status?: string } | undefined
      return {
        ...base,
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
        ...base,
        properties: {
          teamName,
          from: event.properties.from,
          to: event.properties.to,
          messageID: event.properties.messageID,
        },
      }
    case "team.message.read":
      return { ...base, properties: { teamName, agentName: event.properties.agentName, count: event.properties.count } }
    case "team.all-members-shutdown":
      return { ...base, properties: { teamName, grace: event.properties.grace, cleanupAt: event.properties.cleanupAt } }
    case "team.member.timeout":
      return {
        ...base,
        properties: {
          teamName,
          memberName: event.properties.memberName,
          elapsed: event.properties.elapsed,
          limit: event.properties.limit,
        },
      }
    case "team.inbox.pruned":
      return { ...base, properties: { teamName, agentName: event.properties.agentName, removed: event.properties.removed } }
    case "team.phase.changed":
      return { ...base, properties: { teamName, phase: event.properties.phase, previous: event.properties.previous } }
    default:
      return { ...base, properties: teamName ? { teamName } : {} }
  }
}

function eventData(data: unknown): Sse.Event {
  return {
    _tag: "Event",
    event: "message",
    id: undefined,
    data: JSON.stringify(redact(data as { id?: string; type: string; properties: Record<string, unknown> })),
  }
}

function eventID() {
  return EventV2.ID.create()
}

function eventResponse(events: EventV2.Interface) {
  return Effect.gen(function* () {
    const instance = yield* InstanceState.context
    const workspaceID = yield* InstanceState.workspaceID
    // Listener registration is eager, so events published after this point cannot
    // be lost while the HTTP body fiber is starting or emitting server.connected.
    const queue = yield* Queue.unbounded<EventV2.Payload>()
    const unsubscribe = yield* events.listen((event) => Effect.sync(() => Queue.offerUnsafe(queue, event)))
    yield* Effect.addFinalizer(() => unsubscribe)
    const stream = Stream.fromQueue(queue).pipe(
      Stream.filter(
        (event) =>
          event.location?.directory === instance.directory &&
          (event.location.workspaceID === undefined || event.location.workspaceID === workspaceID),
      ),
      Stream.map((event) => ({ id: event.id, type: event.type, properties: event.data })),
    )
    const disposed = Stream.callback<{ id: string; type: string; properties: unknown }>((queue) => {
      const listener = (event: {
        directory?: string
        payload: { id?: string; type?: string; properties?: unknown }
      }) => {
        if (event.directory !== instance.directory || event.payload.type !== "server.instance.disposed") return
        Queue.offerUnsafe(queue, {
          id: event.payload.id ?? eventID(),
          type: "server.instance.disposed",
          properties: event.payload.properties ?? {},
        })
      }
      return Effect.acquireRelease(
        Effect.sync(() => GlobalBus.on("event", listener)),
        () => Effect.sync(() => GlobalBus.off("event", listener)),
      )
    })
    const output = stream.pipe(
      Stream.merge(disposed, { haltStrategy: "left" }),
      Stream.takeUntil((event) => event.type === "server.instance.disposed"),
    )
    const heartbeat = Stream.tick("10 seconds").pipe(
      Stream.drop(1),
      Stream.map(() => ({ id: eventID(), type: "server.heartbeat", properties: {} })),
    )

    yield* Effect.logInfo("event connected")
    return HttpServerResponse.stream(
      Stream.make({ id: eventID(), type: "server.connected", properties: {} }).pipe(
        Stream.concat(output.pipe(Stream.merge(heartbeat, { haltStrategy: "left" }))),
        Stream.map(eventData),
        Stream.pipeThroughChannel(Sse.encode()),
        Stream.encodeText,
        Stream.ensuring(Effect.logInfo("event disconnected")),
      ),
      {
        contentType: "text/event-stream",
        headers: {
          "Cache-Control": "no-cache, no-transform",
          "X-Accel-Buffering": "no",
          "X-Content-Type-Options": "nosniff",
        },
      },
    )
  })
}

export const eventHandlers = HttpApiBuilder.group(EventApi, "event", (handlers) =>
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    return handlers.handleRaw(
      "subscribe",
      Effect.fn("EventHttpApi.subscribe")(function* () {
        return yield* eventResponse(events)
      }),
    )
  }),
)
