import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { registerSliceTool } from "../src/tools/slice.ts";
import { connect } from "./mock-moonraker.ts";

let dir: string;
let slice: Awaited<ReturnType<typeof connect>>;
const text = (r: { content: any[] }) => r.content.map((b) => b.text).join("\n") as string;
const gcodePaths = (r: { content: any[] }) => text(r).split("\n").filter((l) => l.endsWith(".gcode"));
const record = async (r: { content: any[] }) => JSON.parse(await readFile(join(dirname(gcodePaths(r)[0]!), "record.json"), "utf8"));

/**
 * Fake Orca CLI. Like the real one it does not follow "inherits", echoes the settings it used into
 * each plate's G-code header and silently drops settings it does not know (here: no_such_key).
 */
const FAKE_ORCA = `#!/usr/bin/env bun
const argv = process.argv.slice(2);
const opt = (name) => { const i = argv.indexOf(name); return i < 0 ? undefined : argv[i + 1]; };
const out = opt("--outputdir"), model = argv.at(-1);
const read = (p) => JSON.parse(require("fs").readFileSync(p, "utf8"));
const settings = (opt("--load-settings") ?? "").split(";").filter(Boolean).map(read);
const filaments = (opt("--load-filaments") ?? "").split(";").filter(Boolean).map(read);
let project;
if (model.endsWith(".3mf")) project = JSON.parse(Bun.spawnSync(["unzip", "-p", model, "Metadata/project_settings.config"]).stdout.toString());
require("fs").writeFileSync(out + "/record.json", JSON.stringify({ argv, settings, filaments, project }));
if (model.includes("bad")) { console.log("[error] run 2335: process not compatible with printer."); process.exit(239); }
const config = Object.assign({}, ...settings, ...filaments);
delete config.no_such_key;
const grams = model.includes("empty") || config.filament_density === undefined ? 0 : 8.58;
const header = (g) => ["; total filament used [g] = " + g, "; estimated printing time (normal mode) = 21m 45s",
  ...Object.entries(config).map(([k, v]) => "; " + k + " = " + (Array.isArray(v) ? v.join(",") : v))].join("\\n") + "\\nG28\\n";
for (const n of model.endsWith(".3mf") ? [10, 2] : [1]) require("fs").writeFileSync(out + "/plate_" + n + ".gcode", header(grams + n - 1));
`;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "u1-slice-test-"));
  // Two vendors define "fdm_filament_common"; a Snap preset must inherit Snap's, not that of "Aaa", which is indexed first.
  const profiles = join(dir, "profiles");
  const preset = async (vendor: string, kind: string, name: string, body: object, bom = false) => {
    const sub_path = `${kind}/${name}.json`;
    await mkdir(join(profiles, vendor, kind), { recursive: true });
    await Bun.write(join(profiles, vendor, sub_path), (bom ? "\uFEFF" : "") + JSON.stringify({ name, ...body }));
    const index = join(profiles, `${vendor}.json`);
    const lists = (await Bun.file(index).exists()) ? await Bun.file(index).json() : {};
    (lists[`${kind}_list`] ??= []).push({ name, sub_path });
    await Bun.write(index, JSON.stringify(lists));
  };
  await preset("Aaa", "filament", "fdm_filament_common", { filament_density: ["9.99"], nozzle_temperature: ["999"] });
  await preset("Snap", "machine", "fdm_U1", { instantiation: "false", printer_model: "Snapmaker U1", nozzle_diameter: ["0.4"] });
  await preset("Snap", "machine", "Snapmaker U1 (0.4 nozzle)", { inherits: "fdm_U1", instantiation: "true", printer_variant: "0.4" });
  await preset("Snap", "process", "fdm_process_U1", { instantiation: "false", wall_loops: "2", wipe_tower_filament: "0", layer_height: "0.2", compatible_printers: [] });
  await preset("Snap", "process", "0.20mm Standard", { inherits: "fdm_process_U1", instantiation: "true", compatible_printers: ["Snapmaker U1 (0.4 nozzle)"] }, true);
  await preset("Snap", "filament", "fdm_filament_common", { filament_density: ["1.24"], nozzle_temperature: ["200"], hot_plate_temp: ["45"] });
  await preset("Snap", "filament", "Generic PLA @U1 base", { inherits: "fdm_filament_common", instantiation: "false" });
  await preset("Snap", "filament", "Generic PLA", { inherits: "Generic PLA @U1 base", instantiation: "true", nozzle_temperature: ["220"], hot_plate_temp: ["65"] });
  await preset("Snap", "filament", "Black PLA", { inherits: "Generic PLA", filament_colour: ["#000000"] });

  const cli = join(dir, "orca");
  await Bun.write(cli, FAKE_ORCA);
  await chmod(cli, 0o755);
  for (const f of ["part.stl", "bad.stl", "empty.stl"]) await Bun.write(join(dir, f), "solid x");
  const project = join(dir, "proj");
  await mkdir(join(project, "Metadata"), { recursive: true });
  await Bun.write(join(project, "Metadata/project_settings.config"), JSON.stringify({ filament_colour: ["#FCECD6", "#E8AFCF"], layer_height: "0.2" }));
  Bun.spawnSync(["zip", "-q", "-r", join(dir, "skull.3mf"), "."], { cwd: project });

  slice = await connect((s) => registerSliceTool(s, cli, [profiles]));
});
afterAll(() => rm(dir, { recursive: true, force: true }));

