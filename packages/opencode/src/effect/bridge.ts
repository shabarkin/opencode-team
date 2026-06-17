import { Context, Effect, Exit, Fiber } from "effect"
import { WorkspaceContext } from "@/control-plane/workspace-context"
import type { WorkspaceV2 } from "@opencode-ai/core/workspace"
import { InstanceRef, WorkspaceRef } from "./instance-ref"
import { attachWith } from "./run-service"
import { context as instanceContext } from "@/project/instance-context"
import type { InstanceContext } from "@/project/instance-context"

export interface Shape {
  readonly promise: <A, E, R>(effect: Effect.Effect<A, E, R>) => Promise<A>
  readonly fork: <A, E, R>(effect: Effect.Effect<A, E, R>) => Fiber.Fiber<A, E>
  readonly run: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E>
  readonly bind: <Args extends readonly unknown[], Result>(fn: (...args: Args) => Result) => (...args: Args) => Result
}

function restoreWorkspace<R>(workspace: WorkspaceV2.ID | undefined, fn: () => R): R {
  if (workspace !== undefined) return WorkspaceContext.restore(workspace, fn)
  return fn()
}

function restoreInstance<R>(instance: InstanceContext | undefined, fn: () => R): R {
  if (instance !== undefined) return instanceContext.provide(instance, fn)
  return fn()
}

function restoreRefs<R>(refs: { instance?: InstanceContext; workspace?: WorkspaceV2.ID }, fn: () => R): R {
  return restoreWorkspace(refs.workspace, () => restoreInstance(refs.instance, fn))
}

function captureSync() {
  const fiber = Fiber.getCurrent()
  const instance = fiber ? Context.getReferenceUnsafe(fiber.context, InstanceRef) : undefined
  const workspace =
    (fiber ? Context.getReferenceUnsafe(fiber.context, WorkspaceRef) : undefined) ?? WorkspaceContext.workspaceID
  return { instance, workspace }
}

export const bind = <Args extends readonly unknown[], Result>(fn: (...args: Args) => Result) => {
  const captured = captureSync()
  return (...args: Args) => restoreRefs(captured, () => Effect.runSync(attachWith(Effect.sync(() => fn(...args)), captured)))
}

/**
 * Bridge from Effect into a Promise-returning JS callback while preserving
 * legacy AsyncLocalStorage contexts for callback code that still reads them.
 *
 * Mirrors `Effect.promise` but restores workspace ALS first.
 */
export const fromPromise = <T>(fn: () => Promise<T> | T): Effect.Effect<T> =>
  Effect.gen(function* () {
    const workspace = yield* WorkspaceRef
    return yield* Effect.promise(() => Promise.resolve(restoreWorkspace(workspace, () => fn())))
  })

export function make(): Effect.Effect<Shape> {
  return Effect.gen(function* () {
    const ctx = yield* Effect.context()
    const captured = captureSync()
    const instance = (yield* InstanceRef) ?? captured.instance
    const workspace = (yield* WorkspaceRef) ?? captured.workspace
    const wrap = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      attachWith(effect.pipe(Effect.provide(ctx)) as Effect.Effect<A, E, never>, { instance, workspace })

    return {
      promise: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        restoreRefs({ instance, workspace }, () => Effect.runPromise(wrap(effect))),
      fork: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        restoreRefs({ instance, workspace }, () => Effect.runFork(wrap(effect))),
      run: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        Effect.callback<A, E>((resume) => {
          restoreRefs({ instance, workspace }, () =>
            Effect.runPromiseExit(wrap(effect)).then((exit) =>
              resume(Exit.isSuccess(exit) ? Effect.succeed(exit.value) : Effect.failCause(exit.cause)),
            ),
          )
        }),
      bind:
        <Args extends readonly unknown[], Result>(fn: (...args: Args) => Result) =>
        (...args: Args) =>
          restoreRefs({ instance, workspace }, () => Effect.runSync(wrap(Effect.sync(() => fn(...args))))),
    } satisfies Shape
  })
}

export * as EffectBridge from "./bridge"
