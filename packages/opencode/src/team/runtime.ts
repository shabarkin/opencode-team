/**
 * Promise-style facades for upstream Effect Services.
 *
 * The team module is mostly Promise-based and predates the upstream PR #23244
 * migration that turned core APIs (Storage, Session, SessionStatus,
 * SessionPrompt, Agent, Plugin, Provider, Project) into Effect Services that
 * must be `yield*`'d from inside `Effect.gen`.
 *
 * Rather than rewrite the entire team module, this file exposes the original
 * Promise-style call shapes by wiring each Service through `makeRuntime`.
 *
 * TODO(team): When the team module is itself ported to Effect-native code, this
 * facade can be deleted and callers can `yield* Service` directly.
 */

import { makeRuntime } from "@/effect/run-service"
import { Effect } from "effect"
import * as StorageNs from "../storage/storage"
import * as SessionNs from "../session/session"
import * as SessionStatusNs from "../session/status"
import * as SessionPromptNs from "../session/prompt"
import * as AgentNs from "../agent/agent"
import * as PluginNs from "../plugin"
import * as ProviderNs from "../provider/provider"
import * as ProjectNs from "../project/project"
import * as MessageV2Ns from "../session/message-v2"
import { MessageID, PartID, type SessionID } from "../session/schema"
import { lazy } from "@/util/lazy"
import { Log } from "@/util"

const log = Log.create({ service: "team.runtime" })

/**
 * `makeRuntime` is called eagerly per-Service below. When this module sits in
 * an import cycle (tool/registry.ts → tool/team.ts → team/index.ts → here →
 * agent/agent.ts which is mid-evaluation because the cycle started at
 * app-runtime → agent), reading `Service` at module top-level throws TDZ.
 *
 * Each makeRuntime call below is wrapped in `lazy()` to defer the Service
 * lookup until first use — by then every namespace's exports are fully
 * initialised.
 */

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

const storageRt = lazy(() => makeRuntime(StorageNs.Service, StorageNs.defaultLayer))