const stl = { machine_preset: "Snapmaker U1 (0.4 nozzle)", process_preset: "0.20mm Standard", filament_presets: ["Generic PLA"] };

test("presets are flattened through inherits (same vendor first, BOM tolerated) before reaching the CLI", async () => {
  const r = await slice("slice_model", { ...stl, model_path: join(dir, "part.stl"), confirm: true });
  expect(r.isError).toBeFalsy();
  const { argv, settings, filaments } = await record(r);
  const [machine, proc] = settings;
  expect(machine).toMatchObject({ name: "Snapmaker U1 (0.4 nozzle)", printer_model: "Snapmaker U1", nozzle_diameter: ["0.4"], from: "system", instantiation: "true" });
  expect(machine.inherits).toBeUndefined();
  expect(proc).toMatchObject({ name: "0.20mm Standard", wall_loops: "2", layer_height: "0.2" });
  expect(proc.wipe_tower_filament).toBeUndefined(); // segfaults Orca 01.10.01.50
  expect(filaments).toEqual([expect.objectContaining({ name: "Generic PLA", filament_density: ["1.24"], nozzle_temperature: ["220"], hot_plate_temp: ["65"] })]);
  expect(argv).not.toContain("--allow-newer-file");
  expect(text(r)).toContain("21m 45s, 8.58 g, nozzle 220 °C");
});

test("overrides change process settings, coerced to Orca's string format, and unapplied ones are reported", async () => {
  const overrides = { wall_loops: 4, sparse_infill_density: "40%", enable_support: true, layer_height: 0.16, no_such_key: 1 };
  const r = await slice("slice_model", { ...stl, model_path: join(dir, "part.stl"), overrides, confirm: true });
  expect(r.isError).toBeFalsy();
  const proc = (await record(r)).settings[1];
  expect(proc).toMatchObject({ wall_loops: "4", sparse_infill_density: "40%", enable_support: "1", layer_height: "0.16" });
  expect(text(r)).toContain("overrides not applied: no_such_key=1 (G-code has no such setting)");
  expect(text(r)).not.toContain("wall_loops=4");
});

test("an abstract base preset is refused with the printable presets that inherit from it", async () => {
  const r = await slice("slice_model", { ...stl, filament_presets: ["Generic PLA @U1 base"], model_path: join(dir, "part.stl"), confirm: true });
  expect(r.isError).toBe(true);
  expect(text(r)).toContain('"Generic PLA @U1 base" is an abstract base');
  expect(text(r)).toContain('Use one of: "Generic PLA"');
});

test("G-code with 0 g of filament is an error, not a success", async () => {
  const r = await slice("slice_model", { ...stl, model_path: join(dir, "empty.stl"), confirm: true });
  expect(r.isError).toBe(true);
  expect(text(r)).toContain("no filament (plate_1.gcode: 0 g)");
});

test("a 3MF gets its filaments written into the project instead of --load-filaments, and plates come back in order", async () => {
  const r = await slice("slice_model", {
    model_path: join(dir, "skull.3mf"),
    ...stl,
    filament_presets: ["Black PLA", "Generic PLA", "Generic PLA", "Generic PLA"],
    confirm: true,
  });
  expect(r.isError).toBeFalsy();
  const { argv, filaments, project } = await record(r);
  expect(argv).toContain("--allow-newer-file");
  expect(argv).not.toContain("--load-filaments");
  expect(filaments).toEqual([]);
  expect(project.filament_settings_id).toEqual(["Black PLA", "Generic PLA", "Generic PLA", "Generic PLA"]);
  // Orca counts filaments by filament_colour: the preset colour wins, then the project's, padded to 4.
  expect(project.filament_colour).toEqual(["#000000", "#E8AFCF", "#FCECD6", "#FCECD6"]);
  expect(project.nozzle_temperature).toEqual(["220", "220", "220", "220"]);
  expect(gcodePaths(r).map((p) => p.split("/").at(-1))).toEqual(["plate_2.gcode", "plate_10.gcode"]);
});

test("CLI failures are reported with Orca's error line", async () => {
  const r = await slice("slice_model", { ...stl, model_path: join(dir, "bad.stl"), confirm: true });
  expect(r.isError).toBe(true);
  expect(text(r)).toContain("exit code 239");
  expect(text(r)).toContain("process not compatible with printer");
});

test("without confirm nothing is sliced", async () => {
  const r = await slice("slice_model", { ...stl, model_path: join(dir, "part.stl"), overrides: { wall_loops: 3 } });
  expect(text(r)).toContain("Not executed. This would slice");
  expect(text(r)).toContain("overriding wall_loops=3");
});
