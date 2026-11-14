import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { z } from "zod";
import { confirm, preview, say } from "./write.ts";

const expand = (p: string) => resolve(p.replace(/^~(?=\/|$)/, homedir()));

export function registerSliceTool(server: McpServer, cliPath: string) {
  server.registerTool(
    "slice_model",
    {
      description:
        "Slice an STL/3MF with Snapmaker Orca and return the path of the generated G-code on this computer (send it with upload_file). " +
        "Presets are Orca JSON files, e.g. ~/Library/Application Support/Snapmaker_Orca/system/Snapmaker/machine/Snapmaker U1 (0.4 nozzle).json, " +
        "process/0.20mm Standard @Snapmaker U1 (0.4 nozzle).json, filament/Generic PLA @U1 base.json. " +
        "An STL needs machine and process presets; a 3MF project may omit them to use its own settings.",
      inputSchema: {
        model_path: z.string().min(1).describe("Absolute path to the .stl or .3mf"),
        machine_preset: z.string().optional(),
        process_preset: z.string().optional(),
        filament_presets: z.array(z.string()).default([]).describe("One per filament used, in extruder order"),
        confirm,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ model_path, machine_preset, process_preset, filament_presets, confirm }) => {
      const model = expand(model_path);
      const machine = machine_preset && expand(machine_preset);
      let proc = process_preset && expand(process_preset);
      const filaments = filament_presets.map(expand);
      for (const f of [model, machine, proc, ...filaments])
        if (f && !(await Bun.file(f).exists())) throw new Error(`File not found: ${f}`);

      const names = [machine, proc, ...filaments].filter((f): f is string => !!f).map((f) => basename(f, ".json"));
      if (!confirm) return preview(`slice ${model} with ${names.length ? names.join(" + ") : "the settings stored in the file"}`);

      const outDir = await mkdtemp(join(tmpdir(), "u1-slice-"));
      const work = await mkdtemp(join(tmpdir(), "u1-preset-"));
      try {
        if (proc) {
          // Snapmaker Orca 01.10.01.50's CLI segfaults on wipe_tower_filament, which every U1 system process preset sets.
          const preset = await Bun.file(proc).json();
          if ("wipe_tower_filament" in preset) {
            delete preset.wipe_tower_filament;
            proc = join(work, basename(proc));
            await Bun.write(proc, JSON.stringify(preset));
          }
        }
        const settings = [machine, proc].filter((f): f is string => !!f);
        const child = Bun.spawn(
          [
            cliPath,
            "--slice", "0",
            "--outputdir", outDir,
            ...(settings.length ? ["--load-settings", settings.join(";")] : []),
            ...(filaments.length ? ["--load-filaments", filaments.join(";")] : []),
            model,
          ],
          { stdout: "pipe", stderr: "pipe", timeout: 600_000 },
        );
        const log = (await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])).join("\n");
        await child.exited;
        const gcodes = (await readdir(outDir)).filter((f) => f.endsWith(".gcode")).map((f) => join(outDir, f));
        if (child.exitCode !== 0 || !gcodes.length) {
          const lines = log.split("\n").filter((l) => l.trim());
          const errors = lines.filter((l) => /error/i.test(l));
          throw new Error(
            `Slicing failed (${child.signalCode ?? `exit code ${child.exitCode}`}).\n${(errors.length ? errors : lines).slice(-5).join("\n")}`,
          );
        }
        return say(`Sliced. G-code on this computer:\n${gcodes.join("\n")}\nSend it to the printer with upload_file.`);
      } finally {
        await rm(work, { recursive: true, force: true });
      }
    },
  );
}
