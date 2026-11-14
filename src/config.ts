export type Config = ReturnType<typeof loadConfig>;

export function loadConfig(env: Record<string, string | undefined> = process.env) {
  const host = env.PRINTER_HOST?.trim();
  if (!host) throw new Error("PRINTER_HOST is required, e.g. http://192.168.1.50");
  let httpPort: number | undefined;
  let authToken: string | undefined;
  if (env.MCP_HTTP_PORT) {
    httpPort = Number(env.MCP_HTTP_PORT);
    if (!Number.isInteger(httpPort) || httpPort < 1 || httpPort > 65535)
      throw new Error(`MCP_HTTP_PORT must be a port number, got "${env.MCP_HTTP_PORT}"`);
    // HTTP mode exposes print and heater control to the network, so it never runs unauthenticated.
    authToken = env.MCP_AUTH_TOKEN?.trim();
    if (!authToken || authToken.length < 16)
      throw new Error("MCP_AUTH_TOKEN (at least 16 characters) is required when MCP_HTTP_PORT is set, e.g. `openssl rand -hex 32`");
  }
  return {
    httpPort,
    authToken,
    host: new URL(host.includes("://") ? host : `http://${host}`).origin,
    apiKey: env.MOONRAKER_API_KEY || undefined,
    orcaCliPath: env.ORCA_CLI_PATH || undefined,
    maxHotendTemp: positive(env, "MAX_HOTEND_TEMP", 300),
    maxBedTemp: positive(env, "MAX_BED_TEMP", 110),
    allowDangerousGcode: env.ALLOW_DANGEROUS_GCODE === "true",
  };
}

function positive(env: Record<string, string | undefined>, name: string, fallback: number) {
  const raw = env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  if (!(n > 0)) throw new Error(`${name} must be a positive number, got "${raw}"`);
  return n;
}
