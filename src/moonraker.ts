export class MoonrakerError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message);
  }
}

interface FileEntry {
  path: string;
  modified: number;
  size: number;
}

export class Moonraker {
  private headers: Record<string, string>;

  constructor(readonly host: string, apiKey?: string, private timeoutMs = 10_000) {
    this.headers = apiKey ? { "X-Api-Key": apiKey } : {};
  }

  /** GET returning Moonraker's `result`. Only GETs retry: a retried POST could run a G-code or start a print twice. */
  get<T>(path: string): Promise<T> {
    return this.withRetry(async () => ((await (await this.request(path)).json()) as { result: T }).result);
  }

  /** POST with a JSON or multipart body. Never retried; see get(). */
  async post<T>(path: string, body: object | FormData = {}, timeoutMs = this.timeoutMs): Promise<T> {
    const init: RequestInit =
      body instanceof FormData
        ? { method: "POST", body }
        : { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } };
    const json = (await (await this.request(path, init, timeoutMs)).json()) as { result?: T };
    const result = (json.result ?? json) as T & { state?: string; message?: string };
    // Snapmaker's fork reports some refusals as HTTP 200 with {"state": "error"}.
    if (result?.state === "error") throw new MoonrakerError(`Printer refused ${path}: ${result.message ?? "unknown error"}`, false);
    return result;
  }

  /** DELETE returning Moonraker's `result`. Never retried. */
  async delete<T>(path: string): Promise<T> {
    return ((await (await this.request(path, { method: "DELETE" })).json()) as { result: T }).result;
  }

  listFiles(root: string) {
    return this.get<FileEntry[]>(`/server/files/list?root=${root}`);
  }

  /** One JSON-RPC call over the websocket. Needed for U1-only methods that Moonraker does not expose over HTTP. */
  async rpc(method: string, params: Record<string, unknown>): Promise<unknown> {
    const ws = new WebSocket(`${this.host.replace(/^http/, "ws")}/websocket`, { headers: this.headers });
    let timer: Timer | undefined;
    try {
      return await new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new MoonrakerError(`Printer did not answer ${method} within ${this.timeoutMs / 1000}s`, true)), this.timeoutMs);
        ws.onerror = () => reject(new MoonrakerError(`Cannot open websocket to printer at ${this.host}`, true));
        ws.onopen = () => ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }));
        ws.onmessage = (event) => {
          const msg = JSON.parse(String(event.data));
          if (msg.id !== 1) return; // notify_* broadcasts
          if (msg.error) reject(new MoonrakerError(`${method} failed: ${msg.error.message}`, false));
          else resolve(msg.result);
        };
      });
    } finally {
      clearTimeout(timer);
      ws.close();
    }
  }

  /**
   * The stock U1 has no webcam stream. Its camera service rewrites camera/monitor.jpg
   * only while a client keeps sending camera.start_monitor, so wake it and wait for a new frame.
   */
  async snapshot() {
    const frameWaitMs = 5_000;
    const frameTime = async () => (await this.listFiles("camera")).find((f) => f.path === "monitor.jpg")?.modified ?? 0;
    const before = await frameTime();
    await this.rpc("camera.start_monitor", { domain: "lan", interval: 0 });
    let modified = before;
    for (const deadline = Date.now() + frameWaitMs; modified === before && Date.now() < deadline; ) {
      await Bun.sleep(250);
      modified = await frameTime();
    }
    if (modified === before) throw new MoonrakerError(`Camera produced no new frame within ${frameWaitMs / 1000}s`, false);

    // The file is rewritten in place, so a read can catch half a JPEG.
    const jpeg = await this.withRetry(async () => {
      const b = await (await this.request("/server/files/camera/monitor.jpg")).bytes();
      const complete = b[0] === 0xff && b[1] === 0xd8 && b.at(-2) === 0xff && b.at(-1) === 0xd9;
      if (!complete) throw new MoonrakerError("Camera returned a truncated JPEG", true);
      return b;
    });
    return { jpeg, capturedAt: new Date(modified * 1000) };
  }

  private async request(path: string, init: RequestInit = {}, timeoutMs = this.timeoutMs): Promise<Response> {
    let res: Response;
    try {
      res = await fetch(this.host + path, {
        ...init,
        headers: { ...this.headers, ...(init.headers as Record<string, string>) },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      const timedOut = (e as Error).name === "TimeoutError";
      const maybeRan = init.method && init.method !== "GET" ? " The command may still have run; check get_status before retrying." : "";
      throw new MoonrakerError(
        timedOut
          ? `Printer at ${this.host} did not respond within ${timeoutMs / 1000}s (${path}).${maybeRan}`
          : `Cannot reach printer at ${this.host}: ${(e as Error).message}`,
        true,
      );
    }
    if (!res.ok) {
      const body = await res.text();
      let detail = body.slice(0, 300);
      try {
        detail = JSON.parse(body).error?.message ?? detail;
      } catch {}
      throw new MoonrakerError(`Moonraker HTTP ${res.status} on ${path}: ${detail}`, res.status >= 500);
    }
    return res;
  }

  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await fn();
      } catch (e) {
        if (attempt >= 3 || !(e instanceof MoonrakerError && e.retryable)) throw e;
        console.error(`[moonraker] attempt ${attempt} failed, retrying: ${e.message}`);
        await Bun.sleep(250 * attempt);
      }
    }
  }
}
