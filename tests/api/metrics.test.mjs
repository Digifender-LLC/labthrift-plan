// P04 (server side): aggregate metrics (BR-P5, SR-P7) and honest API failure codes.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { after, before, describe, test } from "node:test";
import { startWorker, uniqueName } from "../support/harness.mjs";
import { fullLab } from "../support/fixtures.mjs";

let w;
before(async () => {
  w = await startWorker();
});
after(async () => {
  await w?.stop();
});

const today = () => new Date().toISOString().slice(0, 10);
const metrics = () =>
  Object.fromEntries(w.db.prepare("SELECT metric, count FROM metric_daily WHERE day = ?").all(today()).map((r) => [r.metric, r.count]));

async function settle(predicate) {
  // Metrics are written after the response (waitUntil); give the write a moment.
  for (let i = 0; i < 40; i++) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe("aggregate metrics", () => {
  test("the metric table holds only day, metric and count", () => {
    const cols = w.db.prepare("PRAGMA table_info(metric_daily)").all().map((c) => c.name);
    assert.deepEqual(cols, ["day", "metric", "count"]);
    const pk = w.db.prepare("PRAGMA table_info(metric_daily)").all().filter((c) => c.pk).map((c) => c.name);
    assert.deepEqual(pk, ["day", "metric"]);
    // No later migration widens it.
    for (const f of readdirSync(new URL("../../migrations/", import.meta.url))) {
      const sql = readFileSync(new URL(`../../migrations/${f}`, import.meta.url), "utf8");
      assert.equal(/ALTER\s+TABLE\s+metric_daily/i.test(sql), false, f);
    }
  });

  test("register, page view and save increment day/metric counters for humans and bots", async () => {
    const before = metrics();
    const human = w.client();
    const name = uniqueName("metrics");
    await human.register(name);
    const lab = (await human.get("/api/lab")).body;
    await human.put("/api/lab", { ...fullLab(), updated_at: lab.updated_at });
    await human.post("/api/lab/import", { schema_version: 2, lab: fullLab() });

    const bot = w.client({ userAgent: "curl/8.5.0" });
    await bot.register(uniqueName("bot"));
    const botLab = (await bot.get("/api/lab")).body;
    await bot.put("/api/lab", { title: "x", updated_at: botLab.updated_at });

    const delta = (k) => (metrics()[k] || 0) - (before[k] || 0);
    await settle(() => delta("lab_save_bot") >= 1 && delta("lab_save_human") >= 2);
    assert.equal(delta("register_human"), 1);
    assert.equal(delta("page_view_human"), 1);
    assert.equal(delta("lab_save_human"), 2, "save and import both count as saves");
    assert.equal(delta("register_bot"), 1);
    assert.equal(delta("page_view_bot"), 1);
    assert.equal(delta("lab_save_bot"), 1);
  });

  test("no metric row carries user, session, IP or user-agent data", async () => {
    const c = w.client({ userAgent: "Mozilla/5.0 UniqueAgentMarker/9.9" });
    const name = uniqueName("privacy");
    await c.register(name);
    await c.get("/api/lab");
    await settle(() => (metrics().page_view_human || 0) > 0);
    const user = w.db.prepare("SELECT id FROM users WHERE username = ?").get(name);
    const sid = c.cookie.split("=")[1];
    const rows = w.db.prepare("SELECT day, metric, count FROM metric_daily").all();
    const blob = JSON.stringify(rows);
    for (const needle of [name, user.id, sid, "UniqueAgentMarker", "127.0.0.1", "localhost"]) {
      assert.equal(blob.includes(needle), false, needle);
    }
    const allowed = /^(page_view|lab_save|register)_(human|bot)$/;
    for (const r of rows) {
      assert.match(r.day, /^\d{4}-\d{2}-\d{2}$/);
      assert.match(r.metric, allowed);
      assert.ok(Number.isInteger(r.count) && r.count > 0);
    }
  });

  test("sign-in, failed saves and conflicts are not counted as saves", async () => {
    const c = w.client();
    const name = uniqueName("nocount");
    await c.register(name);
    const lab = (await c.get("/api/lab")).body;
    await c.put("/api/lab", { title: "a", updated_at: lab.updated_at });
    await new Promise((r) => setTimeout(r, 300));
    const before = metrics();
    await w.client().login(name, c.passkeys[0]);
    const conflict = await c.put("/api/lab", { title: "stale", updated_at: lab.updated_at });
    assert.equal(conflict.status, 409);
    await c.put("/api/lab", "{bad json");
    await c.post("/api/lab/import", { schema_version: 9 });
    await new Promise((r) => setTimeout(r, 500));
    assert.deepEqual(metrics(), before);
  });
});

describe("API failures stay distinguishable", () => {
  test("unauthenticated, missing, conflict and rate-limit errors use distinct codes", async () => {
    const anon = await w.client().get("/api/lab");
    assert.deepEqual([anon.status, anon.body.error], [401, "unauthorized"]);
    const c = w.client();
    const name = uniqueName("codes");
    await c.register(name);
    const lab = (await c.get("/api/lab")).body;
    await c.put("/api/lab", { title: "a", updated_at: lab.updated_at });
    const conflict = await c.put("/api/lab", { title: "b", updated_at: lab.updated_at });
    assert.deepEqual([conflict.status, conflict.body.error], [409, "conflict"]);
    w.db.prepare("DELETE FROM labs WHERE user_id = (SELECT id FROM users WHERE username = ?)").run(name);
    const missing = await c.get("/api/lab");
    assert.deepEqual([missing.status, missing.body.error], [404, "missing_lab"]);
  });

  test("security headers are present on API and app shell responses", async () => {
    for (const path of ["/", "/api/lab", "/offline"]) {
      const res = await w.client().request(path, { raw: true });
      assert.match(res.headers.get("content-security-policy") || "", /default-src 'self'/, path);
      assert.equal(res.headers.get("x-frame-options"), "DENY", path);
      assert.equal(res.headers.get("x-content-type-options"), "nosniff", path);
      await res.arrayBuffer();
    }
  });
});
