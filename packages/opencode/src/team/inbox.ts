import { Log } from "../util"
import { Lock } from "../util"
import { Global } from "../global"
import { Instance } from "../project/instance"
import { Bus } from "../bus"
import { TeamEvent } from "./events"
import {
  MessagePriority,
  MessageType,
  type MessagePriority as MessagePriorityType,
  type MessageType as MessageTypeType,
} from "./events"
import path from "path"
import fs from "fs/promises"
import z from "zod"

const log = Log.create({ service: "team.inbox" })

export interface InboxMessage {
  id: string
  from: string
  text: string
  timestamp: number
  read: boolean
  type?: MessageTypeType
  priority?: MessagePriorityType
  threadId?: string
  replyTo?: string
  sessionMessageID?: string
  sessionPartID?: string
  metadata?: Record<string, unknown>
}

const MessageSchema = z.object({
  id: z.string(),
  from: z.string(),
  text: z.string(),
  timestamp: z.number().finite(),
  read: z.boolean(),
  type: MessageType.optional(),
  priority: MessagePriority.optional(),
  threadId: z.string().optional(),
  replyTo: z.string().optional(),
  sessionMessageID: z.string().optional(),
  sessionPartID: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
})

/** Resolve the JSONL file path for an agent's inbox */
function filepath(teamName: string, agentName: string): string {
  return path.join(Global.Path.data, "storage", "team_inbox", Instance.project.id, teamName, agentName + ".jsonl")
}

function quarantinepath(teamName: string, agentName: string): string {
  return path.join(
    Global.Path.data,
    "storage",
    "team_inbox",
    Instance.project.id,
    teamName,
    agentName + ".quarantine.jsonl",
  )
}

function inspect(content: string) {
  const seen = new Set<string>()
  const invalid = [] as string[]
  const messages = content
    .split("\n")
    .filter((line) => line.trim())
    .flatMap((line) => {
      try {
        const parsed = MessageSchema.parse(JSON.parse(line))
        if (seen.has(parsed.id)) {
          invalid.push(line)
          return []
        }
        seen.add(parsed.id)
        return [parsed]
      } catch {
        invalid.push(line)
        return []
      }
    })
  return { messages, invalid }
}

function serialize(messages: InboxMessage[]) {
  if (messages.length === 0) return ""
  return messages.map((msg) => JSON.stringify(msg)).join("\n") + "\n"
}

const cache = new Map<string, { content: string; messages: InboxMessage[]; invalid: string[] }>()

function remember(target: string, content: string, parsed: { messages: InboxMessage[]; invalid: string[] }) {
  cache.set(target, { content, messages: parsed.messages, invalid: parsed.invalid })
  return parsed
}

function parsed(target: string, content: string) {
  const hit = cache.get(target)
  if (hit?.content === content) {
    return { messages: hit.messages, invalid: hit.invalid }
  }
  return remember(target, content, inspect(content))
}

async function repair(teamName: string, agentName: string, target: string, content: string) {
  const next = parsed(target, content)
  if (next.invalid.length === 0) return next
  const qpath = quarantinepath(teamName, agentName)
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.appendFile(qpath, next.invalid.join("\n") + "\n")
  const clean = serialize(next.messages)
  await Bun.write(target, clean)
  remember(target, clean, { messages: next.messages, invalid: [] })
  log.warn("inbox validated", {
    teamName,
    agentName,
    valid: next.messages.length,
    invalid: next.invalid.length,
  })
  return { messages: next.messages, invalid: [] }
}

export namespace Inbox {
  /**
   * Write a message to an agent's inbox.
   * Deduplicates by inbox message ID and self-heals malformed files before append.
   */
  export async function write(teamName: string, to: string, message: Omit<InboxMessage, "read">): Promise<void> {
    const target = filepath(teamName, to)
    using _ = await Lock.write(target)
    await fs.mkdir(path.dirname(target), { recursive: true })
    const content = await Bun.file(target)
      .text()
      .catch(() => "")
    const parsed = await repair(teamName, to, target, content)
    if (parsed.messages.some((item) => item.id === message.id)) {
      log.info("duplicate inbox write skipped", { teamName, to, from: message.from, id: message.id })
      return
    }
    const next = [...parsed.messages, { ...message, read: false }]
    const data = JSON.stringify({ ...message, read: false }) + "\n"
    await fs.appendFile(target, data)
    remember(target, content + data, { messages: next, invalid: [] })
    log.info("inbox write", { teamName, to, from: message.from, id: message.id })
  }

