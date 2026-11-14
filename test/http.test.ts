import { afterAll, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadConfig } from "../src/config.ts";
import { serveHttp } from "../src/http.ts";
import { Moonraker } from "../src/moonraker.ts";
import { registerReadTools } from "../src/tools/read.ts";

const TOKEN = "s3cret-token-0123456789";
const http = serveHttp(0, TOKEN, () => {
  const s = new McpServer({ name: "test", version: "0" });
  registerReadTools(s, new Moonraker("http://127.0.0.1:1"));
  return s;
});
afterAll(() => http.stop(true));
const url = `http://localhost:${http.port}/mcp`;

test("requests without the exact bearer token are rejected before reaching MCP", async () => {
  const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "x", version: "0" } } };
  for (const auth of [undefined, "Bearer wrong", `Bearer ${TOKEN}x`, `Bearer ${TOKEN.slice(0, -1)}`, TOKEN, "Bearer "]) {
    const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json, text/event-stream" };
    if (auth !== undefined) headers.authorization = auth;
    const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(init) });
    expect(res.status).toBe(401);
  }
  expect((await fetch(`http://localhost:${http.port}/other`, { headers: { authorization: `Bearer ${TOKEN}` } })).status).toBe(404);
});

test("an MCP client with the token can list tools, repeatedly", async () => {
  for (let i = 0; i < 2; i++) {
    const client = new Client({ name: "test", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: `Bearer ${TOKEN}` } } }));
    expect((await client.listTools()).tools.map((t) => t.name)).toContain("get_status");
    await client.close();
  }
});

test("HTTP mode refuses to start without a strong token or with a bad port", () => {
  const env = { PRINTER_HOST: "192.168.1.50" };
  expect(loadConfig(env).httpPort).toBeUndefined();
  expect(() => loadConfig({ ...env, MCP_HTTP_PORT: "8765" })).toThrow("MCP_AUTH_TOKEN");
  expect(() => loadConfig({ ...env, MCP_HTTP_PORT: "8765", MCP_AUTH_TOKEN: "short" })).toThrow("MCP_AUTH_TOKEN");
  expect(() => loadConfig({ ...env, MCP_HTTP_PORT: "99999", MCP_AUTH_TOKEN: TOKEN })).toThrow("MCP_HTTP_PORT");
  expect(loadConfig({ ...env, MCP_HTTP_PORT: "8765", MCP_AUTH_TOKEN: TOKEN })).toMatchObject({ httpPort: 8765, authToken: TOKEN });
});
