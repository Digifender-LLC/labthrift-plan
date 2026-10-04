// P05 / SR-P10: simultaneous saves from one revision cannot silently overwrite each other.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { startWorker, uniqueName } from "../support/harness.mjs";

let w;
before(async () => {
  w = await startWorker();
});
after(async () => {
  await w?.stop();
});

async function devices(n) {
  const first = w.client();
  const name = uniqueName("cas");
  assert.equal((await first.register(name)).status, 200);
  const out = [first];
  for (let i = 1; i < n; i++) {
    const d = w.client();
    assert.equal((await d.login(name, first.passkeys[0])).status, 200);
    out.push(d);
  }
  return out;
}

describe("simultaneous ordinary saves", () => {
  test("exactly one of two racing saves wins; the other gets a recoverable conflict", async () => {
    const [a, b] = await devices(2);
    for (let round = 0; round < 25; round++) {
      const base = (await a.get("/api/lab")).body.updated_at;
      const [ra, rb] = await Promise.all([
        a.put("/api/lab", { title: `A${round}`, updated_at: base }),
        b.put("/api/lab", { title: `B${round}`, updated_at: base }),
      ]);
      const statuses = [ra.status, rb.status].sort();
      assert.deepEqual(statuses, [200, 409], `round ${round}: ${ra.text} | ${rb.text}`);
      const [win, lose, winTitle] = ra.status === 200 ? [ra, rb, `A${round}`] : [rb, ra, `B${round}`];
      assert.equal(lose.body.error, "conflict");
      assert.equal(lose.body.updated_at, win.body.updated_at, "conflict carries the winning version");
      assert.equal(lose.body.lab.title, winTitle, "conflict carries the current notebook");
      const stored = (await a.get("/api/lab")).body;
      assert.equal(stored.title, winTitle);
      assert.equal(stored.updated_at, win.body.updated_at);
    }
  });

  test("with five racing devices exactly one save lands per revision", async () => {
    const ds = await devices(5);
    for (let round = 0; round < 10; round++) {
      const base = (await ds[0].get("/api/lab")).body.updated_at;
      const res = await Promise.all(ds.map((d, i) => d.put("/api/lab", { title: `d${i}r${round}`, updated_at: base })));
      const wins = res.filter((r) => r.status === 200);
      assert.equal(wins.length, 1, `round ${round}: ${res.map((r) => r.status)}`);
      assert.ok(res.every((r) => r.status === 200 || r.status === 409));
      assert.equal((await ds[0].get("/api/lab")).body.updated_at, wins[0].body.updated_at);
    }
  });

  test("the loser can recover by retrying from the conflict's version", async () => {
    const [a, b] = await devices(2);
    const base = (await a.get("/api/lab")).body.updated_at;
    const [ra, rb] = await Promise.all([
      a.put("/api/lab", { title: "A", hosts: [{ hostname: "a" }], updated_at: base }),
      b.put("/api/lab", { title: "B", hosts: [{ hostname: "b" }], updated_at: base }),
    ]);
    const lose = ra.status === 409 ? ra : rb;
    const loser = ra.status === 409 ? a : b;
    const merged = { ...lose.body.lab, hosts: [...lose.body.lab.hosts, { hostname: "merged" }] };
    const retry = await loser.put("/api/lab", { ...merged, updated_at: lose.body.updated_at });
    assert.equal(retry.status, 200);
    assert.equal((await a.get("/api/lab")).body.hosts.length, 2);
  });

  test("rapid sequential saves never reuse a version, so a stale holder always conflicts", async () => {
    const [a, b] = await devices(2);
    let v = (await a.get("/api/lab")).body.updated_at;
    const seen = new Set([v]);
    for (let i = 0; i < 30; i++) {
      const r = await a.put("/api/lab", { title: `t${i}`, updated_at: v });
      assert.equal(r.status, 200);
      assert.ok(r.body.updated_at > v, `${r.body.updated_at} > ${v}`);
      assert.ok(!seen.has(r.body.updated_at));
      seen.add(r.body.updated_at);
      v = r.body.updated_at;
    }
    // A device holding any earlier version is refused.
    const old = [...seen].sort()[seen.size - 2];
    assert.equal((await b.put("/api/lab", { title: "stale", updated_at: old })).status, 409);
  });
});

describe("explicit overwrites", () => {
  test("force and import are explicit replacements that still get a fresh version", async () => {
    const [a, b] = await devices(2);
    const base = (await a.get("/api/lab")).body.updated_at;
    const [save, forced] = await Promise.all([
      a.put("/api/lab", { title: "ordinary", updated_at: base }),
      b.put("/api/lab", { title: "forced", updated_at: base, force: true }),
    ]);
    assert.equal(forced.status, 200, "force never conflicts");
    assert.ok([200, 409].includes(save.status));
    const stored = (await a.get("/api/lab")).body;
    if (save.status === 200) {
      assert.notEqual(save.body.updated_at, forced.body.updated_at, "two writes, two versions");
      // Whichever write landed last is what is stored, and it reports its own version.
      const last = stored.title === "forced" ? forced : save;
      assert.equal(stored.updated_at, last.body.updated_at);
    } else {
      assert.equal(stored.title, "forced");
      assert.equal(stored.updated_at, forced.body.updated_at);
    }

    // A save based on the pre-import version conflicts after an import.
    const before = (await a.get("/api/lab")).body.updated_at;
    const imp = await b.post("/api/lab/import", { schema_version: 2, lab: { title: "imported" } });
    assert.equal(imp.status, 200);
    assert.ok(imp.body.updated_at > before);
    const stale = await a.put("/api/lab", { title: "after import", updated_at: before });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.lab.title, "imported");
  });

  test("an import racing an ordinary save leaves a consistent version", async () => {
    const [a, b] = await devices(2);
    for (let round = 0; round < 10; round++) {
      const base = (await a.get("/api/lab")).body.updated_at;
      const [save, imp] = await Promise.all([
        a.put("/api/lab", { title: `save${round}`, updated_at: base }),
        b.post("/api/lab/import", { schema_version: 2, lab: { title: `import${round}` } }),
      ]);
      assert.equal(imp.status, 200);
      const stored = (await a.get("/api/lab")).body;
      const writer = stored.title.startsWith("import") ? imp : save;
      assert.equal(writer.status, 200);
      assert.equal(stored.updated_at, writer.body.updated_at, `round ${round}`);
    }
  });
});
