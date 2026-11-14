# snapmaker-u1-mcp

[English](README.md) | Tiếng Việt

MCP server (stdio) để Claude Desktop / Claude Code điều khiển máy in 3D **Snapmaker U1** qua Moonraker API. Viết bằng TypeScript, chạy trên Bun.

Đã kiểm tra với U1 firmware 2.0.0.205 (Moonraker 2.0.0 của Snapmaker) và Snapmaker Orca 01.10.01.50.

## Cài đặt

Cần [Bun](https://bun.sh) bản mới nhất.

```sh
bun install
bun test             # chạy test với mock Moonraker
bun run build        # đóng gói thành file chạy độc lập: dist/snapmaker-u1-mcp
```

Chạy thử trực tiếp từ mã nguồn:

```sh
PRINTER_HOST=http://192.168.1.50 bun start
```

Server dùng stdout cho giao thức MCP; mọi log đều ghi ra stderr.

## Biến môi trường

| Biến | Bắt buộc | Mặc định | Ý nghĩa |
|---|---|---|---|
| `PRINTER_HOST` | có | | Địa chỉ máy in, ví dụ `http://192.168.1.50` (thiếu `http://` sẽ tự thêm) |
| `MOONRAKER_API_KEY` | không | | Gửi qua header `X-Api-Key` nếu có. U1 mặc định không yêu cầu |
| `ORCA_CLI_PATH` | không | | Đường dẫn tới CLI của Snapmaker Orca. Có biến này thì mới bật `slice_model`. Trên macOS: `/Applications/Snapmaker Orca.app/Contents/MacOS/Snapmaker_Orca` |
| `MAX_HOTEND_TEMP` | không | `300` | Nhiệt độ tối đa (°C) cho mọi đầu in |
| `MAX_BED_TEMP` | không | `110` | Nhiệt độ tối đa (°C) cho bàn nhiệt |
| `ALLOW_DANGEROUS_GCODE` | không | `false` | Đặt `true` để cho phép các lệnh G-code nguy hiểm (xem phần An toàn) |
| `MCP_HTTP_PORT` | không | | Chạy MCP qua HTTP ở cổng này thay vì stdio (xem phần Chế độ HTTP) |
| `MCP_AUTH_TOKEN` | khi có `MCP_HTTP_PORT` | | Bearer token mà client phải gửi, tối thiểu 16 ký tự |

IP của máy in xem trên màn hình U1: **Settings → Network**.

## Cấu hình Claude Desktop

Thêm vào `claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`). Dùng **đường dẫn tuyệt đối** tới file đã build, vì Claude Desktop không đọc `PATH` của shell:

```json
{
  "mcpServers": {
    "snapmaker-u1": {
      "command": "/đường/dẫn/tới/snapmaker-u1-mcp/dist/snapmaker-u1-mcp",
      "env": {
        "PRINTER_HOST": "http://192.168.1.50",
        "ORCA_CLI_PATH": "/Applications/Snapmaker Orca.app/Contents/MacOS/Snapmaker_Orca"
      }
    }
  }
}
```

Muốn chạy từ mã nguồn thay vì bản build: `"command": "/đường/dẫn/tới/bun", "args": ["/đường/dẫn/tới/snapmaker-u1-mcp/src/index.ts"]`.

Khởi động lại Claude Desktop sau khi sửa file.

## Cấu hình Claude Code

```sh
claude mcp add snapmaker-u1 --scope user \
  -e PRINTER_HOST=http://192.168.1.50 \
  -e "ORCA_CLI_PATH=/Applications/Snapmaker Orca.app/Contents/MacOS/Snapmaker_Orca" \
  -- /đường/dẫn/tới/snapmaker-u1-mcp/dist/snapmaker-u1-mcp
```

Dấu `--` là bắt buộc vì `-e` nhận nhiều giá trị. Kiểm tra bằng `claude mcp list`.

## Chế độ HTTP

Mặc định server dùng stdio và được client MCP tự khởi động. Muốn chạy như một dịch vụ luôn bật, ví dụ trên Raspberry Pi đặt cạnh máy in, hãy đặt `MCP_HTTP_PORT`. Khi đó server phục vụ Streamable HTTP tại `http://<host>:<port>/mcp` và sẽ không khởi động nếu thiếu `MCP_AUTH_TOKEN`:

