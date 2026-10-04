// P01: notebook ownership and editing contracts (BR-P2, PR-P1–P4, FR-P3–P5, SR-P1, SR-P2, SR-P5).
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { startWorker, uniqueName } from "../support/harness.mjs";
import { CHECKLIST_KEYS, expectedStored, fullLab, notebookOf } from "../support/fixtures.mjs";

let w;
before(async () => {
  w = await startWorker();
});
after(async () => {
  await w?.stop();
});

async function signedIn(prefix = "nb") {
  const c = w.client();
  const name = uniqueName(prefix);
  const res = await c.register(name);
  assert.equal(res.status, 200, res.text);
  return { c, name };
}

describe("ownership", () => {
  test("lab routes require a session", async () => {
    const anon = w.client();
    assert.equal((await anon.get("/api/lab")).status, 401);
    assert.equal((await anon.put("/api/lab", fullLab())).status, 401);
    assert.equal((await anon.get("/api/lab/export")).status, 401);
    assert.equal((await anon.post("/api/lab/import", fullLab())).status, 401);
  });

  test("registration creates exactly one default lab for the user", async () => {
    const { c, name } = await signedIn();
    const lab = (await c.get("/api/lab")).body;
    assert.equal(lab.title, "My lab");
    assert.deepEqual(lab.inventory, []);
    assert.deepEqual(lab.services, []);
    assert.deepEqual(lab.hosts, []);
    assert.deepEqual(lab.bom, []);
    assert.deepEqual(Object.keys(lab.checklist).sort(), [...CHECKLIST_KEYS].sort());
    for (const item of Object.values(lab.checklist)) {
      assert.equal(item.done, false);
      assert.match(item.href, /^https:\/\/labthrift\.com\/guides\//);
    }
    assert.equal(lab.upsVa, undefined);
    assert.equal(lab.powerNote, undefined);
    const rows = w.db
      .prepare("SELECT COUNT(*) AS n FROM labs l JOIN users u ON u.id = l.user_id WHERE u.username = ?")
      .get(name);
    assert.equal(rows.n, 1);
  });

  test("one session cannot read or write another user's lab", async () => {
    const alice = await signedIn("alice");
    const bob = await signedIn("bob");
    const aliceLab = (await alice.c.get("/api/lab")).body;
    const aliceSave = await alice.c.put("/api/lab", { ...fullLab(), updated_at: aliceLab.updated_at });
    assert.equal(aliceSave.status, 200);

    // Bob tries to address Alice's row through every client-controlled field.
    const aliceUser = w.db.prepare("SELECT id FROM users WHERE username = ?").get(alice.name);
    const bobLab = (await bob.c.get("/api/lab")).body;
    const hijack = {
      title: "pwned",
      id: aliceLab.id,
      user_id: aliceUser.id,
      userId: aliceUser.id,
      username: alice.name,
      updated_at: bobLab.updated_at,
    };
    assert.equal((await bob.c.put("/api/lab", hijack)).status, 200);
    assert.equal((await bob.c.post("/api/lab/import", { lab: hijack })).status, 200);

    const aliceAfter = (await alice.c.get("/api/lab")).body;
    assert.equal(aliceAfter.title, "Basement lab");
    assert.equal(aliceAfter.inventory.length, 3);
    const bobAfter = (await bob.c.get("/api/lab")).body;
    assert.equal(bobAfter.title, "pwned");
    assert.notEqual(bobAfter.id, aliceAfter.id);
    const exported = (await bob.c.get("/api/lab/export")).body;
    assert.equal(exported.username, bob.name);
    assert.equal(exported.lab.id, bobAfter.id);
  });
});

describe("editing round trip", () => {
  test("every supported notebook field survives save and reload", async () => {
    const { c } = await signedIn();
    const start = (await c.get("/api/lab")).body;
    const input = fullLab();
    const res = await c.put("/api/lab", { ...input, updated_at: start.updated_at });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.match(res.body.updated_at, /^\d{4}-\d{2}-\d{2}T/);
    const back = (await c.get("/api/lab")).body;
    assert.equal(back.updated_at, res.body.updated_at);
    assert.deepEqual(notebookOf(back), expectedStored(input, start.checklist));
  });

  test("clearing optional capacity fields removes them", async () => {
    const { c } = await signedIn();
    let lab = (await c.get("/api/lab")).body;
    let res = await c.put("/api/lab", { ...fullLab(), updated_at: lab.updated_at });
    res = await c.put("/api/lab", { ...fullLab(), upsVa: "", powerNote: "  ", updated_at: res.body.updated_at });
    assert.equal(res.status, 200);
    lab = (await c.get("/api/lab")).body;
    assert.equal("upsVa" in lab, false);
    assert.equal("powerNote" in lab, false);
  });

  test("a save replaces the whole notebook; omitted collections reset to defaults", async () => {
    const { c } = await signedIn();
    let lab = (await c.get("/api/lab")).body;
    const first = await c.put("/api/lab", { ...fullLab(), updated_at: lab.updated_at });
    const second = await c.put("/api/lab", { title: "Only a title", updated_at: first.body.updated_at });
    assert.equal(second.status, 200);
    lab = (await c.get("/api/lab")).body;
    assert.equal(lab.title, "Only a title");
    assert.deepEqual(lab.inventory, []);
    assert.deepEqual(lab.closet, { units: 12, slots: [], ports: [] });
    assert.ok(Object.values(lab.checklist).every((i) => i.done === false));
  });

  test("malformed or non-object bodies are rejected without touching the notebook", async () => {
    const { c } = await signedIn();
    const lab = (await c.get("/api/lab")).body;
    const saved = await c.put("/api/lab", { ...fullLab(), updated_at: lab.updated_at });
    for (const body of ["{not json", "null", "[]", '"text"', "42"]) {
      const res = await c.put("/api/lab", body);
      assert.equal(res.status, 400, `body ${body} -> ${res.status}`);
      assert.equal(res.body.error, "bad_request");
    }
    const after = (await c.get("/api/lab")).body;
    assert.equal(after.updated_at, saved.body.updated_at);
    assert.equal(after.title, "Basement lab");
  });
});

describe("sanitization and limits", () => {
  async function saveAndRead(c, body) {
    const cur = (await c.get("/api/lab")).body;
    const res = await c.put("/api/lab", { ...body, updated_at: cur.updated_at });
    assert.equal(res.status, 200, res.text);
    return (await c.get("/api/lab")).body;
  }

  test("collections are capped at 100 items", async () => {
    const { c } = await signedIn();
    const many = (n, f) => Array.from({ length: n }, (_, i) => f(i));
    const lab = await saveAndRead(c, {
      inventory: many(150, (i) => ({ name: `pc ${i}` })),
      services: many(150, (i) => ({ name: `svc ${i}` })),
      hosts: many(150, (i) => ({ hostname: `h${i}` })),
      bom: many(150, (i) => ({ slug: `s${i}` })),
      closet: {
        units: 42,
        slots: many(150, (i) => ({ start: 1, name: `s${i}` })),
        ports: many(150, (i) => ({ port: i })),
      },
    });
    assert.equal(lab.inventory.length, 100);
    assert.equal(lab.inventory[99].name, "pc 99");
    assert.equal(lab.services.length, 100);
    assert.equal(lab.hosts.length, 100);
    assert.equal(lab.bom.length, 100);
    assert.equal(lab.closet.slots.length, 100);
    assert.equal(lab.closet.ports.length, 100);
  });

  test("string fields are truncated to their documented lengths", async () => {
    const { c } = await signedIn();
    const s = (n) => "x".repeat(n);
    const lab = await saveAndRead(c, {
      title: s(200),
      inventory: [{ id: s(64), name: s(500), note: s(500), role: `  ${s(50)}  `, attentionNote: s(500) }],
      services: [{ name: s(500), notes: s(500), url: s(500), hostId: s(65) }],
      closet: { units: 4, slots: [{ start: 1, name: s(200), inventoryId: s(65) }], ports: [{ port: s(20), label: s(100) }] },
      hosts: [{ hostname: s(200), ip: s(200), note: s(200) }],
      bom: [{ slug: s(300), note: s(300) }],
      powerNote: s(500),
    });
    assert.equal(lab.title.length, 80);
    const [inv] = lab.inventory;
    assert.equal(inv.id.length, 64);
    assert.equal(inv.name.length, 120);
    assert.equal(inv.note.length, 240);
    assert.equal(inv.role.length, 24);
    assert.equal(inv.attentionNote.length, 240);
    const [svc] = lab.services;
    assert.equal(svc.name.length, 120);
    assert.equal(svc.notes.length, 240);
    assert.equal(svc.url.length, 300);
    assert.equal("hostId" in svc, false, "over-long host reference is dropped");
    assert.equal(lab.closet.slots[0].name.length, 80);
    assert.equal("inventoryId" in lab.closet.slots[0], false);
    assert.equal(lab.closet.ports[0].port.length, 8);
    assert.equal(lab.closet.ports[0].label.length, 40);
    assert.equal(lab.hosts[0].hostname.length, 80);
    assert.equal(lab.hosts[0].ip.length, 64);
    assert.equal(lab.hosts[0].note.length, 160);
    assert.equal(lab.bom[0].slug.length, 160);
    assert.equal(lab.bom[0].note.length, 240);
    assert.equal(lab.powerNote.length, 240);
  });

  test("numeric estimates are clamped, coerced or dropped", async () => {
    const { c } = await signedIn();
    const lab = await saveAndRead(c, {
      inventory: [
        { name: "huge", cpu: 9999, ramGb: 1e9, storageGb: 1e12, watts: 1e9 },
        { name: "negative", cpu: -1, ramGb: -5, storageGb: -1, watts: -10 },
        { name: "strings", cpu: "8", ramGb: "32", watts: " " },
        { name: "junk", cpu: "abc", ramGb: null, storageGb: {}, watts: Infinity },
      ],
      services: [{ name: "s", ramMb: 1e12, cpuPct: 5000 }],
      upsVa: 1e9,
    });
    assert.deepEqual(
      lab.inventory.map(({ cpu, ramGb, storageGb, watts }) => ({ cpu, ramGb, storageGb, watts })),
      [
        { cpu: 512, ramGb: 4096, storageGb: 1_048_576, watts: 50_000 },
        { cpu: 0, ramGb: 0, storageGb: 0, watts: 0 },
        { cpu: 8, ramGb: 32, storageGb: undefined, watts: undefined },
        { cpu: undefined, ramGb: undefined, storageGb: undefined, watts: undefined },
      ]
    );
    assert.equal(lab.services[0].ramMb, 1_048_576);
    assert.equal(lab.services[0].cpuPct, 1000);
    assert.equal(lab.upsVa, 100_000);
  });

  test("rack height is clamped to 1–42 units and slots stay inside it", async () => {
    const { c } = await signedIn();
    const units = async (u) => (await saveAndRead(c, { closet: { units: u, slots: [] } })).closet.units;
    assert.equal(await units(100), 42);
    assert.equal(await units(42), 42);
    assert.equal(await units(1), 1);
    assert.equal(await units(-5), 1);
    // Zero and non-numeric values are treated as "unset" and fall back to the 12U default.
    assert.equal(await units(0), 12);
    assert.equal(await units("abc"), 12);

    const lab = await saveAndRead(c, {
      closet: {
        units: 12,
        slots: [
          { start: 50, height: 3, name: "past the top" },
          { start: 11, height: 5, name: "overhang" },
          { start: -2, height: 0, name: "below the bottom" },
          { startU: 4, height: 2, name: "legacy startU key" },
        ],
      },
    });
    assert.deepEqual(
      lab.closet.slots.map(({ start, height }) => [start, height]),
      [
        [12, 1],
        [11, 2],
        [1, 1],
        [4, 2],
      ]
    );
  });

  test("checklist only keeps known guide keys and server-owned labels", async () => {
    const { c } = await signedIn();
    const lab = await saveAndRead(c, {
      checklist: {
        "first-ssh": { done: true, label: "<script>", href: "javascript:alert(1)" },
        "made-up-step": { done: true, label: "x", href: "https://evil.example" },
        "first-backup": { done: "yes" },
        "first-weekend": true,
      },
    });
    assert.deepEqual(Object.keys(lab.checklist).sort(), [...CHECKLIST_KEYS].sort());
    assert.equal(lab.checklist["first-ssh"].done, true);
    assert.equal(lab.checklist["first-ssh"].href, "https://labthrift.com/guides/first-ssh");
    assert.equal(lab.checklist["first-ssh"].label, "SSH from the couch");
    assert.equal(lab.checklist["first-backup"].done, true, "truthy flags count as done");
    assert.equal(lab.checklist["first-weekend"].done, false, "non-object entries are ignored");
  });

  test("BOM status is constrained and guide URLs collapse to slugs", async () => {
    const { c } = await signedIn();
    const lab = await saveAndRead(c, {
      bom: [
        { slug: "https://labthrift.com/guides/first-backup?ref=plan#top", status: "bought" },
        { slug: "anything", status: "stolen" },
        { slug: 42, status: "skip" },
      ],
    });
    assert.deepEqual(lab.bom, [
      { slug: "first-backup", status: "bought", note: "" },
      { slug: "anything", status: "consider", note: "" },
      { slug: "", status: "skip", note: "" },
    ]);
  });

  test("references are stored as user-entered planning links, not validated", async () => {
    // A service may name a host that is not (or no longer) in Stuff, and a rack slot may point
    // at a removed item. The server keeps the bounded id; the client treats unknown ids as
    // unassigned. This records the observed contract rather than inventing referential integrity.
    const { c } = await signedIn();
    const lab = await saveAndRead(c, {
      inventory: [{ id: "inv-a", name: "a" }],
      services: [{ name: "orphan", hostId: "inv-missing" }],
      closet: { units: 6, slots: [{ start: 1, name: "ghost", inventoryId: "inv-missing" }] },
    });
    assert.equal(lab.services[0].hostId, "inv-missing");
    assert.equal(lab.closet.slots[0].inventoryId, "inv-missing");
  });

  test("planning numbers stay user-entered estimates", async () => {
    // ADR-P005: nothing in the API turns estimates into measured health.
    const { c } = await signedIn();
    const lab = await saveAndRead(c, fullLab());
    const keys = new Set();
    const walk = (v) => {
      if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) (keys.add(k), walk(x));
    };
    walk(lab);
    for (const k of ["health", "online", "uptime", "measured", "lastSeen"]) {
      assert.equal(keys.has(k), false, `unexpected measured field ${k}`);
    }
    // The only "status" is the BOM purchase intention.
    assert.ok(lab.bom.every((b) => ["consider", "bought", "skip"].includes(b.status)));
  });
});

