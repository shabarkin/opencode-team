import { describe, expect, test, spyOn } from "bun:test"
import path from "path"
import { Instance } from "../../src/project/instance"
import { File } from "../../src/file"
import { Session } from "../../src/session"
import { Team } from "../../src/team"
import { SessionID } from "../../src/session/schema"
import { Bus } from "../../src/bus"
import { Env } from "../../src/env"
import { Log } from "../../src/util/log"
import { activeConflicts, initFileTracking } from "../../src/team/files"
import { TeamMessaging } from "../../src/team/messaging"
import { Plugin } from "../../src/plugin"

Log.init({ print: false })

const root = path.join(__dirname, "../..")

describe("team file tracking", () => {
  test("tracks conflicts per team only", async () => {
    await Instance.provide({
      directory: root,
      init: async () => {
        Env.set("ANTHROPIC_API_KEY", "test-key")
      },
      fn: async () => {
        const stop = initFileTracking()

        await Team.create({ name: "files-a", leadSessionID: "ses_lead_files_a" })
        await Team.create({ name: "files-b", leadSessionID: "ses_lead_files_b" })
        await Team.addMember("files-a", { name: "a1", sessionID: "ses_a1", agent: "general", status: "busy" })
        await Team.addMember("files-a", { name: "a2", sessionID: "ses_a2", agent: "general", status: "busy" })
        await Team.addMember("files-b", { name: "b1", sessionID: "ses_b1", agent: "general", status: "busy" })
        await Team.addMember("files-b", { name: "b2", sessionID: "ses_b2", agent: "general", status: "busy" })

        await Bus.publish(File.Event.Edited, { file: "/tmp/shared.ts", sessionID: SessionID.make("ses_a1") })
        await Bus.publish(File.Event.Edited, { file: "/tmp/shared.ts", sessionID: SessionID.make("ses_b1") })
        await Bus.publish(File.Event.Edited, { file: "/tmp/shared.ts", sessionID: SessionID.make("ses_a2") })

        expect(activeConflicts("files-a")).toEqual([{ file: "/tmp/shared.ts", members: ["a1", "a2"] }])
        expect(activeConflicts("files-b")).toEqual([])

        stop()
        await Team.setMemberStatus("files-a", "a1", "shutdown")
        await Team.setMemberStatus("files-a", "a2", "shutdown")
        await Team.setMemberStatus("files-b", "b1", "shutdown")
        await Team.setMemberStatus("files-b", "b2", "shutdown")
        await Team.cleanup("files-a")
        await Team.cleanup("files-b")
      },
    })
  })

  test("skips shutdown-requested members in conflict alerts and active conflicts", async () => {
    await Instance.provide({
      directory: root,
      init: async () => {
        Env.set("ANTHROPIC_API_KEY", "test-key")
      },
      fn: async () => {
        const stop = initFileTracking()
        const send = spyOn(TeamMessaging, "send").mockImplementation(async () => {})

        await Team.create({ name: "files-c", leadSessionID: "ses_lead_files_c" })
        await Team.addMember("files-c", { name: "c1", sessionID: "ses_c1", agent: "general", status: "busy" })
        await Team.addMember("files-c", { name: "c2", sessionID: "ses_c2", agent: "general", status: "busy" })

        await Bus.publish(File.Event.Edited, { file: "/tmp/shared-c.ts", sessionID: SessionID.make("ses_c1") })
        await Team.transitionMemberStatus("files-c", "c1", "shutdown_requested")
        await Bus.publish(File.Event.Edited, { file: "/tmp/shared-c.ts", sessionID: SessionID.make("ses_c2") })

        const team = await Team.get("files-c")
        expect(activeConflicts("files-c", team!)).toEqual([])
        expect(send).not.toHaveBeenCalled()

        send.mockRestore()
        stop()
        await Team.setMemberStatus("files-c", "c1", "shutdown")
        await Team.setMemberStatus("files-c", "c2", "shutdown")
        await Team.cleanup("files-c")
      },
    })
  })

  test("deduplicates repeated file conflict warnings during cooldown", async () => {
    await Instance.provide({
      directory: root,
      init: async () => {
        Env.set("ANTHROPIC_API_KEY", "test-key")
      },
      fn: async () => {
        const stop = initFileTracking()
        const send = spyOn(TeamMessaging, "send").mockImplementation(async () => {})

        await Team.create({ name: "files-d", leadSessionID: "ses_lead_files_d" })
        await Team.addMember("files-d", { name: "d1", sessionID: "ses_d1", agent: "general", status: "busy" })
        await Team.addMember("files-d", { name: "d2", sessionID: "ses_d2", agent: "general", status: "busy" })

        await Bus.publish(File.Event.Edited, { file: "/tmp/shared-d.ts", sessionID: SessionID.make("ses_d1") })
        await Bus.publish(File.Event.Edited, { file: "/tmp/shared-d.ts", sessionID: SessionID.make("ses_d2") })
        await Bus.publish(File.Event.Edited, { file: "/tmp/shared-d.ts", sessionID: SessionID.make("ses_d1") })

        const conflicts = activeConflicts("files-d")
        expect(conflicts).toHaveLength(1)
        expect(conflicts[0]?.file).toBe("/tmp/shared-d.ts")
        expect(conflicts[0]?.members.toSorted()).toEqual(["d1", "d2"])
        expect(send).toHaveBeenCalledTimes(3)

        send.mockRestore()
        stop()
        await Team.setMemberStatus("files-d", "d1", "shutdown")
        await Team.setMemberStatus("files-d", "d2", "shutdown")
        await Team.cleanup("files-d")
      },
    })
  })

  test("conflict policy can block editors by pausing them", async () => {
    await Instance.provide({
      directory: root,
      init: async () => {
        Env.set("ANTHROPIC_API_KEY", "test-key")
      },
      fn: async () => {
        const stop = initFileTracking()
        const trigger = spyOn(Plugin, "trigger").mockImplementation(async (name, _input, output) => {
          if (name === "team.conflict.detected") {
            ;(output as { action: "warn" | "block" | "ignore" }).action = "block"
          }
          return output as any
        })
        const pause = spyOn(Team, "pause").mockResolvedValue(undefined)

        await Team.create({ name: "files-e", leadSessionID: "ses_lead_files_e" })
        await Team.addMember("files-e", { name: "e1", sessionID: "ses_e1", agent: "general", status: "busy" })
        await Team.addMember("files-e", { name: "e2", sessionID: "ses_e2", agent: "general", status: "busy" })

        await Bus.publish(File.Event.Edited, { file: "/tmp/shared-e.ts", sessionID: SessionID.make("ses_e1") })
        await Bus.publish(File.Event.Edited, { file: "/tmp/shared-e.ts", sessionID: SessionID.make("ses_e2") })

        expect(pause).toHaveBeenCalledTimes(2)

        trigger.mockRestore()
        pause.mockRestore()
        stop()
        await Team.setMemberStatus("files-e", "e1", "shutdown")
        await Team.setMemberStatus("files-e", "e2", "shutdown")
        await Team.cleanup("files-e")
      },
    })
  })

  test("ignores same relative path edits across isolated worktrees", async () => {
    await Instance.provide({
      directory: root,
      init: async () => {
        Env.set("ANTHROPIC_API_KEY", "test-key")
      },
      fn: async () => {
        const stop = initFileTracking()
        const send = spyOn(TeamMessaging, "send").mockImplementation(async () => {})

        await Team.create({ name: "files-f", leadSessionID: "ses_lead_files_f" })
        await Team.addMember("files-f", {
          name: "f1",
          sessionID: "ses_f1",
          agent: "general",
          status: "busy",
          worktreePath: "/tmp/team-files-f1",
        })
        await Team.addMember("files-f", {
          name: "f2",
          sessionID: "ses_f2",
          agent: "general",
          status: "busy",
          worktreePath: "/tmp/team-files-f2",
        })

        await Bus.publish(File.Event.Edited, { file: ".ananke/findings.db", sessionID: SessionID.make("ses_f1") })
        await Bus.publish(File.Event.Edited, { file: ".ananke/findings.db", sessionID: SessionID.make("ses_f2") })

        const team = await Team.get("files-f")
        expect(activeConflicts("files-f", team!)).toEqual([])
        expect(send).not.toHaveBeenCalled()

        send.mockRestore()
        stop()
        await Team.setMemberStatus("files-f", "f1", "shutdown")
        await Team.setMemberStatus("files-f", "f2", "shutdown")
        await Team.cleanup("files-f")
      },
    })
  })

  test("ignores session diffs without file edit provenance", async () => {
    await Instance.provide({
      directory: root,
      init: async () => {
        Env.set("ANTHROPIC_API_KEY", "test-key")
      },
      fn: async () => {
        const stop = initFileTracking()
        const send = spyOn(TeamMessaging, "send").mockImplementation(async () => {})

        await Team.create({ name: "files-g", leadSessionID: "ses_lead_files_g" })
        await Team.addMember("files-g", { name: "g1", sessionID: "ses_g1", agent: "general", status: "busy" })
        await Team.addMember("files-g", { name: "g2", sessionID: "ses_g2", agent: "general", status: "busy" })

        const diff = [{ file: "/tmp/shared-g.ts", before: "", after: "x", additions: 1, deletions: 0 }]
        await Bus.publish(Session.Event.Diff, { sessionID: SessionID.make("ses_g1"), diff })
        await Bus.publish(Session.Event.Diff, { sessionID: SessionID.make("ses_g2"), diff })

        expect(activeConflicts("files-g")).toEqual([])
        expect(send).not.toHaveBeenCalled()

        send.mockRestore()
        stop()
        await Team.setMemberStatus("files-g", "g1", "shutdown")
        await Team.setMemberStatus("files-g", "g2", "shutdown")
        await Team.cleanup("files-g")
      },
    })
  })
})
