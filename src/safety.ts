import type { Config } from "./config.ts";

/** Commands that can corrupt config, reboot firmware mid-print, or move axes past their limits. */
export const DANGEROUS_COMMANDS = [
  "FIRMWARE_RESTART",
  "RESTART",
  "SAVE_CONFIG",
  "SET_KINEMATIC_POSITION",
  "FORCE_MOVE",
  "SET_VELOCITY_LIMIT",
];

type Limits = Pick<Config, "maxHotendTemp" | "maxBedTemp" | "allowDangerousGcode">;

/**
 * Throws when a G-code script uses a blocked command or sets a temperature above the configured limits.
 * Parsing follows Klipper: case-insensitive, `;` comments, `M104S300` is the same as `M104 S300`.
 * ponytail: temperature parameters of vendor macros (e.g. AUTO_FEEDING_PREHEAT) are not inspected;
 * Klipper's own max_temp from printer.cfg is the backstop for those.
 */
export function assertSafeGcode(script: string, limits: Limits) {
  for (const raw of script.split("\n")) {
    const line = raw.replace(/;.*/, "").trim().toUpperCase().replace(/^N\d+\s*/, "");
    if (!line) continue;

    const traditional = line.match(/^([GMT])\s*(\d+)/);
    const cmd = traditional ? `${traditional[1]}${Number(traditional[2])}` : line.split(/\s/)[0]!;
    const rest = traditional ? line.slice(traditional[0].length) : line.slice(cmd.length);

    if (DANGEROUS_COMMANDS.includes(cmd) && !limits.allowDangerousGcode)
      throw new Error(`"${cmd}" is blocked. Set ALLOW_DANGEROUS_GCODE=true to allow it.`);

    const check = (value: string | undefined, kind: "hotend" | "bed", source: string) => {
      if (value === undefined) return;
      const t = Number(value.replace(/^"|"$/g, ""));
      const max = kind === "bed" ? limits.maxBedTemp : limits.maxHotendTemp;
      if (!Number.isFinite(t)) throw new Error(`Invalid temperature "${value}" in "${raw.trim()}"`);
      if (t > max) throw new Error(`${source}: ${t}°C exceeds the ${kind} limit of ${max}°C (MAX_${kind === "bed" ? "BED" : "HOTEND"}_TEMP).`);
    };

    if (/^M(104|109|140|190)$/.test(cmd)) {
      const params = Object.fromEntries([...rest.matchAll(/([A-Z])\s*([^A-Z\s]*)/g)].map((m) => [m[1], m[2]]));
      const kind = cmd === "M140" || cmd === "M190" ? "bed" : "hotend";
      check(params.S, kind, cmd);
      check(params.R, kind, cmd);
    } else if (cmd === "SET_HEATER_TEMPERATURE" || cmd === "PID_CALIBRATE" || cmd === "TEMPERATURE_WAIT") {
      const params = Object.fromEntries([...rest.matchAll(/(\w+)\s*=\s*("[^"]*"|\S+)/g)].map((m) => [m[1], m[2]]));
      const target = (params.HEATER ?? params.SENSOR ?? "").replace(/"/g, "");
      const kind = target === "HEATER_BED" ? "bed" : "hotend";
      check(cmd === "TEMPERATURE_WAIT" ? params.MINIMUM : params.TARGET, kind, cmd);
    }
  }
}
