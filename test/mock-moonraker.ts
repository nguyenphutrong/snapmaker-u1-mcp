import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Moonraker } from "../src/moonraker.ts";
import { registerReadTools } from "../src/tools/read.ts";

export const JPEG = new Uint8Array([0xff, 0xd8, 1, 2, 3, 4, 0xff, 0xd9]);

/** Minimal stand-in for the U1's Moonraker, shaped after responses captured from a real printer. */
export function startMock() {
  const state = {
    requests: [] as string[],
    rpcCalls: [] as string[],
    objects: {} as Record<string, unknown>,
    files: [] as { path: string; modified: number; size: number }[],
    jobs: [] as unknown[],
    frameTime: 1000,
    truncatedReads: 0,
    failNext: 0,
    failStatus: 503,
    hang: false,
  };

  const server = Bun.serve({
    port: 0,
    async fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname === "/websocket") return srv.upgrade(req) ? undefined : new Response("no upgrade", { status: 400 });
      state.requests.push(`${req.method} ${url.pathname}${url.search}`);
      if (state.hang) await Bun.sleep(5_000);
      if (state.failNext > 0) {
        state.failNext--;
        return Response.json({ error: { code: state.failStatus, message: "Mock failure" } }, { status: state.failStatus });
      }
      const ok = (result: unknown) => Response.json({ result });
      switch (url.pathname) {
        case "/printer/objects/query":
          return ok({ status: Object.fromEntries([...url.searchParams.keys()].map((k) => [k, state.objects[k]])) });
        case "/server/files/list":
          return ok(url.searchParams.get("root") === "camera" ? [{ path: "monitor.jpg", modified: state.frameTime, size: JPEG.length }] : state.files);
        case "/server/files/camera/monitor.jpg":
          if (state.truncatedReads > 0) {
            state.truncatedReads--;
            return new Response(JPEG.slice(0, -2));
          }
          return new Response(JPEG);
        case "/server/history/list":
          return ok({ count: state.jobs.length, jobs: state.jobs });
      }
      return Response.json({ error: { code: 404, message: "Not Found" } }, { status: 404 });
    },
    websocket: {
      message(ws, raw) {
        const msg = JSON.parse(String(raw));
        state.rpcCalls.push(msg.method);
        if (msg.method === "camera.start_monitor") state.frameTime++;
        ws.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { state: "success" } }));
      },
    },
  });

  return { url: server.url.origin, state, stop: () => server.stop(true) };
}

/** Talks to the real MCP server over an in-memory transport, the same protocol Claude uses. */
export async function connect(mr: Moonraker) {
  const server = new McpServer({ name: "test", version: "0" });
  registerReadTools(server, mr);
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientSide);
  return async (name: string, args: Record<string, unknown> = {}) =>
    (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: any[] };
}
