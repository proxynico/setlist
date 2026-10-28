import type { Command } from "commander";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer } from "../mcp";
import type { EngineName, MusicEngine } from "../lib/types";

export function registerMcpCommand(program: Command, getEngine: (name?: EngineName) => MusicEngine) {
  program
    .command("mcp")
    .description("Run an MCP server on stdio so AI assistants can use Setlist")
    .action(async () => {
      await createMcpServer(getEngine).server.connect(new StdioServerTransport());
    });
}