export const Storage = {
  write: <T>(key: string[], content: T) => storageRt().runPromise((s) => s.write(key, content)),
  read: <T>(key: string[]) => storageRt().runPromise((s) => s.read<T>(key)),
  update: <T>(key: string[], fn: (draft: T) => void) => storageRt().runPromise((s) => s.update<T>(key, fn)),
  remove: (key: string[]) => storageRt().runPromise((s) => s.remove(key)),
  list: (prefix: string[]) => storageRt().runPromise((s) => s.list(prefix)),
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

const sessionRt = lazy(() => makeRuntime(SessionNs.Service, SessionNs.defaultLayer))

export const Session = {
  get: (id: SessionID) => sessionRt().runPromise((s) => s.get(id)),
  setPermission: (input: { sessionID: SessionID; permission: any }) =>
    sessionRt().runPromise((s) => s.setPermission(input)),
  remove: (id: SessionID) => sessionRt().runPromise((s) => s.remove(id)),
  messages: (input: { sessionID: SessionID; limit?: number }) => sessionRt().runPromise((s) => s.messages(input)),
  children: (parentID: SessionID) => sessionRt().runPromise((s) => s.children(parentID)),
  updateMessage: <T extends MessageV2Ns.Info>(msg: T) => sessionRt().runPromise((s) => s.updateMessage(msg)),
  updatePart: <T extends MessageV2Ns.Part>(part: T) => sessionRt().runPromise((s) => s.updatePart(part)),
  create: (input?: { parentID?: SessionID; title?: string; permission?: any }) =>
    sessionRt().runPromise((s) => s.create(input)),
  /**
   * Creates a session pinned to an explicit working directory (used by team
   * worktree spawn so external clients pick the worktree path back up via
   * `session.directory`).
   */
  createNext: (input: { parentID?: SessionID; directory: string; title?: string; permission?: any }) =>
    sessionRt().runPromise((s) => s.createNext(input)),
  // Sync generator — re-export as-is; uses Database.use which doesn't need a runtime.
  list: SessionNs.list,
}

// ---------------------------------------------------------------------------
// SessionStatus
// ---------------------------------------------------------------------------

const sessionStatusRt = lazy(() => makeRuntime(SessionStatusNs.Service, SessionStatusNs.defaultLayer))

export const SessionStatus = {
  get: (sessionID: SessionID) => sessionStatusRt().runPromise((s) => s.get(sessionID)),
  list: () => sessionStatusRt().runPromise((s) => s.list()),
  set: (sessionID: SessionID, status: SessionStatusNs.Info) =>
    sessionStatusRt().runPromise((s) => s.set(sessionID, status)),
}

// ---------------------------------------------------------------------------
// SessionPrompt
// ---------------------------------------------------------------------------

const sessionPromptRt = lazy(() => makeRuntime(SessionPromptNs.Service, SessionPromptNs.defaultLayer))

/**
 * Original team `inject` — synthesizes a user message into a session as if
 * the LLM had received fresh user text. We replicate the legacy helper using
 * the new public Session.updateMessage / updatePart effects.
 */
function injectEffect(input: {
  sessionID: SessionID
  text: string
  created?: number
  metadata?: Record<string, unknown>
  messageID?: string
  partID?: string
}) {
  return Effect.gen(function* () {
    const sessions = yield* SessionNs.Service
    // Find the latest user message to inherit agent/model/system/etc.
    let user: MessageV2Ns.User | undefined
    let before: string | undefined
    for (let i = 0; i < 10 && !user; i++) {
      const pageItems = MessageV2Ns.page({ sessionID: input.sessionID, limit: 50, before }).items
      const found = pageItems.findLast((item) => item.info.role === "user")
      if (found && found.info.role === "user") {
        user = found.info as MessageV2Ns.User
        break
      }
      const last = pageItems[0]
      if (!last) break
      before = last.info.id
    }
    if (!user) throw new Error("No user message found in session")

    const msgID = input.messageID ? MessageID.make(input.messageID) : MessageID.ascending()
    const carry: Pick<MessageV2Ns.User, "agent" | "model"> & {
      format?: MessageV2Ns.User["format"]
      system?: MessageV2Ns.User["system"]
      tools?: MessageV2Ns.User["tools"]
    } = {
      agent: user.agent,
      model: user.model,
      ...(user.format ? { format: user.format } : {}),
      ...(user.system ? { system: user.system } : {}),
      ...(user.tools ? { tools: user.tools } : {}),
    }

    yield* sessions.updateMessage({
      id: msgID,
      sessionID: input.sessionID,
      role: "user" as const,
      time: { created: input.created ?? Date.now() },
      ...carry,
    } satisfies MessageV2Ns.User)

    yield* sessions.updatePart({
      id: input.partID ? PartID.make(input.partID) : PartID.ascending(),
      messageID: msgID,
      sessionID: input.sessionID,
      type: "text" as const,
      text: input.text,
      synthetic: true,
      ...(input.metadata ? { metadata: input.metadata } : {}),
    } as MessageV2Ns.TextPart)

    return msgID
  })
}

export const SessionPrompt = {
  cancel: (sessionID: SessionID) => sessionPromptRt().runPromise((s) => s.cancel(sessionID)),
  loop: (input: SessionPromptNs.LoopInput | { sessionID: SessionID }) =>
    sessionPromptRt().runPromise((s) => s.loop(input as SessionPromptNs.LoopInput)),
  prompt: (input: SessionPromptNs.PromptInput) =>
    sessionPromptRt().runPromise((s) => s.prompt(input)),
  inject: (input: {
    sessionID: SessionID
    text: string
    created?: number
    metadata?: Record<string, unknown>
    messageID?: string
    partID?: string
  }) => sessionRt().runPromise(() => injectEffect(input)),
  /**
   * Inject corrective text into a session. If the session is idle, kick the
   * loop to wake it; otherwise let the in-progress turn pick up the inject on
   * its next user-message read.
   */
  steer: async (sessionID: SessionID, text: string) => {
    await SessionPrompt.inject({ sessionID, text })
    const status = await SessionStatus.get(sessionID)
    if (status.type !== "idle") return
    void SessionPrompt.loop({ sessionID }).catch((err) => {
      log.warn("steer wake failed", {
        sessionID,
        error: err instanceof Error ? err.message : String(err),
      })
    })
  },
}

// ---------------------------------------------------------------------------
// Agent
// ---------------------------------------------------------------------------

const agentRt = lazy(() => makeRuntime(AgentNs.Service, AgentNs.defaultLayer))

export const Agent = {
  get: (name: string) => agentRt().runPromise((s) => s.get(name)),
  list: () => agentRt().runPromise((s) => s.list()),
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const pluginRt = lazy(() => makeRuntime(PluginNs.Plugin.Service, PluginNs.Plugin.defaultLayer))

export const Plugin = {
  trigger: <
    Name extends Parameters<PluginNs.Plugin.Interface["trigger"]>[0],
    Input extends Parameters<PluginNs.Plugin.Interface["trigger"]>[1],
    Output extends Parameters<PluginNs.Plugin.Interface["trigger"]>[2],
  >(
    name: Name,
    input: Input,
    output: Output,
  ) => pluginRt().runPromise((s) => s.trigger(name, input as never, output as never)) as Promise<Output>,
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

const providerRt = lazy(() => makeRuntime(ProviderNs.Service, ProviderNs.defaultLayer))

export const Provider = {
  getModel: (providerID: any, modelID: any) => providerRt().runPromise((s) => s.getModel(providerID, modelID)),
  defaultModel: () => providerRt().runPromise((s) => s.defaultModel()),
  // Top-level helpers (not on Service)
  parseModel: ProviderNs.parseModel,
  ModelNotFoundError: ProviderNs.ModelNotFoundError,
}

// ---------------------------------------------------------------------------
// Project
// ---------------------------------------------------------------------------

const projectRt = lazy(() => makeRuntime(ProjectNs.Service, ProjectNs.defaultLayer))

export const Project = {
  addSandbox: (id: string, directory: string) => projectRt().runPromise((s) => s.addSandbox(id as any, directory)),
  removeSandbox: (id: string, directory: string) =>
    projectRt().runPromise((s) => s.removeSandbox(id as any, directory)),
}
