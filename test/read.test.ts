import { afterEach, beforeEach, expect, test } from "bun:test";
import { Moonraker } from "../src/moonraker.ts";
import { registerReadTools } from "../src/tools/read.ts";
import { connect, JPEG, startMock } from "./mock-moonraker.ts";

let mock: ReturnType<typeof startMock>;
let call: Awaited<ReturnType<typeof connect>>;
const text = (r: { content: any[] }) => r.content.find((b) => b.type === "text").text as string;

beforeEach(async () => {
  mock = startMock();
  call = await connect((s) => registerReadTools(s, new Moonraker(mock.url, undefined, 500)));
});
afterEach(() => mock.stop());

const printing = () => ({
  heaters: {
    available_sensors: ["heater_bed", "extruder", "extruder3", "temperature_sensor cavity"],
    available_heaters: ["heater_bed", "extruder", "extruder3"],
  },
  // File position says 96% while only 294 of 364 layers are done, as seen on the real printer.
  print_stats: { state: "printing", filename: "a.gcode", print_duration: 3600, message: "", exception: {}, info: { total_layer: 364, current_layer: 91 } },
  display_status: { progress: 0.96 },
  heater_bed: { temperature: 65.04, target: 65 },
  extruder: { temperature: 41, target: 0 },
  extruder3: { temperature: 219.96, target: 220 },
  "temperature_sensor cavity": { temperature: 39 },
});

test("get_status reports every heater the printer lists, progress by layer and remaining time from the slicer estimate", async () => {
  mock.state.objects = printing();
  mock.state.metadata["a.gcode"] = { estimated_time: 3600 + 5400 };
  const s = JSON.parse(text(await call("get_status")));
  expect(s).toMatchObject({ state: "printing", progress_percent: 25, layer: "91/364", elapsed: "1h 0m", remaining: "1h 30m", remaining_source: "slicer estimate" });
  expect(s.errors).toBeUndefined();
  expect(s.temperatures).toEqual({
    heater_bed: { current: 65, target: 65 },
    extruder: { current: 41, target: 0 },
    extruder3: { current: 220, target: 220 },
    "temperature_sensor cavity": { current: 39 },
  });
});

test("get_status falls back to layers for remaining time when the file has no metadata", async () => {
  mock.state.objects = printing();
  const s = JSON.parse(text(await call("get_status")));
  expect(s).toMatchObject({ remaining: "3h 0m", remaining_source: "layers" }); // 1h for 25% of the layers
});

test("get_status surfaces print and exception_manager errors", async () => {
  const objects = printing();
  objects.print_stats = { ...objects.print_stats, state: "paused", exception: { id: 523, message: "e3_filament runout" } as any };
  mock.state.objects = { ...objects, exception_manager: { exceptions: [{ id: 900, message: "extruder[3] error: wheel_speed" }] } };
  const s = JSON.parse(text(await call("get_status")));
  expect(s.errors).toEqual([
    { id: 523, message: "e3_filament runout" },
    { id: 900, message: "extruder[3] error: wheel_speed" },
  ]);
});

test("get_status reports each filament slot from sensors, task config, RFID and feeder, mapped to the right extruder", async () => {
  const rfid = (weight: number) => ({ VENDOR: "Snapmaker", MANUFACTURER: "Sunlu", MAIN_TYPE: "PLA", SUB_TYPE: "SnapSpeed", WEIGHT: weight, HOTEND_MIN_TEMP: 190, HOTEND_MAX_TEMP: 230, BED_TEMP: 60 });
  mock.state.objects = {
    ...printing(),
    "filament_motion_sensor e0_filament": { filament_detected: true },
    "filament_motion_sensor e3_filament": { filament_detected: false },
    print_task_config: { filament_type: ["PLA", "", "", "PETG"], filament_sub_type: ["SnapSpeed", "", "", ""], filament_color_rgba: ["080A0DFF", "", "", "E2DEDBFF"] },
    filament_detect: { info: [rfid(500), {}, {}, rfid(1000)] },
    "filament_feed left": { extruder0: { channel_state: "load_finish", channel_error: "ok" } },
    "filament_feed right": { extruder3: { channel_state: "unload_finish", channel_error: "wheel_speed" } },
  };
  const { filaments } = JSON.parse(text(await call("get_status")));
  expect(filaments.map((f: any) => f.slot)).toEqual(["T1", "T4"]);
  expect(filaments[0]).toMatchObject({ extruder: "extruder", detected: true, type: "PLA SnapSpeed", color: "#080A0D", feeder: { state: "load_finish", error: "ok" } });
  expect(filaments[0].spool.nominal_weight_g).toBe(500);
  expect(filaments[1]).toMatchObject({ extruder: "extruder3", detected: false, type: "PETG", color: "#E2DEDB", feeder: { error: "wheel_speed" } });
  expect(filaments[1].spool.nominal_weight_g).toBe(1000);
});

