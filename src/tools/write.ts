import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { homedir } from "node:os";
import { basename, resolve } from "node:path";
import { z } from "zod";
import type { Config } from "../config.ts";
import type { Moonraker } from "../moonraker.ts";
import { assertSafeGcode } from "../safety.ts";

export const confirm = z
  .boolean()
  .default(false)
  .describe("Must be true to execute. Otherwise nothing is sent and the tool only describes what it would do.");
export const say = (text: string) => ({ content: [{ type: "text" as const, text }] });
export const preview = (action: string) => say(`Not executed. This would ${action}.\nCall again with confirm: true to proceed.`);
const write = { readOnlyHint: false, destructiveHint: true, openWorldHint: true };

export function registerWriteTools(server: McpServer, mr: Moonraker, cfg: Config) {
  const job = async () =>
    (await mr.get<{ status: { print_stats: { state: string; filename: string } } }>("/printer/objects/query?print_stats")).status.print_stats;
  // G-code scripts block until done; heating or homing can take minutes.
  const runGcode = (script: string) => mr.post("/printer/gcode/script", { script }, 300_000);

  server.registerTool(
    "upload_file",
    {
      description:
        "Upload a G-code file from this computer to the printer's gcodes folder. Overwrites a file with the same name. " +
        "The printer cannot print STL/3MF; slice them first.",
      inputSchema: {
        local_path: z.string().min(1).describe("Absolute path on this computer"),
        remote_dir: z.string().default("").describe("Optional subfolder inside gcodes"),
        confirm,
      },
      annotations: write,
    },
    async ({ local_path, remote_dir, confirm }) => {
      const path = resolve(local_path.replace(/^~(?=\/|$)/, homedir()));
      const file = Bun.file(path);
      // The U1's Moonraker only lists and prints these extensions from gcodes (VALID_GCODE_EXTS).
      if (!/\.(gcode|g|gco|ufp)$/i.test(path)) throw new Error(`Only G-code files (.gcode, .g, .gco, .ufp) can be uploaded: ${path}`);
      if (!(await file.exists())) throw new Error(`Local file not found: ${path}`);
      const dir = remote_dir.replace(/^\/+|\/+$/g, "");
      const remote = dir ? `${dir}/${basename(path)}` : basename(path);
      if (!confirm) {
        const exists = (await mr.listFiles("gcodes")).some((f) => f.path === remote);
        const mb = Math.round(file.size / 1e5) / 10;
        return preview(`upload ${path} (${mb} MB) to gcodes/${remote}${exists ? ", OVERWRITING the file already there" : ""}`);
      }
      const form = new FormData();
      form.append("file", file, basename(path));
      form.append("root", "gcodes");
      if (dir) form.append("path", dir);
      const { item } = await mr.post<{ item: { path: string } }>("/server/files/upload", form, 600_000);
      return say(`Uploaded to gcodes/${item.path}`);
    },
  );

  server.registerTool(
    "start_print",
    {
      description: "Start printing a file already on the printer (see list_files). Refused while another print is running or paused.",
      inputSchema: { filename: z.string().min(1).describe("Path inside gcodes, as returned by list_files"), confirm },
      annotations: write,
    },
    async ({ filename, confirm }) => {
      const { state, filename: current } = await job();
      if (state === "printing" || state === "paused")
        throw new Error(`Printer is busy (${state}: ${current}). Wait for it to finish or cancel it first.`);
      if (!confirm) return preview(`start printing gcodes/${filename}`);
      await mr.post("/printer/print/start", { filename });
      return say(`Print started: ${filename}`);
    },
  );

  const controls = [
    ["pause_print", "pause", ["printing"]],
    ["resume_print", "resume", ["paused"]],
    ["cancel_print", "cancel", ["printing", "paused"]],
  ] as const;
  for (const [name, verb, allowed] of controls) {
    server.registerTool(
      name,
      { description: `${verb[0]!.toUpperCase()}${verb.slice(1)} the current print.`, inputSchema: { confirm }, annotations: write },
      async ({ confirm }) => {
        const { state, filename } = await job();
        if (!(allowed as readonly string[]).includes(state)) throw new Error(`Cannot ${verb}: printer is ${state}, expected ${allowed.join(" or ")}.`);
        if (!confirm) return preview(`${verb} the print of ${filename} (currently ${state})`);
        await mr.post(`/printer/print/${verb}`);
        return say(`Print ${verb} requested for ${filename}.`);
      },
    );
  }

  server.registerTool(
    "set_temperature",
    {
      description: `Set the target temperature of one heater; 0 turns it off. Limits: hotend ${cfg.maxHotendTemp}°C, bed ${cfg.maxBedTemp}°C.`,
      inputSchema: {
        heater: z.string().describe("Heater name from get_status, e.g. extruder, extruder1, extruder2, extruder3, heater_bed"),
        target: z.number().min(0).describe("°C"),
        confirm,
      },
      annotations: write,
    },
    async ({ heater, target, confirm }) => {
      const { heaters } = (await mr.get<{ status: { heaters: { available_heaters: string[] } } }>("/printer/objects/query?heaters")).status;
      if (!heaters.available_heaters.includes(heater))
        throw new Error(`Unknown heater "${heater}". Available: ${heaters.available_heaters.join(", ")}`);
      const script = `SET_HEATER_TEMPERATURE HEATER=${heater} TARGET=${target}`;
      assertSafeGcode(script, cfg);
      if (!confirm) return preview(target === 0 ? `turn ${heater} off` : `heat ${heater} to ${target}°C`);
      await runGcode(script);
      return say(`${heater} target set to ${target}°C.`);
    },
  );

  server.registerTool(
    "send_gcode",
    {
      description: `Send raw G-code (one command per line). Commands that can damage config or exceed axis limits are blocked${
        cfg.allowDangerousGcode ? " (currently ALLOWED by ALLOW_DANGEROUS_GCODE)" : ""
      }, and temperatures above the configured limits are refused.`,
      inputSchema: { script: z.string().min(1), confirm },
      annotations: write,
    },
    async ({ script, confirm }) => {
      assertSafeGcode(script, cfg);
      if (!confirm) {
        const { state, filename } = await job();
        return preview(`send to the printer (${state === "printing" ? `PRINTING ${filename}` : state}):\n${script}`);
      }
      await runGcode(script);
      return say("G-code sent.");
    },
  );
}
