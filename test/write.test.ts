import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { Moonraker } from "../src/moonraker.ts";
import { registerSliceTool } from "../src/tools/slice.ts";
import { registerWriteTools } from "../src/tools/write.ts";
import { connect, startMock } from "./mock-moonraker.ts";

let mock: ReturnType<typeof startMock>;
let call: Awaited<ReturnType<typeof connect>>;
let dir: string;
const text = (r: { content: any[] }) => r.content.map((b) => b.text).join("\n") as string;
const posts = () => mock.state.requests.filter((r) => r.startsWith("POST"));
const printing = () => (mock.state.objects.print_stats = { state: "printing", filename: "skull.gcode" });
const idle = () => (mock.state.objects.print_stats = { state: "standby", filename: "" });

beforeEach(async () => {
  mock = startMock();
  dir = await mkdtemp(join(tmpdir(), "u1-test-"));
  mock.state.objects.heaters = { available_heaters: ["heater_bed", "extruder", "extruder1", "extruder2", "extruder3"] };
  idle();
  const mr = new Moonraker(mock.url, undefined, 500);
  call = await connect((s) => registerWriteTools(s, mr, loadConfig({ PRINTER_HOST: mock.url })));
});
afterEach(async () => {
  mock.stop();
  await rm(dir, { recursive: true, force: true });
});

test("without confirm: true no write tool sends anything", async () => {
  await Bun.write(join(dir, "a.gcode"), "G28");
  const calls: [string, Record<string, unknown>][] = [
    ["upload_file", { local_path: join(dir, "a.gcode") }],
    ["start_print", { filename: "a.gcode" }],
    ["set_temperature", { heater: "extruder1", target: 200, confirm: false }],
    ["send_gcode", { script: "G28" }],
  ];
  for (const [name, args] of calls) {
    const r = await call(name, args);
    expect(r.isError).toBeFalsy();
    expect(text(r)).toContain("Not executed");
  }
  printing();
  for (const name of ["pause_print", "cancel_print"]) expect(text(await call(name))).toContain("Not executed");
  expect(posts()).toEqual([]);
});

test("start_print is refused while printing or paused, even with confirm", async () => {
  for (const state of ["printing", "paused"]) {
    mock.state.objects.print_stats = { state, filename: "skull.gcode" };
    const r = await call("start_print", { filename: "a.gcode", confirm: true });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain(`Printer is busy (${state}: skull.gcode)`);
  }
  expect(posts()).toEqual([]);
});

test("start_print sends the filename when idle, and surfaces the fork's HTTP-200 refusal", async () => {
  expect(text(await call("start_print", { filename: "dir/a.gcode", confirm: true }))).toBe("Print started: dir/a.gcode");
  expect(mock.state.bodies).toEqual([{ filename: "dir/a.gcode" }]);
  mock.state.refuseStart = true;
  const r = await call("start_print", { filename: "a.gcode", confirm: true });
  expect(r.isError).toBe(true);
  expect(text(r)).toContain("Printer is not ready to start a new print job.");
});

test("pause/resume/cancel check the print state first", async () => {
  const r = await call("pause_print", { confirm: true });
  expect(r.isError).toBe(true);
  expect(text(r)).toContain("printer is standby");
  printing();
  expect((await call("resume_print", { confirm: true })).isError).toBe(true);
  expect((await call("pause_print", { confirm: true })).isError).toBeFalsy();
  expect(posts()).toEqual(["POST /printer/print/pause"]);
});

test("set_temperature validates heater and limit, then sends SET_HEATER_TEMPERATURE", async () => {
  expect(text(await call("set_temperature", { heater: "extruder4", target: 200, confirm: true }))).toContain("Unknown heater");
  expect(text(await call("set_temperature", { heater: "heater_bed", target: 111, confirm: true }))).toContain("exceeds the bed limit of 110");
  expect(text(await call("set_temperature", { heater: "extruder3", target: 301, confirm: true }))).toContain("exceeds the hotend limit of 300");
  expect(posts()).toEqual([]);
  await call("set_temperature", { heater: "extruder3", target: 250, confirm: true });
  expect(mock.state.bodies).toEqual([{ script: "SET_HEATER_TEMPERATURE HEATER=extruder3 TARGET=250" }]);
});

