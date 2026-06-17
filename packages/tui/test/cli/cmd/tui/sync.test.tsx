/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test"
import { tmpdir } from "../../../fixture/fixture"
import { json, mount, wait } from "./sync-fixture"
import type { GlobalEvent } from "@opencode-ai/sdk/v2"

function branchEvent(branch: string, workspace?: string): GlobalEvent {
  return {
    directory: "/tmp/other",
    project: "proj_test",
    workspace,
    payload: {
      id: `evt_vcs_${branch}`,
      type: "vcs.branch.updated",
      properties: { branch },
    },
  }
}

describe("tui sync", () => {
  test("refresh scopes sessions by default and lists project sessions when disabled", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const { app, kv, sync, session } = await mount(undefined, tmp.path)

    try {
      expect(kv.get("session_directory_filter_enabled", true)).toBe(true)
      expect(session.at(-1)?.searchParams.get("scope")).toBeNull()
      expect(session.at(-1)?.searchParams.get("path")).toBe("packages/tui")

      kv.set("session_directory_filter_enabled", false)
      await sync.session.refresh()

      expect(session.at(-1)?.searchParams.get("scope")).toBe("project")
      expect(session.at(-1)?.searchParams.get("path")).toBeNull()
    } finally {
      app.renderer.destroy()
    }
  })

  test("vcs branch updates only apply for the active workspace", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const { app, emit, project, sync } = await mount(undefined, tmp.path)

    try {
      expect(sync.data.vcs?.branch).toBe("main")

      project.workspace.set("ws_a")
      emit(branchEvent("other", "ws_b"))
      await Bun.sleep(30)

      expect(sync.data.vcs?.branch).toBe("main")

      emit(branchEvent("feature", "ws_a"))
      await wait(() => sync.data.vcs?.branch === "feature")

      expect(sync.data.vcs?.branch).toBe("feature")
    } finally {
      app.renderer.destroy()
    }
  })

  test("switching workspace clears fully-synced sessions so they re-hydrate", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")

    const sessionID = "ses_workspace_switch"
    const session = {
      id: sessionID,
      title: "switch",
      time: { created: 0, updated: 0 },
      version: "1.15.13",
      directory: "/tmp/opencode/packages/opencode",
    }
    let messageRequests = 0
    const { app, project, sync } = await mount((url) => {
      if (url.pathname === `/session/${sessionID}`) return json(session)
      if (url.pathname === `/session/${sessionID}/message`) {
        messageRequests++
        return json([])
      }
      if (url.pathname === `/session/${sessionID}/todo` || url.pathname === `/session/${sessionID}/diff`) return json([])
      return undefined
    }, tmp.path)

    try {
      // First hydration fetches messages and marks the session fully synced.
      await sync.session.sync(sessionID)
      expect(messageRequests).toBe(1)

      // A repeat sync in the same workspace is deduplicated (no refetch).
      await sync.session.sync(sessionID)
      expect(messageRequests).toBe(1)

      // Switching workspace reuses the same SyncProvider instance; bootstrap must drop the
      // synced markers so the session re-hydrates with fresh data for the new workspace.
      project.workspace.set("ws_other")
      await sync.bootstrap({ fatal: false }).catch(() => undefined)

      await sync.session.sync(sessionID)
      expect(messageRequests).toBe(2)
    } finally {
      app.renderer.destroy()
    }
  })
})
