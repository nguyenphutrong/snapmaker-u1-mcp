import { afterEach, beforeEach, expect, test } from "bun:test";
import { Moonraker } from "../src/moonraker.ts";
import { connect, JPEG, startMock } from "./mock-moonraker.ts";

let mock: ReturnType<typeof startMock>;
let call: Awaited<ReturnType<typeof connect>>;
const text = (r: { content: any[] }) => r.content.find((b) => b.type === "text").text as string;

beforeEach(async () => {
  mock = startMock();
  call = await connect(new Moonraker(mock.url, undefined, 500));
});
afterEach(() => mock.stop());

test("get_status reports every heater the printer lists, not a hard-coded set", async () => {
  mock.state.objects = {
    heaters: { available_sensors: ["heater_bed", "extruder", "extruder3", "temperature_sensor cavity"] },
    print_stats: { state: "printing", filename: "a.gcode", print_duration: 3600, message: "", info: { total_layer: 100, current_layer: 25 } },
    display_status: { progress: 0.25 },
    heater_bed: { temperature: 65.04, target: 65 },
    extruder: { temperature: 41, target: 0 },
    extruder3: { temperature: 219.96, target: 220 },
    "temperature_sensor cavity": { temperature: 39 },
  };
  const s = JSON.parse(text(await call("get_status")));
  expect(s).toMatchObject({ state: "printing", progress_percent: 25, layer: "25/100", elapsed: "1h 0m", remaining: "3h 0m" });
  expect(s.temperatures).toEqual({
    heater_bed: { current: 65, target: 65 },
    extruder: { current: 41, target: 0 },
    extruder3: { current: 220, target: 220 },
    "temperature_sensor cavity": { current: 39 },
  });
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
