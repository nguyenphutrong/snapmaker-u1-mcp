import { expect, test } from "bun:test";
import { assertSafeGcode } from "../src/safety.ts";

const limits = { maxHotendTemp: 300, maxBedTemp: 110, allowDangerousGcode: false };
const blocked = (script: string, l = limits) => expect(() => assertSafeGcode(script, l)).toThrow();
const allowed = (script: string, l = limits) => expect(() => assertSafeGcode(script, l)).not.toThrow();

test("dangerous commands are blocked in any case and on any line, unless explicitly allowed", () => {
  for (const cmd of ["FIRMWARE_RESTART", "restart", "SAVE_CONFIG", "SET_KINEMATIC_POSITION Z=0", "force_move STEPPER=stepper_x DISTANCE=500 VELOCITY=10", "SET_VELOCITY_LIMIT VELOCITY=9999"])
    blocked(cmd);
  blocked("G28\nM400\n  SAVE_CONFIG");
  blocked("N12 FIRMWARE_RESTART");
  allowed("FIRMWARE_RESTART\nSAVE_CONFIG", { ...limits, allowDangerousGcode: true });
  allowed("; SAVE_CONFIG\nG28 ; then FIRMWARE_RESTART");
  allowed("RESTART_SOMETHING_ELSE");
});

test("hotend and bed limits apply to M104/M109/M140/M190 including compact and R forms", () => {
  allowed("M104 S300");
  blocked("M104 S301");
  blocked("m104s301");
  blocked("M104 T1 S350");
  blocked("M109 R301");
  blocked("N5 M109 S400");
  allowed("M140 S110");
  blocked("M140 S111"); // fine for a hotend, too hot for the bed
  blocked("M190 S120");
  allowed("M104 S200 ; S999 in a comment");
  allowed("M1040 S999"); // not M104
});

test("SET_HEATER_TEMPERATURE and TEMPERATURE_WAIT use the heater's own limit", () => {
  allowed("SET_HEATER_TEMPERATURE HEATER=extruder3 TARGET=250");
  blocked("SET_HEATER_TEMPERATURE HEATER=extruder3 TARGET=301");
  blocked("set_heater_temperature heater=heater_bed target=111");
  allowed("SET_HEATER_TEMPERATURE HEATER=extruder TARGET=111");
  blocked("PID_CALIBRATE HEATER=extruder2 TARGET=350");
  blocked("PID_CALIBRATE HEATER=heater_bed TARGET=120");
  allowed("PID_CALIBRATE HEATER=heater_bed TARGET=60");
  blocked("TEMPERATURE_WAIT SENSOR=extruder1 MINIMUM=305");
  blocked('TEMPERATURE_WAIT SENSOR="heater_bed" MINIMUM=115');
  allowed("TEMPERATURE_WAIT SENSOR=heater_bed MINIMUM=60 MAXIMUM=200");
});
