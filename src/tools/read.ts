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
        "Printer state, current file, progress %, elapsed and estimated remaining print time, layer, and the current/target temperature of every toolhead, the bed and the chamber.",
      annotations: readOnly,
    },
    async () => {
      // The U1 has four toolheads; read the sensor list instead of assuming extruder..extruder3.
      const { heaters } = (await mr.get<{ status: { heaters: { available_sensors: string[] } } }>("/printer/objects/query?heaters")).status;
      const sensors = heaters.available_sensors;
      const query = ["print_stats", "display_status", ...sensors].map(encodeURIComponent).join("&");
      const s = (await mr.get<{ status: Record<string, any> }>(`/printer/objects/query?${query}`)).status;
      const job = s.print_stats;
      const progress: number = s.display_status.progress ?? 0;
      return json({
        state: job.state,
        message: job.message || undefined,
        filename: job.filename || null,
        progress_percent: Math.round(progress * 1000) / 10,
        layer: job.info?.total_layer ? `${job.info.current_layer}/${job.info.total_layer}` : undefined,
        elapsed: duration(job.print_duration),
        // ponytail: linear extrapolation from print time; read the slicer's estimated_time from file metadata if this proves too rough.
        remaining: progress > 0 && progress < 1 ? duration(job.print_duration / progress - job.print_duration) : null,
        temperatures: Object.fromEntries(
          sensors.map((name) => [name, { current: Math.round(s[name].temperature * 10) / 10, target: s[name].target }]),
        ),
      });
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
