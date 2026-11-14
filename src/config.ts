export type Config = ReturnType<typeof loadConfig>;

export function loadConfig(env: Record<string, string | undefined> = process.env) {
  const host = env.PRINTER_HOST?.trim();
  if (!host) throw new Error("PRINTER_HOST is required, e.g. http://192.168.1.50");
  return {
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