test("send_gcode blocks dangerous commands and hot temperatures before anything is sent", async () => {
  for (const script of ["FIRMWARE_RESTART", "G28\nM140 S150"]) {
    const r = await call("send_gcode", { script, confirm: true });
    expect(r.isError).toBe(true);
  }
  expect(posts()).toEqual([]);
  await call("send_gcode", { script: "G28\nM104 S210", confirm: true });
  expect(mock.state.bodies).toEqual([{ script: "G28\nM104 S210" }]);
});

test("a failed POST is not retried", async () => {
  mock.state.failNext = 1;
  const r = await call("send_gcode", { script: "G28", confirm: true });
  expect(r.isError).toBe(true);
  expect(text(r)).toContain("HTTP 503");
  expect(posts()).toHaveLength(1);
});

test("upload_file sends the file as multipart into gcodes, optionally into a subfolder", async () => {
  await Bun.write(join(dir, "part.gcode"), "G28\nG1 X10");
  mock.state.files = [{ path: "jobs/part.gcode", modified: 1, size: 1 }];
  expect(text(await call("upload_file", { local_path: join(dir, "part.gcode"), remote_dir: "/jobs/" }))).toContain("OVERWRITING");
  const r = await call("upload_file", { local_path: join(dir, "part.gcode"), remote_dir: "/jobs/", confirm: true });
  expect(text(r)).toBe("Uploaded to gcodes/jobs/part.gcode");
  expect(mock.state.bodies).toEqual([{ name: "part.gcode", text: "G28\nG1 X10", root: "gcodes", path: "jobs" }]);
  expect(text(await call("upload_file", { local_path: join(dir, "missing.gcode"), confirm: true }))).toContain("Local file not found");
});

test("slice_model passes presets to the CLI without the key that crashes it, and reports CLI failures", async () => {
  // Fake Orca CLI: copies the process preset it was given and writes one plate.
  const cli = join(dir, "orca.sh");
  await Bun.write(
    cli,
    `#!/bin/sh
while [ $# -gt 1 ]; do case "$1" in --outputdir) out="$2"; shift;; --load-settings) settings="$2"; shift;; --load-filaments) fil="$2"; shift;; esac; shift; done
[ "$1" = "${join(dir, "bad.stl")}" ] && { echo "[error] run 2335: process not compatible with printer."; exit 239; }
cp "\${settings#*;}" "$out/process.json"; echo "$fil" > "$out/filaments.txt"; echo G28 > "$out/plate_1.gcode"
`,
  );
  await chmod(cli, 0o755);
  for (const f of ["cube.stl", "bad.stl", "m.json", "f.json"]) await Bun.write(join(dir, f), "{}");
  await Bun.write(join(dir, "p.json"), JSON.stringify({ name: "0.20mm", wipe_tower_filament: "0", layer_height: "0.2" }));
  const slice = await connect((s) => registerSliceTool(s, cli));
  const args = { model_path: join(dir, "cube.stl"), machine_preset: join(dir, "m.json"), process_preset: join(dir, "p.json"), filament_presets: [join(dir, "f.json")] };

  expect(text(await slice("slice_model", args))).toContain("Not executed");
  const r = await slice("slice_model", { ...args, confirm: true });
  expect(r.isError).toBeFalsy();
  const gcode = text(r).split("\n").find((l) => l.endsWith("plate_1.gcode"))!;
  expect(await readFile(gcode, "utf8")).toBe("G28\n");
  expect(JSON.parse(await readFile(join(dirname(gcode), "process.json"), "utf8"))).toEqual({ name: "0.20mm", layer_height: "0.2" });
  expect(await readFile(join(dirname(gcode), "filaments.txt"), "utf8")).toBe(`${join(dir, "f.json")}\n`);
  await rm(dirname(gcode), { recursive: true });

  const bad = await slice("slice_model", { ...args, model_path: join(dir, "bad.stl"), confirm: true });
  expect(bad.isError).toBe(true);
  expect(text(bad)).toContain("exit code 239");
  expect(text(bad)).toContain("process not compatible with printer");
});