  export async function validate(teamName: string, agentName: string): Promise<{ valid: number; invalid: number }> {
    const target = filepath(teamName, agentName)
    using _ = await Lock.write(target)
    const content = await Bun.file(target)
      .text()
      .catch(() => "")
    const parsed = await repair(teamName, agentName, target, content)
    return { valid: parsed.messages.length, invalid: parsed.invalid.length }
  }

  /**
   * Read all unread messages from an agent's inbox.
   */
  export async function unread(teamName: string, agentName: string): Promise<InboxMessage[]> {
    const target = filepath(teamName, agentName)
    using _ = await Lock.read(target)
    const content = await Bun.file(target)
      .text()
      .catch(() => "")
    return parsed(target, content).messages.filter((m) => !m.read)
  }

  /**
   * Read all messages (read and unread) from an agent's inbox.
   */
  export async function all(teamName: string, agentName: string): Promise<InboxMessage[]> {
    const target = filepath(teamName, agentName)
    using _ = await Lock.read(target)
    const content = await Bun.file(target)
      .text()
      .catch(() => "")
    return parsed(target, content).messages
  }

  /**
   * Mark unread messages as read for an agent.
   * When ids are provided, only matching unread messages are updated.
   * Returns the newly-read messages so callers can send delivery receipts.
   * Publishes TeamEvent.MessageRead with the count.
   *
   * This is the only operation that rewrites the entire file.
   */
  export async function markRead(teamName: string, agentName: string, ids?: string[]): Promise<InboxMessage[]> {
    const target = filepath(teamName, agentName)
    using _ = await Lock.write(target)
    const content = await Bun.file(target)
      .text()
      .catch(() => "")
    const messages = (await repair(teamName, agentName, target, content)).messages
    const pick = ids?.length ? new Set(ids) : undefined
    const read = messages
      .filter((msg) => !msg.read)
      .filter((msg) => (pick ? pick.has(msg.id) : true))
      .map((msg) => ({ ...msg, read: true }))
    if (read.length === 0) return []
    const seen = new Set(read.map((msg) => msg.id))
    const next = messages.map((msg) => (seen.has(msg.id) ? { ...msg, read: true } : msg))
    // Rewrite entire file with updated read flags
    const data = serialize(next)
    await Bun.write(target, data)
    remember(target, data, { messages: next, invalid: [] })
    log.info("inbox marked read", { teamName, agentName, count: read.length })
    await Bus.publish(TeamEvent.MessageRead, { teamName, agentName, count: read.length })
    return read
  }

  /**
   * Remove an agent's inbox entirely.
   */
  export async function remove(teamName: string, agentName: string): Promise<void> {
    const target = filepath(teamName, agentName)
    const qpath = quarantinepath(teamName, agentName)
    cache.delete(target)
    await fs.unlink(target).catch(() => {})
    await fs.unlink(qpath).catch(() => {})
  }

  /**
   * Remove all inboxes for a team.
   */
  export async function removeAll(teamName: string, agentNames: string[]): Promise<void> {
    for (const name of agentNames) {
      await remove(teamName, name)
    }
    // Also remove the lead inbox
    await remove(teamName, "lead")
  }

  const MAX_MESSAGES = 1000
  const PRUNE_AGE = 60 * 60 * 1000 // 1 hour

  /**
   * Prune old read messages from an inbox.
   * Keeps max MAX_MESSAGES and removes read messages older than PRUNE_AGE.
   * Returns the number of messages removed.
   */
  export async function prune(teamName: string, agentName: string): Promise<number> {
    const target = filepath(teamName, agentName)
    using _ = await Lock.write(target)
    const content = await Bun.file(target)
      .text()
      .catch(() => "")
    const messages = (await repair(teamName, agentName, target, content)).messages
    if (messages.length <= MAX_MESSAGES / 2) return 0

    const now = Date.now()
    const kept = messages.filter((m) => {
      if (!m.read) return true
      if (now - m.timestamp < PRUNE_AGE) return true
      return false
    })

    // Also enforce hard cap
    const final = kept.length > MAX_MESSAGES ? kept.slice(-MAX_MESSAGES) : kept
    const removed = messages.length - final.length
    if (removed === 0) return 0

    const data = serialize(final)
    await Bun.write(target, data)
    remember(target, data, { messages: final, invalid: [] })
    log.info("inbox pruned", { teamName, agentName, removed, remaining: final.length })

    await Bus.publish(TeamEvent.InboxPruned, { teamName, agentName, removed })
    return removed
  }
}
