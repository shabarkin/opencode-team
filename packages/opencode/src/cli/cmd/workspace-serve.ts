import { cmd } from "./cmd"
import { withNetworkOptions, resolveNetworkOptions } from "../network"
import { WorkspaceServer } from "../../control-plane/workspace-server/server"

export const WorkspaceServeCommand = cmd({
  command: "workspace-serve",
  builder: (yargs) =>
    withNetworkOptions(yargs).option("worktrees", {
      type: "boolean",
      default: false,
      describe: "enable isolated teammate git worktrees for agent teams",
    }),
  describe: "starts a remote workspace event server",
  handler: async (args) => {
    process.env.OPENCODE_EXPERIMENTAL_AGENT_TEAMS_WORKTREES = args.worktrees ? "true" : "false"
    const opts = await resolveNetworkOptions(args)
    const server = WorkspaceServer.Listen(opts)
    console.log(`workspace event server listening on http://${server.hostname}:${server.port}/event`)
    await new Promise(() => {})
    await server.stop()
  },
})
