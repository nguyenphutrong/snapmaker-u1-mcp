import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Moonraker } from "../moonraker.ts";

export const json = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });
const iso = (seconds: number | null) => (seconds ? new Date(seconds * 1000).toISOString() : null);
const duration = (seconds: number) => {
  const m = Math.round(seconds / 60);
  return `${Math.floor(m / 60)}h ${m % 60}m`;
};
const readOnly = { readOnlyHint: true, openWorldHint: true };

interface Job {
  filename: string;
  status: string;
  start_time: number;
  end_time: number | null;
  print_duration: number;
  filament_used: number;
}

export function registerReadTools(server: McpServer, mr: Moonraker) {
  server.registerTool(
    "get_status",
    {
      description:
        "Printer state, current file, progress by layer, elapsed and remaining print time, current errors/warnings, " +
        "the current/target temperature of every toolhead, the bed and the chamber, and each filament slot: loaded, type, colour, RFID spool data and feeder state.",
      annotations: readOnly,
    },
    async () => {
      // The U1 has four toolheads; read the heater list instead of assuming extruder..extruder3.
      type Heaters = { available_sensors: string[]; available_heaters: string[] };
      const { heaters } = (await mr.get<{ status: { heaters: Heaters } }>("/printer/objects/query?heaters")).status;
      const sensors = heaters.available_sensors;
      const slots = heaters.available_heaters.filter((h) => /^extruder\d*$/.test(h)).map((h) => Number(h.slice(8) || 0));
      const objects = [
        "print_stats", "display_status", "exception_manager", "print_task_config", "filament_detect", "filament_feed left", "filament_feed right",
        ...sensors, ...slots.map((i) => `filament_motion_sensor e${i}_filament`),
      ];
      const s = (await mr.get<{ status: Record<string, any> }>(`/printer/objects/query?${objects.map(encodeURIComponent).join("&")}`)).status;
      const job = s.print_stats;
      const active = job.state === "printing" || job.state === "paused";

      // display_status.progress follows the file read position, which runs far ahead of reality on the U1
      // (96% at layer 294/364). The slicer estimate, then layer count, track the remaining time much better.
      const meta = active && job.filename
        ? await mr.get<{ estimated_time?: number }>(`/server/files/metadata?filename=${encodeURIComponent(job.filename)}`).catch(() => undefined)
        : undefined;
      const { current_layer: layer, total_layer: layers } = job.info ?? {};
      const layerFraction = layers ? layer / layers : undefined;
      const remaining = !active
        ? null
        : meta?.estimated_time
          ? Math.max(0, meta.estimated_time - job.print_duration)
          : layerFraction
            ? job.print_duration / layerFraction - job.print_duration
            : null;

      const exceptions = [...(Object.keys(job.exception ?? {}).length ? [job.exception] : []), ...(s.exception_manager?.exceptions ?? [])];
      const feed = { ...s["filament_feed left"], ...s["filament_feed right"] };
      const cfg = s.print_task_config ?? {};
      return json({
        state: job.state,
        message: job.message || undefined,
        errors: exceptions.length ? exceptions : undefined,
        filename: job.filename || null,
        layer: layers ? `${layer}/${layers}` : undefined,
        progress_percent: Math.round((layerFraction ?? s.display_status.progress ?? 0) * 1000) / 10,
        elapsed: duration(job.print_duration),
        remaining: remaining === null ? null : duration(remaining),
        remaining_source: remaining === null ? undefined : meta?.estimated_time ? "slicer estimate" : "layers",
        temperatures: Object.fromEntries(
          sensors.map((name) => [name, { current: Math.round(s[name].temperature * 10) / 10, target: s[name].target }]),
        ),
        filaments: slots.map((i) => {
          const rfid = s.filament_detect?.info?.[i];
          return {
            slot: `T${i + 1}`,
            extruder: i ? `extruder${i}` : "extruder",
            detected: s[`filament_motion_sensor e${i}_filament`]?.filament_detected,
            type: [cfg.filament_type?.[i], cfg.filament_sub_type?.[i]].filter(Boolean).join(" ") || undefined,
            color: cfg.filament_color_rgba?.[i] ? `#${cfg.filament_color_rgba[i].slice(0, 6)}` : undefined,
            spool: rfid?.VENDOR
              ? {
                  vendor: rfid.VENDOR,
                  manufacturer: rfid.MANUFACTURER,
                  type: `${rfid.MAIN_TYPE} ${rfid.SUB_TYPE}`.trim(),
                  nominal_weight_g: rfid.WEIGHT, // RFID net weight of a full spool, not what is left
                  nozzle_temp: `${rfid.HOTEND_MIN_TEMP}-${rfid.HOTEND_MAX_TEMP}`,
                  bed_temp: rfid.BED_TEMP,
                }
              : undefined,
            feeder: feed[`extruder${i}`] ? { state: feed[`extruder${i}`].channel_state, error: feed[`extruder${i}`].channel_error } : undefined,
          };
        }),
      });
    },
  );

  server.registerTool(
    "get_console_log",
    {
      description:
        "Recent G-code console output: command responses, errors and warnings, oldest first. Feeder and filament-loading errors (e.g. wheel_speed) only appear here.",
      inputSchema: { count: z.number().int().min(1).max(1000).default(50) },
      annotations: readOnly,
    },
    async ({ count }) => {
      const { gcode_store } = await mr.get<{ gcode_store: { message: string; time: number; type: string }[] }>(`/server/gcode_store?count=${count}`);
      const lines = gcode_store.map((l) => `${new Date(l.time * 1000).toISOString()} ${l.type === "command" ? "> " : ""}${l.message}`);
      return { content: [{ type: "text" as const, text: lines.join("\n") || "(console is empty)" }] };
    },
  );

  server.registerTool(
    "list_files",
    {
      description: "List G-code files stored on the printer, newest first.",
      inputSchema: { limit: z.number().int().min(1).max(500).default(50) },
      annotations: readOnly,
    },
    async ({ limit }) => {
      const files = (await mr.listFiles("gcodes")).sort((a, b) => b.modified - a.modified);
      return json({
        total: files.length,
        files: files.slice(0, limit).map((f) => ({ path: f.path, size_mb: Math.round(f.size / 1e5) / 10, modified: iso(f.modified) })),
      });
    },
  );

  server.registerTool(
    "get_webcam_snapshot",
    { description: "Take a fresh photo from the printer's built-in camera.", annotations: readOnly },
    async () => {
      const { jpeg, capturedAt } = await mr.snapshot();
      return {
        content: [
          { type: "image" as const, data: Buffer.from(jpeg).toString("base64"), mimeType: "image/jpeg" },
          { type: "text" as const, text: `Captured at ${capturedAt.toISOString()}` },
        ],
      };
    },
  );

  server.registerTool(
    "get_print_history",
    {
      description: "Recent print jobs, newest first, with result, start/end time, print time and filament used.",
      inputSchema: { limit: z.number().int().min(1).max(100).default(10) },
      annotations: readOnly,
    },
    async ({ limit }) => {
      const { jobs } = await mr.get<{ jobs: Job[] }>(`/server/history/list?limit=${limit}&order=desc`);
      return json(
        jobs.map((j) => ({
          filename: j.filename,
          status: j.status,
          started: iso(j.start_time),
          ended: iso(j.end_time),
          print_time: duration(j.print_duration),
          filament_m: Math.round(j.filament_used / 10) / 100,
        })),
      );
    },
  );
}
