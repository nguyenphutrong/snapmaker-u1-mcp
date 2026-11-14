import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { z } from "zod";
import { confirm, preview, say } from "./write.ts";

type Kind = "machine" | "process" | "filament";
type Preset = Record<string, unknown>;
type Value = string | number | boolean | string[];

const expand = (p: string) => resolve(p.replace(/^~(?=\/|$)/, homedir()));
// Bun strips the UTF-8 BOM some Orca system presets start with.
const load = (path: string): Promise<Preset> => Bun.file(path).json();
const str = (v: Value) => (typeof v === "boolean" ? (v ? "1" : "0") : String(v));

/**
 * Orca system presets only store the keys that differ from their parent ("inherits"), and the CLI
 * does not follow that chain: a bare U1 preset slices with default temperatures and 0 g of filament.
 * Profile roots hold one <vendor>.json index per vendor listing every preset's name and sub_path.
 * Earlier roots win, so the user's OTA-updated presets beat the ones bundled with the app.
 */
export async function presetIndex(roots: string[]) {
  const index = new Map<string, { vendor: string; path: string }[]>();
  for (const root of roots.filter((r) => existsSync(r)))
    for (const file of (await readdir(root)).filter((f) => f.endsWith(".json")).sort()) {
      const vendor = basename(file, ".json");
      const lists = (await load(join(root, file))) as Record<string, { name: string; sub_path: string }[] | undefined>;
      for (const kind of ["machine", "process", "filament"] as const)
        for (const { name, sub_path } of lists[`${kind}_list`] ?? []) {
          const key = `${kind}/${name}`;
          index.set(key, [...(index.get(key) ?? []), { vendor, path: join(root, vendor, sub_path) }]);
        }
    }

  /** Resolves a preset given by name or JSON path into one self-contained preset the CLI can load. */
  return async function flatten(kind: Kind, ref: string): Promise<Preset> {
    const find = (name: string, vendor?: string) => {
      const hits = index.get(`${kind}/${name}`);
      return hits?.find((h) => h.vendor === vendor) ?? hits?.[0];
    };
    let entry: { vendor?: string; path: string } | undefined;
    if (ref.endsWith(".json") || ref.includes("/")) {
      const path = expand(ref);
      const segs = path.split(sep);
      entry = { path, vendor: segs[segs.lastIndexOf(kind) - 1] };
    } else entry = find(ref);
    if (!entry || !existsSync(entry.path)) throw new Error(`${kind} preset not found: ${ref}`);

    const chain = [await load(entry.path)];
    const own = chain[0]!;
    // Abstract bases such as "Generic PLA @U1 base" carry almost no settings; slicing with one gives default temperatures and 0 g.
    if (own.instantiation === "false") {
      const dir = dirname(entry.path);
      const siblings = await Promise.all((await readdir(dir)).filter((f) => f.endsWith(".json")).map((f) => load(join(dir, f)).catch(() => ({}) as Preset)));
      const children = siblings.filter((p) => p.inherits === own.name && p.instantiation !== "false").map((p) => `"${p.name}"`);
      throw new Error(`${kind} preset "${own.name}" is an abstract base, not a printable preset.${children.length ? ` Use one of: ${children.join(", ")}.` : ""}`);
    }
    for (let vendor = entry.vendor; chain[0]!.inherits; ) {
      const parent = find(String(chain[0]!.inherits), vendor);
      if (!parent) throw new Error(`Cannot resolve "${chain[0]!.inherits}", inherited by ${kind} preset ${chain[0]!.name}`);
      if (chain.length > 20) throw new Error(`Inheritance loop in ${kind} preset ${ref}`);
      vendor = parent.vendor;
      chain.unshift(await load(parent.path));
    }
    const preset: Preset = Object.assign({}, ...chain, { from: "system", instantiation: "true" });
    delete preset.inherits;
    return preset;
  };
}

