/**
 * Test helper for invoking team tools that were ported to the new
 * Effect-based Tool framework (PR #23244).
 *
 * Each team tool is now an `Effect.Effect<Tool.Info<...>>` requiring `Truncate.Service`
 * and `Agent.Service` from the framework. This helper builds a single ManagedRuntime
 * with both services provided and exposes a small `init(tool)` Promise-style facade
 * that returns the tool's `{ description, parameters, execute }` definition.
 *
 * Usage:
 * ```ts
 * import { initTeamTool } from "./_tool-runtime"
 * import { TeamCollectTool } from "../../src/tool/team-collect"
 *
 * const tool = await initTeamTool(TeamCollectTool)
 * const result = await runToolExecute(tool.execute(params, ctx))
 * ```
 */
import { Effect, Layer, ManagedRuntime } from "effect"
import { Agent } from "../../src/agent/agent"
import { Truncate } from "../../src/tool"

const runtime = ManagedRuntime.make(Layer.mergeAll(Truncate.defaultLayer, Agent.defaultLayer))

export function initTeamTool(tool: any): Promise<any> {
  return runtime.runPromise(Effect.flatMap(tool as Effect.Effect<{ init: () => Effect.Effect<any> }>, (info) => info.init()))
}

/**
 * Convenience helper for calling a tool's execute() and getting back a Promise.
 * The execute callback returns an Effect, so this runs it through the runtime.
 */
export function runToolExecute<R>(eff: Effect.Effect<R, never, never>): Promise<R> {
  return runtime.runPromise(eff)
}

/**
 * One-shot helper that mirrors the pre-PR-#23244 `(await XxxTool.init()).execute(p, c)`
 * shape. Init the tool, run its execute Effect through the runtime, return the result.
 */
export async function callTeamTool(tool: any, params: any, ctx: any): Promise<any> {
  const def = await initTeamTool(tool)
  return runToolExecute(def.execute(params, ctx))
}
