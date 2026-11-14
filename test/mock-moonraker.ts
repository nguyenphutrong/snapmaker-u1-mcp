import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export const JPEG = new Uint8Array([0xff, 0xd8, 1, 2, 3, 4, 0xff, 0xd9]);

/** Minimal stand-in for the U1's Moonraker, shaped after responses captured from a real printer. */
export function startMock() {
  const state = {
    requests: [] as string[],
    rpcCalls: [] as string[],
    objects: {} as Record<string, unknown>,
    files: [] as { path: string; modified: number; size: number }[],
    jobs: [] as unknown[],
    bodies: [] as any[],
    refuseStart: false,
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
        case "/printer/print/start":
          state.bodies.push(await req.json());
          // Snapmaker's fork refuses with HTTP 200, not an error status.
          return ok(state.refuseStart ? { state: "error", message: "Printer is not ready to start a new print job." } : "ok");
        case "/printer/print/pause":
        case "/printer/print/resume":
        case "/printer/print/cancel":
          return ok("ok");
        case "/printer/gcode/script":
          state.bodies.push(await req.json());
          return ok("ok");
        case "/server/files/upload": {
          const form = await req.formData();
          const file = form.get("file") as File;
          const dir = form.get("path");
          state.bodies.push({ name: file.name, text: await file.text(), root: form.get("root"), path: dir });
          // Upload replies are not wrapped in "result".
          return Response.json({ item: { path: dir ? `${dir}/${file.name}` : file.name, root: "gcodes" }, action: "create_file" }, { status: 201 });
        }
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
export async function connect(register: (server: McpServer) => void) {
  const server = new McpServer({ name: "test", version: "0" });
  register(server);
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientSide);
  return async (name: string, args: Record<string, unknown> = {}) =>
    (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: any[] };
}