/** Reads "; key = value" header lines Orca writes into each plate's G-code. */
export function gcodeStats(gcode: string, overrides: Record<string, Value> = {}) {
  const field = (key: string) => gcode.match(new RegExp(`^; ${key.replace(/[[\]()]/g, "\\$&")} = (.*)$`, "m"))?.[1]?.trim();
  return {
    time: field("estimated printing time (normal mode)"),
    grams: Number(field("total filament used [g]") ?? NaN),
    nozzle_temp: field("nozzle_temperature"),
    bed_type: field("curr_bed_type"),
    bed_temp: field("first_layer_bed_temperature"),
    // Orca echoes its full config into the G-code, so an override it did not apply shows up here.
    ignored: Object.entries(overrides)
      .filter(([k, v]) => field(k) !== (Array.isArray(v) ? v.map(str).join(",") : str(v)))
      .map(([k, v]) => `${k}=${JSON.stringify(v)} (G-code has ${field(k) ?? "no such setting"})`),
  };
}

const run = async (cmd: string[], cwd?: string) => {
  const child = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe", timeout: 600_000 });
  const log = (await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])).join("\n");
  await child.exited;
  return { log, code: child.exitCode, signal: child.signalCode };
};

/**
 * The CLI resets every object of a 3MF to extruder 1 when given --load-filaments. Writing the
 * filament presets into the project's own settings instead keeps each object's extruder.
 */
async function embedFilaments(model: string, work: string, filaments: Preset[]) {
  const dir = join(work, "3mf");
  await mkdir(dir);
  const unzip = await run(["unzip", "-q", model, "-d", dir]);
  if (unzip.code !== 0) throw new Error(`Cannot unpack ${model}: ${unzip.log.trim()}`);
  const configPath = join(dir, "Metadata", "project_settings.config");
  const project = existsSync(configPath) ? await load(configPath) : {};
  const colours = (project.filament_colour as string[] | undefined) ?? [];
  for (const [k, v] of Object.entries(filaments[0]!))
    if (Array.isArray(v) && v.length === 1) project[k] = filaments.map((f) => (f[k] as unknown[] | undefined)?.[0] ?? v[0]);
  project.filament_settings_id = filaments.map((f) => f.name);
  // Orca counts a project's filaments by filament_colour. Presets often lack it, so keep the project's colours, padded to length.
  project.filament_colour = filaments.map((f, i) => (f.filament_colour as string[] | undefined)?.[0] ?? colours[i] ?? colours[0] ?? "#FFFFFF");
  await Bun.write(configPath, JSON.stringify(project, null, 4));
  const out = join(work, basename(model));
  const zip = await run(["zip", "-q", "-r", "-X", out, "."], dir);
  if (zip.code !== 0) throw new Error(`Cannot repack ${model}: ${zip.log.trim()}`);
  return out;
}

