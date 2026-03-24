import { describe, expect, test } from "bun:test"

/**
 * Tests that task subagents are isolated from the team communication graph.
 *
 * task.ts must deny every exported team tool.
 * denied for subagents. These tests verify:
 * 1. The constant covers every team tool defined in team.ts
 * 2. The deny rules and tool visibility are correctly generated
 */

// We can't directly import the private TEAM_TOOLS constant, so we
// verify via the module's exported behavior. We do import the team
// tool exports to get the authoritative list of team tool IDs.
import {
  TEAM_TOOL_IDS,
  TeamCreateTool,
  TeamSpawnTool,
  TeamMessageTool,
  TeamBroadcastTool,
  TeamTasksTool,
  TeamClaimTool,
  TeamApprovePlanTool,
  TeamShutdownTool,
  TeamCleanupTool,
  TeamHealthTool,
  TeamRestartTool,
} from "../../src/tool/team"
import { TeamStatusTool } from "../../src/tool/team-status"
import { TeamNotepadTool } from "../../src/tool/team-notepad"

/** The authoritative set of all team tool IDs from team.ts */
const ALL_TEAM_TOOL_IDS = [
  TeamCreateTool.id,
  TeamSpawnTool.id,
  TeamMessageTool.id,
  TeamBroadcastTool.id,
  TeamTasksTool.id,
  TeamClaimTool.id,
  TeamApprovePlanTool.id,
  TeamShutdownTool.id,
  TeamCleanupTool.id,
  TeamStatusTool.id,
  TeamNotepadTool.id,
  TeamHealthTool.id,
  TeamRestartTool.id,
]

describe("task subagent team tool isolation", () => {
  test("TEAM_TOOL_IDS exports all team tools", () => {
    expect(TEAM_TOOL_IDS.length).toBeGreaterThan(0)
  })

  test("TEAM_TOOL_IDS covers all team tools", () => {
    expect(TEAM_TOOL_IDS.length).toBe(ALL_TEAM_TOOL_IDS.length)
    for (const id of ALL_TEAM_TOOL_IDS) {
      expect(TEAM_TOOL_IDS).toContain(id)
    }
  })

  test("TEAM_TOOL_IDS contains no duplicates", () => {
    const unique = new Set(TEAM_TOOL_IDS)
    expect(unique.size).toBe(TEAM_TOOL_IDS.length)
  })

  test("TEAM_TOOL_IDS matches authoritative team tool IDs exactly", () => {
    expect([...TEAM_TOOL_IDS].sort()).toEqual([...ALL_TEAM_TOOL_IDS].sort())
  })

  test("task.ts denies team tools in session permission rules", async () => {
    const src = await Bun.file(new URL("../../src/tool/task.ts", import.meta.url).pathname).text()

    // Verify the TEAM_TOOL_IDS.map deny pattern exists in the permission array
    expect(src).toContain("...TEAM_TOOL_IDS.map((t) => ({")
    expect(src).toContain('action: "deny" as const')

    // Verify it's inside the Session.create permission array (after todoread deny)
    const permissionSection = src.slice(src.indexOf("Session.create({"), src.indexOf("const msg = await MessageV2"))
    expect(permissionSection).toContain("TEAM_TOOL_IDS.map")
  })

  test("task.ts hides team tools from LLM tool list", async () => {
    const src = await Bun.file(new URL("../../src/tool/task.ts", import.meta.url).pathname).text()

    // Verify the tools map includes TEAM_TOOL_IDS set to false
    const toolsSection = src.slice(src.indexOf("tools: {"), src.indexOf("parts: promptParts"))
    expect(toolsSection).toContain("...Object.fromEntries(TEAM_TOOL_IDS.map((t) => [t, false]))")
  })

  test("teammate system prompt documents relay pattern", async () => {
    const src = await Bun.file(new URL("../../src/tool/team.ts", import.meta.url).pathname).text()

    expect(src).toContain("SUBAGENT RELAY")
    expect(src).toContain("they CANNOT communicate with the team")
    expect(src).toContain("relaying any relevant findings")
  })
})
