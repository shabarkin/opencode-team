import * as Log from "@opencode-ai/core/util/log"
import { Effect } from "effect"
import { Bus } from "../bus"
import { MessageV2 } from "../session/message-v2"
import { SessionPrompt, SessionStatus } from "./runtime"
import { SessionID, MessageID, PartID } from "../session/schema"
import { Team, TeamEvent } from "./index"
import { Inbox, type InboxMessage } from "./inbox"
import { TeamPolicy } from "./policy"
import type { MessagePriority, MessageType } from "./events"

const log = Log.create({ service: "team.messaging" })
const MAX_TEXT = 10 * 1024
const TEAM_MESSAGE = true
const RETRY = 3
const RETRY_MS = 50

function closing(status?: string) {
  return status === "shutdown" || status === "shutdown_requested"
}

function validateText(text: string) {
  if (text.length <= MAX_TEXT) return
  throw new Error(`Team message too large (${text.length} chars). Maximum is ${MAX_TEXT} chars.`)
}

function messageId(): string {
  return `im_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

function sessionMessageId(id: string) {
  return MessageID.make(`msg_${id}`)
}

function sessionPartId(id: string) {
  return PartID.make(`prt_${id}`)
}

function refs() {
  return {
    sessionMessageID: MessageID.ascending(),
    sessionPartID: PartID.ascending(),
  }
}

function priorityText(text: string, priority?: MessagePriority) {
  if (priority !== "urgent") return text
  if (text.startsWith("[URGENT]")) return text
  return `[URGENT] ${text}`
}

function queue(status?: string, priority?: MessagePriority) {
  if (status === "paused") return true
  return status === "busy" && priority === "low"
}

function shouldInject(type?: MessageType, priority?: MessagePriority) {
  if (type === "system" && priority === "low") return false
  return true
}

function completionStatus(metadata?: Record<string, unknown>) {
  return typeof metadata?.completionStatus === "string"
}

function shouldDeliverSession(
  team: NonNullable<Awaited<ReturnType<typeof Team.get>>>,
  input: { to: string; metadata?: Record<string, unknown> },
) {
  if (input.to !== "lead") return true
  if (!team.delivered) return true
  return !completionStatus(input.metadata)
}

function threadId(input: { threadId?: string; replyTo?: string }, id: string) {
  return input.threadId ?? input.replyTo ?? id
}

export namespace TeamMessaging {
  async function deliver(teamName: string, to: string, sessionID: string, from: string, message: InboxMessage) {
    let err: unknown
    for (const attempt of [0, 1, 2]) {
      try {
        await injectMessage(sessionID, from, message)
        return
      } catch (next) {
        err = next
        if (attempt === RETRY - 1) break
        const wait = RETRY_MS * 2 ** attempt
        log.warn("message inject failed, retrying", {
          sessionID,
          from,
          inboxMessageId: message.id,
          attempt: attempt + 1,
          wait,
          error: next instanceof Error ? next.message : String(next),
        })
        await Bun.sleep(wait)
      }
    }
    await Bus.publish(TeamEvent.MessageUndelivered, {
      teamName,
      from,
      to,
      messageID: message.id,
      error: err instanceof Error ? err.message : String(err),
    })
    throw err
  }

  /**
   * Send a message from one team member to another.
   * Writes to the recipient's inbox (source of truth), then injects
   * a synthetic user message into their session (delivery mechanism),
   * then auto-wakes if idle.
   */
  export async function send(input: {
    teamName: string
    from: string
    to: string
    text: string
    type?: MessageType
    priority?: MessagePriority
    threadId?: string
    replyTo?: string
    metadata?: Record<string, unknown>
  }): Promise<void> {
    const policy = await TeamPolicy.messageSending(input)
    if (!policy.allow) throw new Error(policy.reason ?? `Message to "${input.to}" was denied by team policy.`)
    const text = priorityText(policy.text, input.priority)
    validateText(text)
    const team = await Team.get(input.teamName)
    if (!team) throw new Error(`Team "${input.teamName}" not found`)

    // Find recipient session
    let targetSessionID: string | undefined
    let paused = false
    if (input.to === "lead") {
      targetSessionID = team.leadSessionID
    } else {
      const member = team.members.find((m) => m.name === input.to)
      if (!member) throw new Error(`Member "${input.to}" not found in team "${input.teamName}"`)
      if (member.status === "shutdown") throw new Error(`Member "${input.to}" has shut down`)
      targetSessionID = member.sessionID
      paused = member.status === "paused"
    }

    if (!targetSessionID) throw new Error(`Could not find session for "${input.to}"`)

    // Write to inbox (source of truth)
    const inboxId = messageId()
    const status = paused ? "paused" : team.members.find((m) => m.name === input.to)?.status
    const next: Omit<InboxMessage, "read"> = {
      id: inboxId,
      from: input.from,
      text,
      timestamp: Date.now(),
      type: input.type,
      priority: input.priority,
      threadId: threadId(input, inboxId),
      replyTo: input.replyTo,
      ...refs(),
      metadata: input.metadata,
    }
    await Inbox.write(input.teamName, input.to, {
      ...next,
    })

    if (input.priority === "urgent" && status === "busy") {
      await Team.cancelMember(input.teamName, input.to).catch(() => false)
    }

    const deliverable =
      !queue(status, input.priority) && shouldInject(input.type, input.priority) && shouldDeliverSession(team, input)
    if (deliverable) {
      await deliver(input.teamName, input.to, targetSessionID, input.from, { ...next, read: false })
    }

    log.info("message sent", { teamName: input.teamName, from: input.from, to: input.to })
    await Bus.publish(TeamEvent.Message, {
      teamName: input.teamName,
      from: input.from,
      to: input.to,
      text,
      type: input.type,
      priority: input.priority,
      threadId: next.threadId,
      replyTo: input.replyTo,
    })

    // Auto-wake: if the recipient session is idle, start its prompt loop
    // so the LLM processes the injected message.
    if (deliverable) wake(targetSessionID, input.from)
  }

  /**
   * Broadcast a message from one member to all other members.
   */
  export async function broadcast(input: {
    teamName: string
    from: string
    text: string
    type?: MessageType
    priority?: MessagePriority
    threadId?: string
    targets?: string[]
  }): Promise<{ targets: number; delivered: number; errors: Array<{ target: string; error: string }> }> {
    validateText(priorityText(input.text, input.priority))
    const team = await Team.get(input.teamName)
    if (!team) throw new Error(`Team "${input.teamName}" not found`)

    // Send to all active members except the sender
    const memberTargets = team.members
      .filter((m) => m.name !== input.from && m.status !== "shutdown")
      .filter((m) => input.targets === undefined || input.targets.includes(m.name))
      .map((m) => ({ name: m.name, sessionID: m.sessionID }))

    const targets =
      input.from !== "lead" && team.leadSessionID && (input.targets === undefined || input.targets.includes("lead"))
        ? [{ name: "lead", sessionID: team.leadSessionID }, ...memberTargets]
        : memberTargets

    const root = input.threadId ?? messageId()
    const errors = (
      await Promise.all(
        targets.map(async (target) => {
          try {
            await send({
              teamName: input.teamName,
              from: input.from,
              to: target.name,
              text: input.text,
              type: input.type,
              priority: input.priority,
              threadId: root,
            })
            return undefined
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            log.warn("broadcast delivery failed", { target: target.name, error: msg })
            return { target: target.name, error: msg }
          }
        }),
      )
    ).filter((item): item is { target: string; error: string } => !!item)

    const delivered = targets.length - errors.length
    log.info("broadcast sent", {
      teamName: input.teamName,
      from: input.from,
      targets: targets.length,
      delivered,
      errors: errors.length,
    })
    if (errors.length > 0) log.warn("broadcast partial failure", { teamName: input.teamName, errors })

    await Bus.publish(TeamEvent.Broadcast, {
      teamName: input.teamName,
      from: input.from,
      text: input.text,
      type: input.type,
      priority: input.priority,
      threadId: root,
    })
    return { targets: targets.length, delivered, errors }
  }

  /**
   * Mark all messages as read in an agent's inbox, then send
   * delivery receipts back to each sender. Receipts are batched
   * per sender and flow through the same inbox + inject + auto-wake
   * path as regular team messages.
   */
  export async function markRead(teamName: string, agentName: string): Promise<number> {
    const read = await Inbox.markRead(teamName, agentName)
    if (read.length === 0) return 0

    const team = await Team.get(teamName)
    if (!team) return read.length
    if (!team.receipts) return read.length

    // Group by sender for batched receipts
    const bySender = new Map<string, number>()
    for (const msg of read) {
      bySender.set(msg.from, (bySender.get(msg.from) ?? 0) + 1)
    }

    // Send a receipt to each distinct sender
    if (team) {
      for (const [sender, count] of bySender) {
        // Find sender's session
        let senderSessionID: string | undefined
        if (sender === "lead") {
          senderSessionID = team.leadSessionID
        } else {
          const member = team.members.find((m) => m.name === sender)
          if (member && !closing(member.status)) senderSessionID = member.sessionID
        }
        if (!senderSessionID) continue

        const text = count === 1 ? `${agentName} has read your message` : `${agentName} has read your ${count} messages`

        const receiptId = messageId()
        await Inbox.write(teamName, sender, {
          id: receiptId,
          from: agentName,
          text: `[receipt] ${text}`,
          timestamp: Date.now(),
          type: "system",
          priority: "low",
          threadId: receiptId,
          ...refs(),
        }).catch((err: unknown) => {
          log.warn("receipt inbox write failed", {
            teamName,
            sender,
            error: err instanceof Error ? err.message : String(err),
          })
        })

        const senderMember = team.members.find((item) => item.name === sender)
        if (senderMember?.status !== "paused" && shouldInject("system", "low")) {
          await deliver(teamName, sender, senderSessionID, agentName, {
            id: receiptId,
            from: agentName,
            text: `[receipt] ${text}`,
            timestamp: Date.now(),
            read: false,
            type: "system",
            priority: "low",
            threadId: receiptId,
            ...refs(),
          }).catch((err: unknown) => {
            log.warn("receipt inject failed", {
              teamName,
              sender,
              error: err instanceof Error ? err.message : String(err),
            })
          })

          wake(senderSessionID, agentName)
        }
      }
      log.info("delivery receipts sent", { teamName, from: agentName, senders: [...bySender.keys()] })
    }

    return read.length
  }

  /**
   * Reinject unread inbox messages that were never delivered to the session.
   * Deduplicates by inboxMessageId stored in part metadata.
   * Returns the number of messages reinjected.
   */
  export async function recoverInbox(teamName: string, agentName: string, sessionID: string): Promise<number> {
    const pending = await Inbox.unread(teamName, agentName)
    if (pending.length === 0) return 0

    const delivered = new Set<string>()
    const ids = new Set(pending.map((msg) => msg.id))
    let before: string | undefined
    while (true) {
      const page = await Effect.runPromise(MessageV2.page({ sessionID: SessionID.make(sessionID), limit: 50, before }))
      for (const msg of page.items) {
        for (const part of msg.parts) {
          const meta = (part as { metadata?: Record<string, unknown> }).metadata
          const id = typeof meta?.inboxMessageId === "string" ? meta.inboxMessageId : undefined
          if (!id || !ids.has(id)) continue
          delivered.add(id)
        }
      }
      if (delivered.size === ids.size) break
      if (!page.more || !page.cursor) break
      before = page.cursor
    }

    const team = await Team.get(teamName)
    let count = 0
    for (const msg of pending) {
      if (delivered.has(msg.id)) continue
      if (agentName === "lead" && team?.delivered && completionStatus(msg.metadata)) continue
      await deliver(teamName, agentName, sessionID, msg.from, msg)
      count++
    }

    if (count > 0)
      log.info("inbox recovery", { teamName, agentName, reinjected: count, skipped: pending.length - count })
    return count
  }

  export async function flush(teamName: string, agentName: string): Promise<number> {
    const team = await Team.get(teamName)
    if (!team) return 0
    const sessionID =
      agentName === "lead" ? team.leadSessionID : team.members.find((m) => m.name === agentName)?.sessionID
    if (!sessionID) return 0
    const count = await recoverInbox(teamName, agentName, sessionID)
    if (count > 0) wake(sessionID, "system")
    return count
  }

  export async function wake(sessionID: string, from: string) {
    return autoWake(sessionID, from)
  }

  /**
   * Auto-wake an idle session after a team message is injected.
   * If the session is idle (no active prompt loop), starts a new loop
   * so the LLM picks up and processes the injected message.
   */
  async function autoWake(sessionID: string, from: string) {
    try {
      const status = await SessionStatus.get(SessionID.make(sessionID))
      if (status.type !== "idle") return
      // Don't wake a teammate that's fully shut down.
      // We DO wake for shutdown_requested — the teammate needs to process
      // the shutdown message and wrap up. The .then() handler below
      // transitions shutdown_requested → shutdown when the loop ends.
      const info = await Team.findBySession(sessionID)
      if (info && info.role === "member") {
        const member = info.team.members.find((m) => m.name === info.memberName)
        if (member?.status === "shutdown" || member?.status === "paused") return
        if (member?.status !== "busy" && member?.status !== "shutdown_requested") {
          await Team.transitionMemberStatus(info.team.name, info.memberName!, "busy", { force: true })
        }
        await Team.transitionExecutionStatus(info.team.name, info.memberName!, "starting", { force: true })
        await Team.transitionExecutionStatus(info.team.name, info.memberName!, "running", { force: true })
      }
      log.info("auto-waking idle session", { sessionID, from })
      SessionPrompt.loop({ sessionID: SessionID.make(sessionID) })
        .then(async () => {
          const match = await Team.findBySession(sessionID)
          if (!match || match.role !== "member") return
          await Team.transitionExecutionStatus(match.team.name, match.memberName!, "completing", { force: true })
          await Team.transitionExecutionStatus(match.team.name, match.memberName!, "completed", { force: true })
          await Team.transitionExecutionStatus(match.team.name, match.memberName!, "idle", { force: true })
          const team = await Team.get(match.team.name)
          const member = team?.members.find((m) => m.name === match.memberName)
          if (member?.status === "shutdown_requested") {
            await Team.transitionMemberStatus(match.team.name, match.memberName!, "shutdown")
            log.info("auto-wake loop completed shutdown", { teamName: match.team.name, name: match.memberName })
            return
          }
          if (member?.status === "paused") return
          if (member?.status === "busy") {
            await Team.transitionMemberStatus(match.team.name, match.memberName!, "ready", { force: true })
          }
        })
        .catch(async (err: unknown) => {
          const message = err instanceof Error ? err.message : String(err)
          const match = await Team.findBySession(sessionID)
          if (match && match.role === "member") {
            await Team.transitionExecutionStatus(match.team.name, match.memberName!, "failed", { force: true })
            await Team.transitionExecutionStatus(match.team.name, match.memberName!, "idle", { force: true })
            await Team.transitionMemberStatus(match.team.name, match.memberName!, "error", { force: true })
          }
          log.warn("auto-wake loop failed", { sessionID, error: message })
        })
    } catch (err) {
      log.warn("auto-wake failed", { sessionID, error: err instanceof Error ? (err as Error).message : String(err) })
    }
  }

  /**
   * Inject a synthetic user message into a session from a teammate.
   * This is how teammates "receive" messages — as user messages
   * with a TeamMessagePart that the prompt loop will process.
   */
  async function injectMessage(
    sessionID: string,
    fromName: string,
    message: Pick<
      InboxMessage,
      | "id"
      | "text"
      | "timestamp"
      | "type"
      | "priority"
      | "threadId"
      | "replyTo"
      | "sessionMessageID"
      | "sessionPartID"
      | "metadata"
    >,
  ): Promise<void> {
    await SessionPrompt.inject({
      sessionID: SessionID.make(sessionID),
      text: `[Team ${message.type ?? "message"} from ${fromName}]: ${message.text}`,
      created: message.timestamp,
      messageID: message.sessionMessageID ?? sessionMessageId(message.id),
      partID: message.sessionPartID ?? sessionPartId(message.id),
      metadata: {
        teamMessage: TEAM_MESSAGE,
        teamFrom: fromName,
        inboxMessageId: message.id,
        ...(message.type ? { teamType: message.type } : {}),
        ...(message.priority ? { teamPriority: message.priority } : {}),
        ...(message.threadId ? { threadId: message.threadId } : {}),
        ...(message.replyTo ? { replyTo: message.replyTo } : {}),
        ...(message.metadata ? { teamMetadata: message.metadata } : {}),
      },
    })
  }
}
