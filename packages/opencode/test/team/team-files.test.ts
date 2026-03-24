import { describe, expect, test, spyOn } from "bun:test"
import path from "path"
import { Instance } from "../../src/project/instance"
import { Team } from "../../src/team"
import { Session } from "../../src/session"
import { SessionID } from "../../src/session/schema"
import { Bus } from "../../src/bus"
import { Env } from "../../src/env"
import { Log } from "../../src/util/log"
import { activeConflicts, initFileTracking } from "../../src/team/files"
import { TeamMessaging } from "../../src/team/messaging"

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

        const diff = [{ file: "/tmp/shared.ts", before: "", after: "x", additions: 1, deletions: 0 }]
        await Bus.publish(Session.Event.Diff, { sessionID: SessionID.make("ses_a1"), diff })
        await Bus.publish(Session.Event.Diff, { sessionID: SessionID.make("ses_b1"), diff })
        await Bus.publish(Session.Event.Diff, { sessionID: SessionID.make("ses_a2"), diff })

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

        const diff = [{ file: "/tmp/shared-c.ts", before: "", after: "x", additions: 1, deletions: 0 }]
        await Bus.publish(Session.Event.Diff, { sessionID: SessionID.make("ses_c1"), diff })
        await Team.transitionMemberStatus("files-c", "c1", "shutdown_requested")
        await Bus.publish(Session.Event.Diff, { sessionID: SessionID.make("ses_c2"), diff })

        const team = await Team.get("files-c")
        expect(activeConflicts("files-c", team!)).toEqual([])
        expect(send).toHaveBeenCalledTimes(2)
        expect(send).toHaveBeenNthCalledWith(1, {
          teamName: "files-c",
          from: "system",
          to: "c2",
          text: "[System]: File conflict — c1, c2 edited /tmp/shared-c.ts within 5 minutes. Coordinate to avoid overwriting each other's changes.",
        })
        expect(send).toHaveBeenNthCalledWith(2, {
          teamName: "files-c",
          from: "system",
          to: "lead",
          text: "[System]: File conflict — c1, c2 edited /tmp/shared-c.ts within 5 minutes. Coordinate to avoid overwriting each other's changes.",
        })

        send.mockRestore()
        stop()
        await Team.setMemberStatus("files-c", "c1", "shutdown")
        await Team.setMemberStatus("files-c", "c2", "shutdown")
        await Team.cleanup("files-c")
      },
    })
  })
})
