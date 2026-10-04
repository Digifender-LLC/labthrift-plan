// P02: portable imports and exports (BR-P3, PR-P5, FR-P6, FR-P7, SR-P3, SR-P4).
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { startWorker, uniqueName } from "../support/harness.mjs";
import { expectedStored, fullLab, notebookOf } from "../support/fixtures.mjs";

let w;
before(async () => {
  w = await startWorker();
});
after(async () => {
  await w?.stop();
});

async function signedIn() {
  const c = w.client();
  const name = uniqueName("port");
  assert.equal((await c.register(name)).status, 200);
  return { c, name };
}

async function seed(c) {
  const cur = (await c.get("/api/lab")).body;
  const res = await c.put("/api/lab", { ...fullLab(), updated_at: cur.updated_at });
  assert.equal(res.status, 200);
  return (await c.get("/api/lab")).body;
}

describe("export", () => {
  test("downloads versioned JSON with timestamp, username and the lab", async () => {
    const { c, name } = await signedIn();
    const lab = await seed(c);
    const res = await c.get("/api/lab/export");
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /^application\/json/);
    assert.equal(res.headers.get("content-disposition"), `attachment; filename="lab-plan-${name}.json"`);
    const file = res.body;
    assert.deepEqual(Object.keys(file).sort(), ["exported_at", "lab", "schema_version", "username"]);
    assert.equal(file.schema_version, 2);
    assert.ok(!Number.isNaN(Date.parse(file.exported_at)));
    assert.equal(file.username, name);
    assert.deepEqual(file.lab, lab);
  });

  test("contains no credentials, sessions or account identifiers", async () => {
    const { c } = await signedIn();
    await seed(c);
    const res = await c.get("/api/lab/export");
    const text = res.text;
    const passkey = c.passkeys[0];
    assert.equal(text.includes(passkey.id), false, "credential id");
    assert.equal(text.includes(c.cookie.split("=")[1]), false, "session id");
    const user = w.db.prepare("SELECT id FROM users WHERE username = ?").get(res.body.username);
    assert.equal(text.includes(user.id), false, "user id");
    for (const k of ["passkeys", "public_key", "sessions", "user_id", "userId", "credential"]) {
      assert.equal(text.includes(`"${k}"`), false, `field ${k}`);
    }
  });
});