export function registerSliceTool(
  server: McpServer,
  cliPath: string,
  roots = [join(homedir(), "Library/Application Support/Snapmaker_Orca/system"), resolve(dirname(cliPath), "../Resources/profiles")],
) {
  server.registerTool(
    "slice_model",
    {
      description:
        "Slice an STL/3MF with Snapmaker Orca and return, per plate, the G-code path on this computer, estimated print time and filament grams (send it with upload_file). " +
        'Presets are Orca preset names, e.g. machine "Snapmaker U1 (0.4 nozzle)", process "0.20mm Standard @Snapmaker U1 (0.4 nozzle)", ' +
        'filament "Snapmaker PLA SnapSpeed @U1" or "Generic PLA @U1 base", or paths to preset JSON files. Inherited settings are resolved automatically. ' +
        "An STL needs machine and process presets; a 3MF may omit them to use its own settings. " +
        "For a 3MF, filament presets are written into the project so each object keeps its extruder; 3MF files from newer Bambu/Orca versions are accepted.",
      inputSchema: {
        model_path: z.string().min(1).describe("Absolute path to the .stl or .3mf"),
        machine_preset: z.string().optional(),
        process_preset: z.string().optional(),
        filament_presets: z.array(z.string()).default([]).describe("One per extruder used, in extruder order (T1, T2, ...)"),
        overrides: z
          .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]))
          .default({})
          .describe(
            'Process settings to override, e.g. {"wall_loops": 3, "sparse_infill_density": "15%", "brim_width": 5, "enable_support": true}. ' +
              'U1 presets default to curr_bed_type "Cool Plate"; set "Textured PEI Plate" for the textured sheet.',
          ),
        confirm,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ model_path, machine_preset, process_preset, filament_presets, overrides, confirm }) => {
      const model = expand(model_path);
      if (!existsSync(model)) throw new Error(`File not found: ${model}`);
      const is3mf = model.toLowerCase().endsWith(".3mf");
      if (!is3mf && !(machine_preset && process_preset)) throw new Error("An STL needs machine_preset and process_preset.");
      if (Object.keys(overrides).length && !process_preset) throw new Error("overrides need a process_preset to apply to.");

      const flatten = await presetIndex(roots);
      const machine = machine_preset ? await flatten("machine", machine_preset) : undefined;
      const proc = process_preset ? await flatten("process", process_preset) : undefined;
      const filaments = await Promise.all(filament_presets.map((f) => flatten("filament", f)));

      if (proc)
        for (const [k, v] of Object.entries(overrides))
          proc[k] = Array.isArray(v) ? v.map(str) : Array.isArray(proc[k]) ? [str(v)] : str(v);
      // Snapmaker Orca 01.10.01.50's CLI segfaults on wipe_tower_filament, which every U1 process preset inherits.
      if (proc) delete proc.wipe_tower_filament;

      const names = [machine, proc, ...filaments].filter((p) => p).map((p) => p!.name);
      const changes = Object.entries(overrides).map(([k, v]) => `${k}=${JSON.stringify(v)}`);
      if (!confirm)
        return preview(
          `slice ${model} with ${names.length ? names.join(" + ") : "the settings stored in the file"}${changes.length ? `, overriding ${changes.join(", ")}` : ""}`,
        );

      const outDir = await mkdtemp(join(tmpdir(), "u1-slice-"));
      const work = await mkdtemp(join(tmpdir(), "u1-preset-"));
      try {
        const write = async (name: string, p: Preset) => (await Bun.write(join(work, name), JSON.stringify(p)), join(work, name));
        const settings = [machine && (await write("machine.json", machine)), proc && (await write("process.json", proc))].filter(
          (f): f is string => !!f,
        );
        const fils = await Promise.all(filaments.map((f, i) => write(`filament${i + 1}.json`, f)));
        const input = is3mf && filaments.length ? await embedFilaments(model, work, filaments) : model;
        const { log, code, signal } = await run([
          cliPath,
          "--slice", "0",
          "--outputdir", outDir,
          ...(is3mf ? ["--allow-newer-file"] : []),
          ...(settings.length ? ["--load-settings", settings.join(";")] : []),
          ...(fils.length && !is3mf ? ["--load-filaments", fils.join(";")] : []),
          input,
        ]);
        const gcodes = (await readdir(outDir))
          .filter((f) => f.endsWith(".gcode"))
          .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
          .map((f) => join(outDir, f));
        if (code !== 0 || !gcodes.length) {
          const lines = log.split("\n").filter((l) => l.trim());
          const errors = lines.filter((l) => /error/i.test(l));
          throw new Error(`Slicing failed (${signal ?? `exit code ${code}`}).\n${(errors.length ? errors : lines).slice(-5).join("\n")}`);
        }

        const plates = await Promise.all(gcodes.map(async (path) => ({ path, ...gcodeStats(await Bun.file(path).text(), overrides) })));
        const empty = plates.filter((p) => !(p.grams > 0));
        if (empty.length)
          throw new Error(
            `Slicing produced G-code with no filament (${empty.map((p) => `${basename(p.path)}: ${p.grams} g`).join(", ")}). ` +
              "The presets were probably not applied; check machine/process/filament names.",
          );
        const lines = plates.map((p) => `${p.path}\n  ${p.time}, ${p.grams} g, nozzle ${p.nozzle_temp} °C, bed ${p.bed_temp} °C (${p.bed_type})`);
        const ignored = [...new Set(plates.flatMap((p) => p.ignored))];
        const warn = ignored.length ? `\nWarning: overrides not applied: ${ignored.join("; ")}` : "";
        return say(`Sliced with ${names.join(" + ") || "the file's settings"}.\n${lines.join("\n")}${warn}\nSend a plate to the printer with upload_file.`);
      } finally {
        await rm(work, { recursive: true, force: true });
      }
    },
  );
}
