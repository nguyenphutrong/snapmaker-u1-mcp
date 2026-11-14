import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createHash, timingSafeEqual } from "node:crypto";

const sha256 = (s: string) => createHash("sha256").update(s).digest();

/**
 * Streamable HTTP on /mcp, guarded by `Authorization: Bearer <token>`.
 * Stateless: every request gets a fresh server and transport, which the SDK requires without sessions.
 */
export function serveHttp(port: number, token: string, buildServer: () => McpServer) {
  const expected = sha256(token);
  return Bun.serve({
    port,
    async fetch(req) {
      if (new URL(req.url).pathname !== "/mcp") return new Response("Not Found", { status: 404 });
      const given = req.headers.get("authorization")?.match(/^Bearer (.+)$/i)?.[1] ?? "";
      // Hashing first gives equal lengths, so the comparison does not leak the token's length or prefix.
      if (!timingSafeEqual(sha256(given), expected))
        return new Response("Unauthorized", { status: 401, headers: { "WWW-Authenticate": "Bearer" } });

      const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      await buildServer().connect(transport);
      return transport.handleRequest(req);
    },
  });
}
