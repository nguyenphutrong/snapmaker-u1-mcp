#!/usr/bin/env bun
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.ts";
import { serveHttp } from "./http.ts";
import { Moonraker } from "./moonraker.ts";
import { registerReadTools } from "./tools/read.ts";
import { registerSliceTool } from "./tools/slice.ts";
import { registerWriteTools } from "./tools/write.ts";

// stdout carries the MCP protocol; everything human-readable goes to stderr.
let config;
try {
  config = loadConfig();
} catch (e) {
  console.error(`snapmaker-u1-mcp: ${(e as Error).message}`);
  process.exit(1);
}

const moonraker = new Moonraker(config.host, config.apiKey);
const buildServer = () => {
  const server = new McpServer({ name: "snapmaker-u1", version: "0.1.0" });
  registerReadTools(server, moonraker);
  registerWriteTools(server, moonraker, config);
  if (config.orcaCliPath) registerSliceTool(server, config.orcaCliPath);
  return server;
};

if (config.httpPort && config.authToken) {
  const http = serveHttp(config.httpPort, config.authToken, buildServer);
  console.error(`snapmaker-u1-mcp listening on http://0.0.0.0:${http.port}/mcp, printer ${config.host}`);
} else {
  await buildServer().connect(new StdioServerTransport());
  console.error(`snapmaker-u1-mcp ready, printer ${config.host}`);
}