test("get_console_log returns the last N console lines, oldest first", async () => {
  mock.state.console = [
    { message: "old", time: 0, type: "response" },
    { message: "M117 hi", time: 1, type: "command" },
    { message: "!! extruder[3] error: wheel_speed", time: 2, type: "response" },
  ];
  const lines = text(await call("get_console_log", { count: 2 })).split("\n");
  expect(lines).toEqual(["1970-01-01T00:00:01.000Z > M117 hi", "1970-01-01T00:00:02.000Z !! extruder[3] error: wheel_speed"]);
  expect(mock.state.requests).toContain("GET /server/gcode_store?count=2");
});

test("list_files returns newest first and honours limit", async () => {
  mock.state.files = [
    { path: "old.gcode", modified: 1, size: 1e6 },
    { path: "new.gcode", modified: 3, size: 2.5e6 },
    { path: "mid.gcode", modified: 2, size: 1 },
  ];
  const r = JSON.parse(text(await call("list_files", { limit: 2 })));
  expect(r.total).toBe(3);
  expect(r.files.map((f: any) => f.path)).toEqual(["new.gcode", "mid.gcode"]);
  expect(r.files[0].size_mb).toBe(2.5);
});

test("get_webcam_snapshot wakes the camera and retries a half-written JPEG", async () => {
  mock.state.truncatedReads = 1;
  const r = await call("get_webcam_snapshot");
  expect(r.isError).toBeFalsy();
  expect(mock.state.rpcCalls).toEqual(["camera.start_monitor"]);
  const img = r.content.find((b) => b.type === "image");
  expect(new Uint8Array(Buffer.from(img.data, "base64"))).toEqual(JPEG);
  expect(mock.state.requests.filter((q) => q.endsWith("monitor.jpg"))).toHaveLength(2);
});

test("get_print_history passes limit and newest-first order", async () => {
  mock.state.jobs = [{ filename: "a.gcode", status: "completed", start_time: 0, end_time: 7200, print_duration: 5400, filament_used: 12345 }];
  const r = JSON.parse(text(await call("get_print_history", { limit: 5 })));
  expect(mock.state.requests).toContain("GET /server/history/list?limit=5&order=desc");
  expect(r).toEqual([
    { filename: "a.gcode", status: "completed", started: null, ended: "1970-01-01T02:00:00.000Z", print_time: "1h 30m", filament_m: 12.35 },
  ]);
});

test("GETs retry transient 5xx errors", async () => {
  mock.state.failNext = 2;
  const r = await call("list_files");
  expect(r.isError).toBeFalsy();
  expect(mock.state.requests).toHaveLength(3);
});

test("4xx errors are not retried and reach the AI as a readable tool error", async () => {
  mock.state.failNext = 1;
  mock.state.failStatus = 404;
  const r = await call("list_files");
  expect(r.isError).toBe(true);
  expect(text(r)).toContain("Moonraker HTTP 404 on /server/files/list?root=gcodes: Mock failure");
  expect(mock.state.requests).toHaveLength(1);
});

test("an unresponsive printer gives a timeout message instead of hanging", async () => {
  mock.state.hang = true;
  const r = await call("list_files");
  expect(r.isError).toBe(true);
  expect(text(r)).toContain("did not respond within 0.5s");
});

test("an unreachable printer gives a clear error", async () => {
  mock.stop();
  const r = await call("get_print_history");
  expect(r.isError).toBe(true);
  expect(text(r)).toContain(`Cannot reach printer at ${mock.url}`);
});
