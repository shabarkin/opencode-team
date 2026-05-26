import { Effect } from "effect"
import { context, type InstanceContext } from "./instance-context"
import { InstanceRuntime } from "./instance-runtime"

export type { InstanceContext } from "./instance-context"
export type { LoadInput } from "./instance-store"

export const Instance = {
  async provide<R>(input: {
    directory: string
    init?: Effect.Effect<void> | ((directory: string) => Promise<unknown> | unknown)
    fn: () => R
  }): Promise<Awaited<R>> {
    const ctx = await InstanceRuntime.load({ directory: input.directory })
    return (await context.provide(ctx, async () => {
      if (typeof input.init === "function") await input.init(ctx.directory)
      if (input.init && typeof input.init !== "function") {
        const { AppRuntime } = await import("@/effect/app-runtime")
        await AppRuntime.runPromise(input.init)
      }
      return (await input.fn()) as Awaited<R>
    })) as Awaited<R>
  },
  get current() {
    return context.use()
  },
  get directory() {
    return context.use().directory
  },
  get worktree() {
    return context.use().worktree
  },
  get project() {
    return context.use().project
  },

  /**
   * Captures the current instance ALS context and returns a wrapper that
   * restores it when called. Use this for callbacks that fire outside the
   * instance async context (native addons, event emitters, timers, etc.).
   */
  bind<F extends (...args: any[]) => any>(fn: F): F {
    const ctx = context.use()
    return ((...args: any[]) => context.provide(ctx, () => fn(...args))) as F
  },
  /**
   * Run a synchronous function within the given instance context ALS.
   * Use this to bridge from Effect (where InstanceRef carries context)
   * back to sync code that reads Instance.directory from ALS.
   */
  restore<R>(ctx: InstanceContext, fn: () => R): R {
    return context.provide(ctx, fn)
  },
}
