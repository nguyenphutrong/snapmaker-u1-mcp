import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { Moonraker } from "../src/moonraker.ts";
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
  await Bun.write(join(dir, "model.3mf"), "x");
  expect(text(await call("upload_file", { local_path: join(dir, "model.3mf"), confirm: true }))).toContain("Only G-code files");
  expect(mock.state.bodies).toHaveLength(1);
});
