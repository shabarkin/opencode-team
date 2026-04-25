import { Plugin } from "../plugin"
import { Format } from "../format"
import { LSP } from "../lsp"
import { File } from "../file"
import { Snapshot } from "../snapshot"
import * as Project from "./project"
import * as Vcs from "./vcs"
import { Bus } from "../bus"
import { Command } from "../command"
import { Instance } from "./instance"
import { Log } from "@/util"
import { FileWatcher } from "@/file/watcher"
import { ShareNext } from "@/share"
import * as Effect from "effect/Effect"
import { Config } from "@/config"
import { Flag } from "@/flag/flag"

export const InstanceBootstrap = Effect.gen(function* () {
  Log.Default.info("bootstrapping", { directory: Instance.directory })
  // everything depends on config so eager load it for nice traces
  yield* Config.Service.use((svc) => svc.get())
  // Plugin can mutate config so it has to be initialized before anything else.
  yield* Plugin.Service.use((svc) => svc.init())
  yield* Effect.all(
    [
      LSP.Service,
      ShareNext.Service,
      Format.Service,
      File.Service,
      FileWatcher.Service,
      Vcs.Service,
      Snapshot.Service,
    ].map((s) => Effect.forkDetach(s.use((i) => i.init()))),
  ).pipe(Effect.withSpan("InstanceBootstrap.init"))

  yield* Bus.Service.use((svc) =>
    svc.subscribeCallback(Command.Event.Executed, async (payload) => {
      if (payload.properties.name === Command.Default.INIT) {
        Project.setInitialized(Instance.project.id)
      }
    }),
  )

  // Team features — order matters:
  // 1. onCleanedRestorePermissions() registers synchronously so it's ready
  //    before recover(), which could trigger cleanup if all members are shutdown.
  // 2. recover() marks stale busy executions as cancelled, transitions members to ready, and notifies leads.
  // 3. autoCleanup() subscribes AFTER recover finishes (.finally()) to avoid
  //    spurious MemberStatusChanged events during recovery triggering premature cleanup.
  // Fire-and-forget: don't block bootstrap completion.
  if (Flag.OPENCODE_EXPERIMENTAL_AGENT_TEAMS) {
    // Dynamic import — only load team module when the feature flag is enabled
    import("../team").then(({ Team }) => {
      Team.onCleanedRestorePermissions()
      Team.recover()
        .catch((err) => {
          Log.Default.warn("team recovery failed", { error: err instanceof Error ? err.message : err })
        })
        .finally(() => {
          Team.trackResults()
          Team.autoCleanup()
          Team.checkpoints()
        })
      // File conflict detection
      import("../team/files").then(({ initFileTracking }) => initFileTracking())
    })
  }
}).pipe(Effect.withSpan("InstanceBootstrap"))