```sh
PRINTER_HOST=http://192.168.1.50 MCP_HTTP_PORT=8765 MCP_AUTH_TOKEN=$(openssl rand -hex 32) dist/snapmaker-u1-mcp
```

Mọi request phải gửi header `Authorization: Bearer <token>`, sai hoặc thiếu sẽ nhận `401`. Thêm vào Claude Code:

```sh
claude mcp add --transport http snapmaker-u1 http://<host>:8765/mcp --header "Authorization: Bearer <token>"
```

Server lắng nghe trên mọi interface bằng HTTP thường. Chỉ dùng trong LAN/VPN hoặc đặt sau reverse proxy HTTPS, nếu không token sẽ đi qua mạng ở dạng không mã hoá. Remote connector của claude.ai cần OAuth, server này chưa hỗ trợ.

## Danh sách tool

### Đọc (an toàn, không thay đổi gì trên máy)

| Tool | Chức năng |
|---|---|
| `get_status` | Trạng thái in, file đang in, layer và tiến độ, thời gian đã in và còn lại (theo ước tính của slicer, nếu không có thì theo số lớp), lỗi và cảnh báo hiện có, nhiệt độ hiện tại/mục tiêu của từng đầu in, bàn nhiệt và buồng in, và từng khe nhựa: có nhựa không, loại, màu, thông tin RFID của cuộn, trạng thái bộ nạp |
| `list_files` | Danh sách file G-code trên máy, mới nhất trước (`limit`, mặc định 50) |
| `get_webcam_snapshot` | Chụp ảnh mới từ camera của máy, trả về ảnh để AI xem được |
| `get_print_history` | Lịch sử các lần in gần đây (`limit`, mặc định 10) |
| `get_console_log` | Các dòng console G-code gần nhất (`count`, mặc định 50). Lỗi bộ nạp và lỗi nạp nhựa như `wheel_speed` chỉ thấy ở đây |

### Ghi (cần `confirm: true`)

| Tool | Chức năng |
|---|---|
| `upload_file` | Upload file G-code (`.gcode`, `.g`, `.gco`, `.ufp`) từ máy tính lên thư mục `gcodes` (tùy chọn `remote_dir`). Báo trước nếu sẽ ghi đè. Máy không in được STL/3MF, cần slice trước |
| `start_print` | In một file đã có trên máy. Bị từ chối nếu máy đang in hoặc đang tạm dừng |
| `pause_print` / `resume_print` / `cancel_print` | Tạm dừng / tiếp tục / hủy bản in hiện tại. Kiểm tra trạng thái máy trước |
| `set_temperature` | Đặt nhiệt độ cho một heater (`extruder`, `extruder1`…`extruder3`, `heater_bed`); `0` để tắt |
| `send_gcode` | Gửi G-code tùy ý, mỗi dòng một lệnh |
| `delete_file` | Xoá một file G-code trong thư mục `gcodes`. Máy từ chối xoá file đang in |
| `slice_model` | Chỉ có khi đặt `ORCA_CLI_PATH`. Slice file STL/3MF bằng Snapmaker Orca, trả về đường dẫn G-code trên máy tính, thời gian ước tính và khối lượng nhựa của từng bàn. Báo lỗi nếu có bàn 0 g nhựa |

`slice_model` nhận tên preset của Orca hoặc đường dẫn tới file JSON preset. Tên được tìm trong `~/Library/Application Support/Snapmaker_Orca/system` trước (preset do Snapmaker Orca cập nhật), sau đó tới thư mục trong app. Ví dụ:

- machine `Snapmaker U1 (0.4 nozzle)`
- process `0.20mm Standard @Snapmaker U1 (0.4 nozzle)`
- filament `Snapmaker PLA SnapSpeed @U1` hoặc `Generic PLA`

Preset hệ thống chỉ ghi phần khác với preset mà nó `inherits`, và Orca CLI không tự đọc phần kế thừa, nên `slice_model` gộp cả chuỗi thành một preset đầy đủ trước khi slice. Preset nền trừu tượng như `Generic PLA @U1 base` bị từ chối, kèm danh sách các preset in được dựa trên nó.

`overrides` ghi đè thiết lập process, ví dụ `{"wall_loops": 4, "sparse_infill_density": "40%", "enable_support": true, "brim_width": 5}`. Preset process của U1 mặc định `curr_bed_type = Cool Plate` (bàn 60 °C với PLA); dùng `"curr_bed_type": "Textured PEI Plate"` cho tấm PEI nhám. Khoá ghi đè nào không xuất hiện trong phần config của G-code sẽ được báo là chưa áp dụng.

