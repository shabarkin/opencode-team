import { describe, expect, test } from "bun:test"
import path from "path"
import { Instance } from "../../src/project/instance"
import { Team } from "../../src/team"
import { Session } from "../../src/session"
import { SessionID } from "../../src/session/schema"
import { Bus } from "../../src/bus"
import { Env } from "../../src/env"
import { Log } from "../../src/util/log"
import { activeConflicts, initFileTracking } from "../../src/team/files"

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
})
