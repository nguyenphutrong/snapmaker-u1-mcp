# snapmaker-u1-mcp

English | [Tiếng Việt](README.vi.md)

An MCP server (stdio) that lets Claude Desktop and Claude Code control a **Snapmaker U1** 3D printer through the Moonraker API. Written in TypeScript, runs on Bun.

Tested with U1 firmware 2.0.0.205 (Snapmaker's Moonraker 2.0.0) and Snapmaker Orca 01.10.01.50.

## Installation

Requires the latest [Bun](https://bun.sh).

```sh
bun install
bun test             # run the tests against a mock Moonraker
bun run build        # build a standalone executable: dist/snapmaker-u1-mcp
```

Run directly from source:

```sh
PRINTER_HOST=http://192.168.1.50 bun start
```

The server uses stdout for the MCP protocol; all logs go to stderr.

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `PRINTER_HOST` | yes | | Printer address, e.g. `http://192.168.1.50` (`http://` is added if missing) |
| `MOONRAKER_API_KEY` | no | | Sent as the `X-Api-Key` header when set. The U1 does not require one by default |
| `ORCA_CLI_PATH` | no | | Path to the Snapmaker Orca CLI. `slice_model` is only enabled when this is set. On macOS: `/Applications/Snapmaker Orca.app/Contents/MacOS/Snapmaker_Orca` |
| `MAX_HOTEND_TEMP` | no | `300` | Maximum temperature (°C) for every toolhead |
| `MAX_BED_TEMP` | no | `110` | Maximum temperature (°C) for the heated bed |
| `ALLOW_DANGEROUS_GCODE` | no | `false` | Set to `true` to allow dangerous G-code commands (see Safety) |
| `MCP_HTTP_PORT` | no | | Serve MCP over HTTP on this port instead of stdio (see HTTP mode) |
| `MCP_AUTH_TOKEN` | with `MCP_HTTP_PORT` | | Bearer token clients must send, at least 16 characters |

Find the printer's IP on the U1 touchscreen under **Settings → Network**.

## Claude Desktop setup

Add this to `claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`). Use an **absolute path** to the built executable, because Claude Desktop does not read your shell's `PATH`:

```json
{
  "mcpServers": {
    "snapmaker-u1": {
      "command": "/path/to/snapmaker-u1-mcp/dist/snapmaker-u1-mcp",
      "env": {
        "PRINTER_HOST": "http://192.168.1.50",
        "ORCA_CLI_PATH": "/Applications/Snapmaker Orca.app/Contents/MacOS/Snapmaker_Orca"
      }
    }
  }
}
```

To run from source instead of the build: `"command": "/path/to/bun", "args": ["/path/to/snapmaker-u1-mcp/src/index.ts"]`.

Restart Claude Desktop after editing the file.

## Claude Code setup

```sh
claude mcp add snapmaker-u1 --scope user \
  -e PRINTER_HOST=http://192.168.1.50 \
  -e "ORCA_CLI_PATH=/Applications/Snapmaker Orca.app/Contents/MacOS/Snapmaker_Orca" \
  -- /path/to/snapmaker-u1-mcp/dist/snapmaker-u1-mcp
```

The `--` is required because `-e` accepts multiple values. Check the result with `claude mcp list`.

## HTTP mode

By default the server speaks stdio and the MCP client starts it. To run it as a long-lived service instead, for example on a Raspberry Pi next to the printer, set `MCP_HTTP_PORT`. The server then serves Streamable HTTP at `http://<host>:<port>/mcp` and refuses to start without `MCP_AUTH_TOKEN`:

```sh
PRINTER_HOST=http://192.168.1.50 MCP_HTTP_PORT=8765 MCP_AUTH_TOKEN=$(openssl rand -hex 32) dist/snapmaker-u1-mcp
```

Every request must send `Authorization: Bearer <token>`; anything else gets `401`. Add it to Claude Code with:

```sh
claude mcp add --transport http snapmaker-u1 http://<host>:8765/mcp --header "Authorization: Bearer <token>"
```

The server listens on all interfaces over plain HTTP. Keep it on your LAN or VPN, or put it behind an HTTPS reverse proxy; the token travels in clear text otherwise. claude.ai remote connectors need OAuth, which this server does not implement.

## Tools

### Read (safe, change nothing on the printer)

| Tool | Description |
|---|---|
| `get_status` | Print state, current file, layer and progress, elapsed and remaining time (slicer estimate, else layers), current errors and warnings, current/target temperature of every toolhead, the bed and the chamber, and each filament slot: loaded, type, colour, RFID spool data and feeder state |
| `list_files` | G-code files on the printer, newest first (`limit`, default 50) |
| `get_webcam_snapshot` | Takes a fresh photo with the printer's camera and returns it as an image the AI can see |
| `get_print_history` | Recent print jobs (`limit`, default 10) |
| `get_console_log` | Recent G-code console output (`count`, default 50). Feeder and filament-loading errors such as `wheel_speed` only appear here |

### Write (require `confirm: true`)

| Tool | Description |
|---|---|
| `upload_file` | Uploads a G-code file (`.gcode`, `.g`, `.gco`, `.ufp`) from this computer to the `gcodes` folder (optional `remote_dir`). Warns before overwriting. The printer cannot print STL/3MF; slice them first |
| `start_print` | Prints a file already on the printer. Refused while the printer is printing or paused |
| `pause_print` / `resume_print` / `cancel_print` | Pause / resume / cancel the current print. Checks the printer state first |
| `set_temperature` | Sets the target of one heater (`extruder`, `extruder1`…`extruder3`, `heater_bed`); `0` turns it off |
| `send_gcode` | Sends arbitrary G-code, one command per line |
| `delete_file` | Deletes a G-code file from the `gcodes` folder. The printer refuses to delete the file it is printing |
| `slice_model` | Only available when `ORCA_CLI_PATH` is set. Slices an STL/3MF with Snapmaker Orca and returns, per plate, the G-code path on this computer, estimated time and filament grams. Fails if a plate has 0 g of filament |

`slice_model` takes Orca preset names or paths to preset JSON files. Names are looked up in `~/Library/Application Support/Snapmaker_Orca/system` first (presets updated by Snapmaker Orca), then in the app bundle. For example:

- machine `Snapmaker U1 (0.4 nozzle)`
- process `0.20mm Standard @Snapmaker U1 (0.4 nozzle)`
- filament `Snapmaker PLA SnapSpeed @U1` or `Generic PLA`

System presets only store what differs from the preset they `inherits` from, and the Orca CLI does not follow that chain, so `slice_model` merges the chain into one complete preset before slicing. Abstract base presets such as `Generic PLA @U1 base` are refused, with a list of the printable presets built on them.

`overrides` changes process settings, for example `{"wall_loops": 4, "sparse_infill_density": "40%", "enable_support": true, "brim_width": 5}`. The U1 process presets default to `curr_bed_type = Cool Plate` (60 °C bed for PLA); pass `"curr_bed_type": "Textured PEI Plate"` for the textured sheet. Overrides that do not show up in the G-code's config are reported as not applied.

An STL needs machine and process presets; a 3MF can omit them to use the settings stored in the file. For a 3MF, filament presets are written into the project instead of being passed with `--load-filaments`, which would move every object to extruder 1, and 3MF files from newer Bambu Studio/Orca versions are accepted (`--allow-newer-file`).

## Safety

- **Confirmation:** every write tool has a `confirm` parameter. Unless `confirm` is `true`, the tool only describes what it would do and sends nothing to the printer.
- **Temperature limits:** `set_temperature` and `send_gcode` refuse temperatures above `MAX_HOTEND_TEMP` / `MAX_BED_TEMP`. Checked commands: `M104`, `M109`, `M140`, `M190` (`S` and `R` parameters), `SET_HEATER_TEMPERATURE`, `PID_CALIBRATE`, `TEMPERATURE_WAIT`. Temperature parameters of Snapmaker's own macros are not checked; Klipper's `max_temp` still applies.
- **Dangerous commands:** `send_gcode` blocks `FIRMWARE_RESTART`, `RESTART`, `SAVE_CONFIG`, `SET_KINEMATIC_POSITION`, `FORCE_MOVE` and `SET_VELOCITY_LIMIT` unless `ALLOW_DANGEROUS_GCODE=true`.
- **No overlapping prints:** `start_print` is refused while the printer is printing or paused.
- **No duplicate commands:** only read (GET) requests are retried on network errors or HTTP 5xx. Write commands are never retried; on a timeout the error says to check `get_status`, because the command may still have run.

Network and HTTP errors reach the AI as clear messages, and the server does not crash.

## Example prompts

- "What is the printer doing? How long until it finishes?"
- "Take a photo of the bed and check whether the print has lifted or failed."
- "List the 10 newest files on the printer."
- "Were any of the recent prints cancelled?"
- "Pause the current print."
- "Heat extruder1 to 220 °C and the bed to 60 °C."
- "Slice `~/Downloads/benchy.stl` with the 0.4 nozzle, 0.20mm Standard, Snapmaker PLA SnapSpeed and 4 walls on the textured PEI plate, upload it and start printing."
- "Why did the print stop? Check the console log too."
- "Which filament is loaded in each slot?"

## U1-specific notes

- **Camera:** stock firmware has no webcam stream (`/server/webcams/list` is empty and `/webcam/` returns 502). The image is the file `camera/monitor.jpg`, which only updates while a client sends `camera.start_monitor` over the websocket. `get_webcam_snapshot` sends it, waits for a new frame and downloads it; a half-written image is read again.
- **Heaters:** the toolhead list comes from `heaters.available_sensors` at runtime, not a fixed list.
- **Start print:** uses `POST /printer/print/start`, without per-toolhead filament mapping. Snapmaker's `start_local_print` (with filament mapping) only works over the websocket and is not supported yet.
- **Print history:** while a print is running, the U1 records its `print_time` as 0. Use `get_status` for progress.
- **Slicing:** Snapmaker Orca 01.10.01.50 crashes (segfault) when a process preset contains `wipe_tower_filament`, which every U1 system process preset does. `slice_model` removes that key in a temporary copy before slicing.

## License

MIT, see [LICENSE](LICENSE).