describe("import", () => {
  test("an exported file round-trips with no supported field lost", async () => {
    const { c } = await signedIn();
    const original = await seed(c);
    const file = (await c.get("/api/lab/export")).body;

    // Wipe, then restore from the file exactly as the browser would upload it.
    const cur = (await c.get("/api/lab")).body;
    await c.put("/api/lab", { title: "wiped", updated_at: cur.updated_at });
    const res = await c.post("/api/lab/import", file);
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.lab.updated_at, res.body.updated_at);
    const restored = (await c.get("/api/lab")).body;
    assert.deepEqual(notebookOf(restored), notebookOf(original));
    assert.equal(restored.id, original.id, "import updates the user's existing row");
  });

  test("a file exported by one account imports into another without moving ownership", async () => {
    const alice = await signedIn();
    const bob = await signedIn();
    await seed(alice.c);
    const file = (await alice.c.get("/api/lab/export")).body;
    const bobBefore = (await bob.c.get("/api/lab")).body;
    const res = await bob.c.post("/api/lab/import", file);
    assert.equal(res.status, 200);
    const bobLab = (await bob.c.get("/api/lab")).body;
    assert.equal(bobLab.id, bobBefore.id);
    assert.equal(bobLab.title, "Basement lab");
    assert.equal((await bob.c.get("/auth/me")).body.username, bob.name);
    const exported = (await bob.c.get("/api/lab/export")).body;
    assert.equal(exported.username, bob.name);
  });

  test("legacy (unversioned bare lab), v1 and v2 files are accepted", async () => {
    const { c } = await signedIn();
    const base = (await c.get("/api/lab")).body;
    const expected = expectedStored(fullLab(), base.checklist);
    const files = {
      legacy: fullLab(),
      legacyWrapper: { lab: fullLab() },
      v1: { schema_version: 1, exported_at: "2025-01-01T00:00:00.000Z", lab: fullLab() },
      v2: { schema_version: 2, exported_at: "2026-01-01T00:00:00.000Z", username: "someone", lab: fullLab() },
      v2String: { schema_version: "2", lab: fullLab() },
    };
    for (const [name, file] of Object.entries(files)) {
      await c.post("/api/lab/import", { lab: { title: "reset" } });
      const res = await c.post("/api/lab/import", file);
      assert.equal(res.status, 200, `${name}: ${res.text}`);
      assert.deepEqual(notebookOf((await c.get("/api/lab")).body), expected, name);
    }
  });

  test("a v1 file without v2-only fields imports with empty services and no capacity", async () => {
    const { c } = await signedIn();
    const v1Lab = fullLab();
    delete v1Lab.services;
    delete v1Lab.upsVa;
    delete v1Lab.powerNote;
    for (const it of v1Lab.inventory) for (const k of ["role", "cpu", "ramGb", "storageGb", "watts", "needsAttention", "attentionNote"]) delete it[k];
    const res = await c.post("/api/lab/import", { schema_version: 1, lab: v1Lab });
    assert.equal(res.status, 200);
    const lab = (await c.get("/api/lab")).body;
    assert.deepEqual(lab.services, []);
    assert.equal("upsVa" in lab, false);
    assert.deepEqual(lab.inventory[0], { id: "inv-optiplex", name: "Optiplex 7050", note: "Marketplace find, $60" });
  });

  test("unknown or invalid schema versions are rejected and change nothing", async () => {
    const { c } = await signedIn();
    const before = await seed(c);
    for (const v of [3, 0, -1, 1.5, "v2", "abc", 99]) {
      const res = await c.post("/api/lab/import", { schema_version: v, lab: { title: "should not land" } });
      assert.equal(res.status, 400, `schema ${v}`);
      assert.equal(res.body.error, "unsupported_schema");
      assert.deepEqual(res.body.schema_version, v);
    }
    const after = (await c.get("/api/lab")).body;
    assert.deepEqual(after, before);
  });

  test("non-object files are rejected and change nothing", async () => {
    const { c } = await signedIn();
    const before = await seed(c);
    for (const body of ["{broken", "null", "[]", "[1,2]", '"lab"', "7"]) {
      const res = await c.post("/api/lab/import", body);
      assert.equal(res.status, 400, `body ${body} -> ${res.status}`);
      assert.equal(res.body.error, "bad_request");
    }
    assert.deepEqual((await c.get("/api/lab")).body, before);
  });

  test("import replaces the notebook; it does not merge", async () => {
    const { c } = await signedIn();
    await seed(c);
    const res = await c.post("/api/lab/import", { schema_version: 2, lab: { title: "Fresh start", hosts: [{ hostname: "only" }] } });
    assert.equal(res.status, 200);
    const lab = (await c.get("/api/lab")).body;
    assert.equal(lab.title, "Fresh start");
    assert.deepEqual(lab.inventory, []);
    assert.deepEqual(lab.services, []);
    assert.deepEqual(lab.hosts, [{ hostname: "only", ip: "", note: "" }]);
    assert.deepEqual(lab.bom, []);
    assert.equal("upsVa" in lab, false);
  });

  test("imported content passes through the same sanitizers as saves", async () => {
    const { c } = await signedIn();
    const res = await c.post("/api/lab/import", {
      schema_version: 2,
      lab: {
        title: "t".repeat(300),
        inventory: Array.from({ length: 120 }, (_, i) => ({ name: `n${i}`, cpu: 10_000 })),
        closet: { units: 99, slots: [{ start: 80, height: 9 }] },
        bom: [{ slug: "https://labthrift.com/guides/first-ssh", status: "pirated" }],
        checklist: { "first-ssh": { done: true, href: "javascript:alert(1)" } },
      },
    });
    assert.equal(res.status, 200);
    const lab = (await c.get("/api/lab")).body;
    assert.equal(lab.title.length, 80);
    assert.equal(lab.inventory.length, 100);
    assert.equal(lab.inventory[0].cpu, 512);
    assert.deepEqual(lab.closet.slots, [{ start: 42, height: 1, name: "" }]);
    assert.equal(lab.closet.units, 42);
    assert.deepEqual(lab.bom, [{ slug: "first-ssh", status: "consider", note: "" }]);
    assert.equal(lab.checklist["first-ssh"].href, "https://labthrift.com/guides/first-ssh");
  });

  test("importing never transfers credentials or account fields", async () => {
    const alice = await signedIn();
    const mallory = await signedIn();
    const aliceUser = w.db.prepare("SELECT id FROM users WHERE username = ?").get(alice.name);
    const keysBefore = w.db.prepare("SELECT COUNT(*) AS n FROM passkeys").get().n;
    const sessionsBefore = w.db.prepare("SELECT COUNT(*) AS n FROM sessions").get().n;
    const res = await mallory.c.post("/api/lab/import", {
      schema_version: 2,
      username: alice.name,
      user_id: aliceUser.id,
      passkeys: [{ id: "forged", public_key: "AAAA", user_id: aliceUser.id }],
      sessions: [{ id: "forged-session", user_id: aliceUser.id }],
      lab: { title: "imported", user_id: aliceUser.id, passkeys: [{ id: "forged2" }] },
    });
    assert.equal(res.status, 200);
    assert.equal(w.db.prepare("SELECT COUNT(*) AS n FROM passkeys").get().n, keysBefore);
    assert.equal(w.db.prepare("SELECT COUNT(*) AS n FROM sessions").get().n, sessionsBefore);
    assert.equal(w.db.prepare("SELECT COUNT(*) AS n FROM passkeys WHERE id LIKE 'forged%'").get().n, 0);
    assert.equal((await mallory.c.get("/auth/me")).body.username, mallory.name);
    assert.equal((await alice.c.get("/api/lab")).body.title, "My lab");
    const forgedSession = w.client();
    forgedSession.cookie = "lab_plan_session=forged-session";
    assert.equal((await forgedSession.get("/api/lab")).status, 401);
  });
});