File STL cần preset machine và process; file 3MF có thể bỏ trống để dùng thiết lập lưu trong file. Với 3MF, preset nhựa được ghi thẳng vào project thay vì truyền qua `--load-filaments` (cờ này đặt lại mọi vật thể về đầu in 1), và file 3MF từ Bambu Studio/Orca bản mới hơn vẫn được chấp nhận (`--allow-newer-file`).

## An toàn

- **Xác nhận:** mọi tool ghi có tham số `confirm`. Nếu `confirm` không phải `true`, tool chỉ mô tả hành động sẽ làm và không gửi gì tới máy.
- **Giới hạn nhiệt:** `set_temperature` và `send_gcode` từ chối nhiệt độ vượt `MAX_HOTEND_TEMP` / `MAX_BED_TEMP`. Các lệnh được kiểm tra: `M104`, `M109`, `M140`, `M190` (tham số `S` và `R`), `SET_HEATER_TEMPERATURE`, `PID_CALIBRATE`, `TEMPERATURE_WAIT`. Tham số nhiệt của các macro riêng của Snapmaker không được kiểm tra; giới hạn `max_temp` của Klipper vẫn áp dụng.
- **Lệnh nguy hiểm:** `send_gcode` chặn `FIRMWARE_RESTART`, `RESTART`, `SAVE_CONFIG`, `SET_KINEMATIC_POSITION`, `FORCE_MOVE`, `SET_VELOCITY_LIMIT` trừ khi `ALLOW_DANGEROUS_GCODE=true`.
- **Không in chồng:** `start_print` bị từ chối khi máy đang in hoặc đang tạm dừng.
- **Không gửi lặp:** chỉ request đọc (GET) được thử lại khi lỗi mạng hoặc HTTP 5xx. Lệnh ghi không bao giờ tự thử lại; nếu bị timeout, thông báo lỗi nhắc kiểm tra `get_status` vì lệnh có thể đã chạy.

Lỗi mạng và HTTP được trả về cho AI dưới dạng thông báo rõ ràng, server không bị crash.

## Ví dụ câu lệnh

- "Máy in đang làm gì? Còn bao lâu thì xong?"
- "Chụp ảnh bàn in xem bản in có bị bong hay lỗi gì không."
- "Liệt kê 10 file mới nhất trên máy in."
- "Các lần in gần đây có lần nào bị hủy không?"
- "Tạm dừng bản in hiện tại."
- "Gia nhiệt extruder1 lên 220 độ và bàn nhiệt lên 60 độ."
- "Slice file `~/Downloads/benchy.stl` với nozzle 0.4, layer 0.20mm Standard, nhựa Snapmaker PLA SnapSpeed, 4 vách, bàn PEI nhám, upload lên máy rồi bắt đầu in."
- "Sao máy dừng in? Xem cả console log."
- "Khe nào đang lắp nhựa gì?"

## Ghi chú riêng về U1

- **Camera:** firmware gốc không có stream webcam (`/server/webcams/list` rỗng, `/webcam/` trả 502). Ảnh nằm ở file `camera/monitor.jpg` và chỉ được cập nhật khi có client gửi `camera.start_monitor` qua WebSocket. `get_webcam_snapshot` gửi lệnh này, đợi ảnh mới rồi tải về; ảnh đọc phải lúc đang ghi dở sẽ được đọc lại.
- **Heater:** danh sách đầu in lấy động từ `heaters.available_sensors`, không cố định.
- **Start print:** dùng `POST /printer/print/start`, không gán filament theo từng đầu in. Lệnh `start_local_print` của Snapmaker (có gán filament) chỉ chạy qua WebSocket và chưa được hỗ trợ.
- **Lịch sử in:** khi một bản in đang chạy, U1 ghi `print_time` bằng 0. Dùng `get_status` để xem tiến độ.
- **Slicing:** Snapmaker Orca 01.10.01.50 bị crash (segfault) khi preset process có khóa `wipe_tower_filament`, mà mọi preset process hệ thống của U1 đều có. `slice_model` tự bỏ khóa này trong một bản sao tạm trước khi slice.

## License

MIT, xem [LICENSE](LICENSE).