describe("save versions and conflicts", () => {
  test("a stale updated_at gets 409 with the current lab; force overwrites", async () => {
    const { c } = await signedIn();
    const deviceA = c;
    const deviceB = w.client();
    deviceB.cookie = c.cookie; // same account on a second device
    const base = (await deviceA.get("/api/lab")).body;

    const a = await deviceA.put("/api/lab", { ...fullLab(), title: "From A", updated_at: base.updated_at });
    assert.equal(a.status, 200);

    const stale = await deviceB.put("/api/lab", { title: "From B", updated_at: base.updated_at });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error, "conflict");
    assert.equal(stale.body.updated_at, a.body.updated_at);
    assert.equal(stale.body.lab.title, "From A");
    assert.equal(stale.body.lab.inventory.length, 3);
    assert.equal((await deviceA.get("/api/lab")).body.title, "From A", "conflict does not write");

    const forced = await deviceB.put("/api/lab", { title: "From B", updated_at: base.updated_at, force: true });
    assert.equal(forced.status, 200);
    const now = (await deviceA.get("/api/lab")).body;
    assert.equal(now.title, "From B");
    assert.equal(now.updated_at, forced.body.updated_at);
  });

  test("If-Match works like updated_at and the body version wins", async () => {
    const { c } = await signedIn();
    const base = (await c.get("/api/lab")).body;
    const first = await c.put("/api/lab", { title: "one" }, { headers: { "if-match": base.updated_at } });
    assert.equal(first.status, 200);
    const stale = await c.put("/api/lab", { title: "two" }, { headers: { "if-match": base.updated_at } });
    assert.equal(stale.status, 409);
    const bodyWins = await c.put(
      "/api/lab",
      { title: "three", updated_at: first.body.updated_at },
      { headers: { "if-match": base.updated_at } }
    );
    assert.equal(bodyWins.status, 200);
  });

  test("each successful save returns a new, increasing version", async () => {
    const { c } = await signedIn();
    let version = (await c.get("/api/lab")).body.updated_at;
    const seen = new Set([version]);
    for (let i = 0; i < 15; i++) {
      const res = await c.put("/api/lab", { title: `v${i}`, updated_at: version });
      assert.equal(res.status, 200, `save ${i}: ${res.text}`);
      assert.ok(res.body.updated_at > version, "version increases");
      assert.ok(!seen.has(res.body.updated_at), "version is never reused");
      seen.add(res.body.updated_at);
      version = res.body.updated_at;
    }
  });

  test("a missing notebook is reported, not recreated", async () => {
    const { c, name } = await signedIn();
    w.db.prepare("DELETE FROM labs WHERE user_id = (SELECT id FROM users WHERE username = ?)").run(name);
    const get = await c.get("/api/lab");
    assert.equal(get.status, 404);
    assert.equal(get.body.error, "missing_lab");
    const put = await c.put("/api/lab", { title: "x", updated_at: "2020-01-01T00:00:00.000Z" });
    assert.equal(put.status, 404);
    assert.equal(put.body.error, "missing_lab");
    assert.equal((await c.get("/api/lab/export")).status, 404);
    const imported = await c.post("/api/lab/import", { schema_version: 2, lab: { title: "x" } });
    assert.equal(imported.status, 404);
    assert.equal(imported.body.error, "missing_lab");
    const count = w.db
      .prepare("SELECT COUNT(*) AS n FROM labs WHERE user_id = (SELECT id FROM users WHERE username = ?)")
      .get(name);
    assert.equal(count.n, 0);
  });
});
