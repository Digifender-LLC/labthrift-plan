// Local test harness: runs the real Worker under `wrangler dev --local` against a
// throwaway D1 directory, so every run starts from empty, disposable data and
// never touches the production database or domain.
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SoftPasskey } from "./authenticator.mjs";

const ROOT = resolve(import.meta.dirname, "../..");
const WRANGLER = join(ROOT, "node_modules", ".bin", "wrangler");
const env = { ...process.env, WRANGLER_SEND_METRICS: "false", NO_COLOR: "1", CI: "1" };

function freePort() {
  return new Promise((ok, fail) => {
    const srv = createServer();
    srv.once("error", fail);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => ok(port));
    });
  });
}

function requireWrangler() {
  const probe = spawnSync(WRANGLER, ["--version"], { cwd: ROOT, env, encoding: "utf8" });
  if (probe.status !== 0) {
    throw new Error("wrangler is not installed. Run `npm ci` in the repository root first.");
  }
}

/**
 * Start the Worker locally. Migrations are applied with the same command the
 * repository documents for local development (`wrangler d1 migrations apply`).
 */
export async function startWorker({ vars = {} } = {}) {
  requireWrangler();
  const persist = mkdtempSync(join(tmpdir(), "lab-plan-test-"));
  const migrate = spawnSync(
    WRANGLER,
    ["d1", "migrations", "apply", "lab-plan", "--local", "--persist-to", persist],
    { cwd: ROOT, env, encoding: "utf8" }
  );
  if (migrate.status !== 0) {
    rmSync(persist, { recursive: true, force: true });
    throw new Error("Applying local migrations failed:\n" + migrate.stdout + migrate.stderr);
  }

  const port = await freePort();
  const inspectorPort = await freePort();
  // Clients reach the Worker through a small TCP relay that tests can cut to simulate an outage.
  const relay = await startRelay(port);
  const origin = `http://localhost:${relay.port}`;
  const allVars = { WEBAUTHN_RP_ID: "localhost", WEBAUTHN_ORIGIN: origin, ...vars };
  const args = [
    "dev",
    "--local",
    "--persist-to",
    persist,
    "--ip",
    "127.0.0.1",
    "--port",
    String(port),
    // Without this, wrangler rewrites request URLs to the production route host.
    "--local-upstream",
    `localhost:${relay.port}`,
    "--inspector-port",
    String(inspectorPort),
    "--show-interactive-dev-session=false",
  ];
  for (const [k, v] of Object.entries(allVars)) args.push("--var", `${k}:${v}`);
  const child = spawn(WRANGLER, args, { cwd: ROOT, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));

  const deadline = Date.now() + 60_000;
  for (;;) {
    if (child.exitCode != null) throw new Error("wrangler dev exited early:\n" + log);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/auth/me`);
      if (res.status === 401) break;
    } catch {
      /* not listening yet */
    }
    if (Date.now() > deadline) {
      process.kill(-child.pid, "SIGKILL");
      relay.close();
      throw new Error("wrangler dev did not become ready:\n" + log);
    }
    await new Promise((r) => setTimeout(r, 250));
  }

  const d1Dir = join(persist, "v3", "d1", "miniflare-D1DatabaseObject");
  const file = readdirSync(d1Dir).find((f) => f.endsWith(".sqlite") && f !== "metadata.sqlite");
  const db = new DatabaseSync(join(d1Dir, file));
  db.exec("PRAGMA busy_timeout = 5000");

  return {
    origin,
    port,
    /** Direct access to the disposable local database, for seeding and inspection. */
    db,
    log: () => log,
    client: (opts) => new Client(origin, opts),
    /** Simulate the server being unreachable (connections refused/reset) or back. */
    setReachable: (on) => relay.setReachable(on),
    async stop() {
      db.close();
      relay.close();
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        /* already gone */
      }
      await new Promise((r) => setTimeout(r, 300));
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        /* already gone */
      }
      rmSync(persist, { recursive: true, force: true });
    },
  };
}

function startRelay(targetPort) {
  let reachable = true;
  const sockets = new Set();
  const server = createServer((inbound) => {
    if (!reachable) return inbound.destroy();
    const outbound = connect(targetPort, "127.0.0.1");
    for (const s of [inbound, outbound]) {
      sockets.add(s);
      s.on("close", () => sockets.delete(s));
      s.on("error", () => {});
    }
    inbound.pipe(outbound).pipe(inbound);
    inbound.on("close", () => outbound.destroy());
    outbound.on("close", () => inbound.destroy());
  });
  return new Promise((ok) =>
    server.listen(0, "127.0.0.1", () =>
      ok({
        port: server.address().port,
        setReachable(on) {
          reachable = on;
          if (!on) for (const s of sockets) s.destroy();
        },
        close() {
          for (const s of sockets) s.destroy();
          server.close();
        },
      })
    )
  );
}

/** A cookie-carrying API client: one instance behaves like one browser/device. */
export class Client {
  constructor(origin, { userAgent = "Mozilla/5.0 (X11; Linux x86_64) lab-plan-contract-test" } = {}) {
    this.origin = origin;
    this.userAgent = userAgent;
    this.cookie = null;
    this.passkeys = [];
  }

  async request(path, { method = "GET", body, headers = {}, raw = false } = {}) {
    const init = { method, headers: { "user-agent": this.userAgent, ...headers } };
    if (this.cookie) init.headers.cookie = this.cookie;
    if (body !== undefined) {
      init.body = typeof body === "string" ? body : JSON.stringify(body);
      init.headers["content-type"] ??= "application/json";
    }
    const res = await fetch(this.origin + path, init);
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(";");
      const [name, value] = pair.split("=");
      if (name !== "lab_plan_session") continue;
      this.cookie = value ? `${name}=${value}` : null;
    }
    if (raw) return res;
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    return { status: res.status, body: json, text, headers: res.headers };
  }

  get = (path, opts) => this.request(path, { ...opts, method: "GET" });
  put = (path, body, opts) => this.request(path, { ...opts, method: "PUT", body });
  post = (path, body = {}, opts) => this.request(path, { ...opts, method: "POST", body });
  del = (path, opts) => this.request(path, { ...opts, method: "DELETE" });

  /** Full register ceremony with a fresh software passkey. */
  async register(username, passkey = new SoftPasskey()) {
    const opts = await this.post("/auth/register/options", { username });
    if (opts.status !== 200) return opts;
    const credential = passkey.register(opts.body.options, { origin: this.origin });
    const res = await this.post("/auth/register/verify", {
      username,
      userId: opts.body.userId,
      challenge: opts.body.options.challenge,
      credential,
    });
    if (res.status === 200) this.passkeys.push(passkey);
    return res;
  }

  /** Full login ceremony with an existing software passkey. */
  async login(username, passkey = this.passkeys[0], assertOpts = {}) {
    const opts = await this.post("/auth/login/options", { username });
    if (opts.status !== 200) return opts;
    const credential = passkey.assert(opts.body.options, { origin: this.origin, ...assertOpts });
    return this.post("/auth/login/verify", {
      username,
      challenge: opts.body.options.challenge,
      credential,
    });
  }
}

let seq = 0;
/** Unique disposable username per test run. */
export const uniqueName = (prefix = "t") => `${prefix}_${process.pid % 10000}_${++seq}`;
