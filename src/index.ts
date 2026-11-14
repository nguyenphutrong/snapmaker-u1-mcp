#!/usr/bin/env bun
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.ts";
import { Moonraker } from "./moonraker.ts";
import { registerReadTools } from "./tools/read.ts";

// stdout carries the MCP protocol; everything human-readable goes to stderr.
let config;
try {
  config = loadConfig();
} catch (e) {
  console.error(`snapmaker-u1-mcp: ${(e as Error).message}`);
  process.exit(1);
}

const server = new McpServer({ name: "snapmaker-u1", version: "0.1.0" });
registerReadTools(server, new Moonraker(config.host, config.apiKey));
await server.connect(new StdioServerTransport());
console.error(`snapmaker-u1-mcp ready, printer ${config.host}`);
