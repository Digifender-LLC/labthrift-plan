// P03: passkeys and account lifecycle (PR-P6, FR-P1, FR-P2, FR-P8, FR-P9, SR-P6).
// Uses software passkeys against a disposable local database. Physical
// authenticators and production origins still need a manual check.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { startWorker, uniqueName } from "../support/harness.mjs";
import { SoftPasskey } from "../support/authenticator.mjs";

let w;
before(async () => {
  w = await startWorker();
});
after(async () => {
  await w?.stop();
});

const count = (sql, ...args) => w.db.prepare(sql).get(...args).n;
const userId = (name) => w.db.prepare("SELECT id FROM users WHERE username = ?").get(name)?.id;

async function account(prefix = "acct") {
  const c = w.client();
  const name = uniqueName(prefix);
  const res = await c.register(name);
  assert.equal(res.status, 200, res.text);
  return { c, name };
}

describe("registration", () => {
  test("creates the user, passkey, notebook and a session", async () => {
    const c = w.client();
    const name = uniqueName("reg");
    const opts = await c.post("/auth/register/options", { username: name });
    assert.equal(opts.status, 200);
    assert.equal(opts.body.options.rp.id, "localhost");
    assert.equal(opts.body.options.rp.name, "Labthrift");
    assert.equal(opts.body.options.authenticatorSelection.residentKey, "required");
    const res = await c.register(name);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { ok: true, username: name });
    assert.ok(c.cookie, "session cookie set");
    const me = await c.get("/auth/me");
    assert.equal(me.status, 200);
    assert.equal(me.body.username, name);
    assert.equal(me.body.userId, userId(name));
    assert.equal(me.body.passkey_count, 1);
    assert.equal(count("SELECT COUNT(*) AS n FROM labs WHERE user_id = ?", userId(name)), 1);
  });

  test("the session cookie is HttpOnly, Secure, SameSite=Lax and expires in 30 days", async () => {
    const c = w.client();
    const name = uniqueName("cookie");
    const opts = await c.post("/auth/register/options", { username: name });
    const pk = new SoftPasskey();
    const res = await c.request("/auth/register/verify", {
      method: "POST",
      raw: true,
      body: { username: name, userId: opts.body.userId, challenge: opts.body.options.challenge, credential: pk.register(opts.body.options, { origin: w.origin }) },
    });
    const cookie = res.headers.getSetCookie().find((s) => s.startsWith("lab_plan_session="));
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /Secure/i);
    assert.match(cookie, /SameSite=Lax/i);
    assert.match(cookie, /Path=\//);
    const expires = Date.parse(cookie.match(/Expires=([^;]+)/i)[1]);
    const days = (expires - Date.now()) / 864e5;
    assert.ok(days > 29.9 && days <= 30, `expires in ${days} days`);
  });

  test("rejects invalid and taken usernames", async () => {
    const c = w.client();
    for (const username of ["ab", "x".repeat(33), "has space", "a@b.c", "émile", "", null, 42]) {
      const res = await c.post("/auth/register/options", { username });
      assert.equal(res.status, 400, String(username));
      assert.equal(res.body.error, "invalid_username");
    }
    const { name } = await account("taken");
    const dupe = await c.post("/auth/register/options", { username: name.toUpperCase() });
    assert.equal(dupe.status, 409);
    assert.equal(dupe.body.error, "username_taken");
  });

  test("rejects a credential for the wrong origin or RP ID", async () => {
    for (const forge of [{ origin: "https://evil.example" }, { rpId: "evil.example" }]) {
      const c = w.client();
      const name = uniqueName("forge");
      const opts = await c.post("/auth/register/options", { username: name });
      const credential = new SoftPasskey().register(opts.body.options, { origin: w.origin, ...forge });
      const res = await c.post("/auth/register/verify", { username: name, userId: opts.body.userId, challenge: opts.body.options.challenge, credential });
      assert.equal(res.status, 400, JSON.stringify(forge));
      assert.equal(res.body.error, "verification_failed");
      assert.equal(userId(name), undefined);
      assert.equal(c.cookie, null);
    }
  });

  test("rejects a reused, foreign or mismatched challenge", async () => {
    const c = w.client();
    const name = uniqueName("chal");
    const opts = await c.post("/auth/register/options", { username: name });
    const pk = new SoftPasskey();
    const body = { username: name, userId: opts.body.userId, challenge: opts.body.options.challenge, credential: pk.register(opts.body.options, { origin: w.origin }) };

    const otherName = await c.post("/auth/register/verify", { ...body, username: uniqueName("other") });
    assert.equal(otherName.body.error, "challenge_invalid");
    // The mismatch attempt above does not consume the challenge; the genuine request still works.
    assert.equal((await c.post("/auth/register/verify", { ...body, userId: "someone-else" })).body.error, "challenge_invalid");
    assert.equal((await c.post("/auth/register/verify", body)).status, 200);
    const replay = await w.client().post("/auth/register/verify", body);
    assert.equal(replay.status, 400);
    assert.equal(replay.body.error, "challenge_invalid");
  });

  test("an expired registration challenge is rejected", async () => {
    const c = w.client();
    const name = uniqueName("exp");
    const opts = await c.post("/auth/register/options", { username: name });
    w.db.prepare("UPDATE webauthn_challenges SET expires_at = '2000-01-01T00:00:00.000Z' WHERE challenge = ?").run(opts.body.options.challenge);
    const credential = new SoftPasskey().register(opts.body.options, { origin: w.origin });
    const res = await c.post("/auth/register/verify", { username: name, userId: opts.body.userId, challenge: opts.body.options.challenge, credential });
    assert.equal(res.body.error, "challenge_invalid");
  });
});

describe("sign-in and sessions", () => {
  test("a registered passkey signs in on a new device", async () => {
    const { c, name } = await account("login");
    const device2 = w.client();
    const res = await device2.login(name, c.passkeys[0]);
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(res.body, { ok: true, username: name });
    assert.notEqual(device2.cookie, c.cookie, "a separate session per device");
    assert.equal((await device2.get("/auth/me")).body.username, name);
    assert.equal(count("SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?", userId(name)), 2);
  });

  test("failed sign-ins all look the same and create no session", async () => {
    const alice = await account("alice");
    const bob = await account("bob");
    const attempts = {
      unknownUser: await w.client().post("/auth/login/options", { username: uniqueName("nobody") }),
      wrongKey: await w.client().login(alice.name, bob.c.passkeys[0]),
      unregisteredKey: await w.client().login(alice.name, new SoftPasskey()),
      badSignature: await w.client().login(alice.name, alice.c.passkeys[0], { tamper: true }),
      wrongOrigin: await w.client().login(alice.name, alice.c.passkeys[0], { origin: "https://evil.example" }),
      wrongRpId: await w.client().login(alice.name, alice.c.passkeys[0], { rpId: "evil.example" }),
    };
    for (const [k, res] of Object.entries(attempts)) {
      assert.equal(res.status, 401, k);
      assert.equal(res.body.error, "invalid_credentials", k);
    }
    assert.equal(count("SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?", userId(alice.name)), 1);
  });

  test("a login challenge works once and only for its username", async () => {
    const { c, name } = await account("once");
    const other = await account("once_other");
    const d = w.client();
    const opts = await d.post("/auth/login/options", { username: name });
    const credential = c.passkeys[0].assert(opts.body.options, { origin: w.origin });
    const wrongUser = await d.post("/auth/login/verify", { username: other.name, challenge: opts.body.options.challenge, credential });
    assert.equal(wrongUser.status, 401);
    const ok = await d.post("/auth/login/verify", { username: name, challenge: opts.body.options.challenge, credential });
    assert.equal(ok.status, 200);
    const replay = await w.client().post("/auth/login/verify", { username: name, challenge: opts.body.options.challenge, credential });
    assert.equal(replay.status, 401);
  });

  test("/auth/me rejects missing, unknown and expired sessions", async () => {
    assert.equal((await w.client().get("/auth/me")).status, 401);
    const garbage = w.client();
    garbage.cookie = "lab_plan_session=not-a-session";
    assert.equal((await garbage.get("/auth/me")).status, 401);

    const { c, name } = await account("expiry");
    const sid = c.cookie.split("=")[1];
    w.db.prepare("UPDATE sessions SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(sid);
    const res = await c.get("/auth/me");
    assert.equal(res.status, 401);
    assert.equal(count("SELECT COUNT(*) AS n FROM sessions WHERE id = ?", sid), 0, "expired session is deleted");
    assert.equal(c.cookie, null, "cookie is cleared");
    assert.equal((await c.get("/api/lab")).status, 401);
    // Signing in again restores access to the same notebook.
    assert.equal((await c.login(name)).status, 200);
    assert.equal((await c.get("/api/lab")).status, 200);
  });

  test("logout ends only that device's session", async () => {
    const { c, name } = await account("logout");
    const device2 = w.client();
    await device2.login(name, c.passkeys[0]);
    const sid = c.cookie.split("=")[1];
    const res = await c.post("/auth/logout");
    assert.equal(res.status, 200);
    assert.equal(count("SELECT COUNT(*) AS n FROM sessions WHERE id = ?", sid), 0);
    const stale = w.client();
    stale.cookie = `lab_plan_session=${sid}`;
    assert.equal((await stale.get("/auth/me")).status, 401);
    assert.equal((await device2.get("/auth/me")).status, 200);
  });

  test("the per-session rate limit is a soft in-isolate bucket", async () => {
    // 120 requests per minute per session in one isolate. Production runs many
    // isolates, so this is not a global limit; the test documents the local bound.
    const { c } = await account("rate");
    let first429 = null;
    for (let i = 1; i <= 125; i++) {
      const res = await c.get("/auth/me");
      if (res.status === 429) {
        first429 = i;
        assert.equal(res.body.error, "rate_limited");
        break;
      }
    }
    assert.ok(first429 != null && first429 <= 121, `first 429 at request ${first429}`);
    assert.equal((await w.client().get("/auth/me")).status, 401, "requests without a session are not bucketed");
  });
});

describe("second-device enrollment", () => {
  test("requires a signed-in session to mint a code", async () => {
    const res = await w.client().post("/auth/enroll/create");
    assert.equal(res.status, 401);
  });

  test("a code enrolls one new passkey once, then stops working", async () => {
    const { c, name } = await account("enroll");
    const minted = await c.post("/auth/enroll/create");
    assert.equal(minted.status, 200);
    assert.match(minted.body.code, /^[A-HJ-NP-Z2-9]{8}$/);
    assert.equal(minted.body.url, `${w.origin}/?enroll=1&user=${name}&code=${minted.body.code}`);
    const minutes = (Date.parse(minted.body.expires_at) - Date.now()) / 60e3;
    assert.ok(minutes > 14 && minutes <= 15);
    const stored = w.db.prepare("SELECT code_hash FROM enroll_tokens WHERE user_id = ?").get(userId(name));
    assert.notEqual(stored.code_hash, minted.body.code, "only a hash is stored");

    const phone = w.client();
    const pk = new SoftPasskey();
    // Codes are case-insensitive and tolerate separators.
    const code = minted.body.code.toLowerCase().replace(/^(....)/, "$1-");
    const opts = await phone.post("/auth/enroll/options", { username: name, code });
    assert.equal(opts.status, 200, opts.text);
    assert.deepEqual(opts.body.options.excludeCredentials.map((k) => k.id), [c.passkeys[0].id]);
    const res = await phone.post("/auth/enroll/verify", {
      username: name,
      code,
      userId: opts.body.userId,
      challenge: opts.body.options.challenge,
      credential: pk.register(opts.body.options, { origin: w.origin }),
    });
    assert.equal(res.status, 200, res.text);
    assert.equal((await phone.get("/auth/me")).body.passkey_count, 2);
    assert.equal((await w.client().login(name, pk)).status, 200, "new passkey signs in");

    const reuse = await w.client().post("/auth/enroll/options", { username: name, code });
    assert.equal(reuse.status, 400);
    assert.equal(reuse.body.error, "invalid_enroll");
  });

  test("wrong, expired, superseded and cross-account codes are refused", async () => {
    const { c, name } = await account("enroll_bad");
    const other = await account("enroll_other");
    const first = (await c.post("/auth/enroll/create")).body.code;
    const second = (await c.post("/auth/enroll/create")).body.code;
    const ask = (username, code) => w.client().post("/auth/enroll/options", { username, code });

    assert.equal((await ask(name, first)).body.error, "invalid_enroll", "minting a new code revokes the old one");
    assert.equal((await ask(other.name, second)).body.error, "invalid_enroll", "code is bound to its account");
    assert.equal((await ask(name, "AAAAAAAA")).body.error, "invalid_enroll");
    assert.equal((await ask(name, "short")).body.error, "bad_request");
    assert.equal((await ask(uniqueName("ghost"), second)).body.error, "invalid_enroll");
    w.db.prepare("UPDATE enroll_tokens SET expires_at = '2000-01-01T00:00:00.000Z' WHERE user_id = ?").run(userId(name));
    assert.equal((await ask(name, second)).body.error, "invalid_enroll", "expired");
  });
});

describe("passkey management", () => {
  test("list, add, revoke, and protect the last passkey", async () => {
    const { c, name } = await account("keys");
    let list = await c.get("/auth/passkeys");
    assert.equal(list.status, 200);
    assert.equal(list.body.passkey_count, 1);
    assert.equal(list.body.passkeys[0].id, c.passkeys[0].id);
    assert.equal(list.body.passkeys[0].label, "Passkey 1");

    const last = await c.del(`/auth/passkeys/${encodeURIComponent(c.passkeys[0].id)}`);
    assert.equal(last.status, 400);
    assert.equal(last.body.error, "last_passkey");

    const opts = await c.post("/auth/passkeys/options");
    assert.equal(opts.status, 200);
    assert.deepEqual(opts.body.options.excludeCredentials.map((k) => k.id), [c.passkeys[0].id]);
    const added = new SoftPasskey();
    const verify = await c.post("/auth/passkeys/verify", {
      challenge: opts.body.options.challenge,
      credential: added.register(opts.body.options, { origin: w.origin }),
    });
    assert.equal(verify.status, 200, verify.text);
    assert.equal(verify.body.passkey_count, 2);
    list = await c.get("/auth/passkeys");
    assert.deepEqual(list.body.passkeys.map((k) => k.label), ["Passkey 1", "Passkey 2"]);

    const revoke = await c.del(`/auth/passkeys/${encodeURIComponent(c.passkeys[0].id)}`);
    assert.equal(revoke.status, 200);
    assert.equal(revoke.body.passkey_count, 1);
    assert.equal((await w.client().login(name, c.passkeys[0])).status, 401, "revoked key no longer signs in");
    assert.equal((await w.client().login(name, added)).status, 200);
    assert.equal((await c.del(`/auth/passkeys/${encodeURIComponent(added.id)}`)).body.error, "last_passkey");
  });

  test("passkey routes only touch the session owner's keys", async () => {
    const alice = await account("pk_alice");
    const bob = await account("pk_bob");
    // Give Bob two keys so the last-key guard is not what stops him.
    const opts = await bob.c.post("/auth/passkeys/options");
    await bob.c.post("/auth/passkeys/verify", {
      challenge: opts.body.options.challenge,
      credential: new SoftPasskey().register(opts.body.options, { origin: w.origin }),
    });
    const res = await bob.c.del(`/auth/passkeys/${encodeURIComponent(alice.c.passkeys[0].id)}`);
    assert.equal(res.status, 404);
    assert.equal(count("SELECT COUNT(*) AS n FROM passkeys WHERE user_id = ?", userId(alice.name)), 1);
    assert.equal((await bob.c.get("/auth/passkeys")).body.passkeys.some((k) => k.id === alice.c.passkeys[0].id), false);

    // Bob cannot complete an add-passkey ceremony that Alice started.
    const aliceOpts = await alice.c.post("/auth/passkeys/options");
    const stolen = await bob.c.post("/auth/passkeys/verify", {
      challenge: aliceOpts.body.options.challenge,
      credential: new SoftPasskey().register(aliceOpts.body.options, { origin: w.origin }),
    });
    assert.equal(stolen.status, 400);
    assert.equal(stolen.body.error, "challenge_invalid");
    assert.equal(count("SELECT COUNT(*) AS n FROM passkeys WHERE user_id = ?", userId(alice.name)), 1);
  });

  test("passkey management requires a session", async () => {
    const anon = w.client();
    assert.equal((await anon.get("/auth/passkeys")).status, 401);
    assert.equal((await anon.post("/auth/passkeys/options")).status, 401);
    assert.equal((await anon.post("/auth/passkeys/verify", {})).status, 401);
    assert.equal((await anon.del("/auth/passkeys/anything")).status, 401);
    assert.equal((await anon.del("/auth/me")).status, 401);
  });
});

describe("account deletion", () => {
  test("removes every record for that account and nothing else", async () => {
    const keep = await account("keep");
    const gone = await account("gone");
    const id = userId(gone.name);
    const device2 = w.client();
    await device2.login(gone.name, gone.c.passkeys[0]);
    await gone.c.post("/auth/enroll/create");
    await gone.c.post("/auth/passkeys/options"); // leaves a pending challenge
    const tables = ["users", "passkeys", "sessions", "labs", "enroll_tokens", "webauthn_challenges"];
    const owned = (t) => count(`SELECT COUNT(*) AS n FROM ${t} WHERE ${t === "users" ? "id" : "user_id"} = ?`, id);
    for (const t of tables) assert.ok(owned(t) > 0, `precondition: ${t}`);
    const keepCounts = tables.map((t) => count(`SELECT COUNT(*) AS n FROM ${t} WHERE ${t === "users" ? "id" : "user_id"} = ?`, userId(keep.name)));

    const res = await gone.c.del("/auth/me");
    assert.equal(res.status, 200);
    assert.equal(gone.c.cookie, null, "cookie cleared");
    for (const t of tables) assert.equal(owned(t), 0, `${t} cleaned`);
    assert.deepEqual(
      tables.map((t) => count(`SELECT COUNT(*) AS n FROM ${t} WHERE ${t === "users" ? "id" : "user_id"} = ?`, userId(keep.name))),
      keepCounts
    );
    assert.equal((await device2.get("/auth/me")).status, 401, "other devices are signed out");
    assert.equal((await w.client().login(gone.name, gone.c.passkeys[0])).status, 401);
    assert.equal((await keep.c.get("/api/lab")).status, 200);

    // The username becomes available again; nothing from the old account comes back.
    const again = w.client();
    assert.equal((await again.register(gone.name)).status, 200);
    assert.equal((await again.get("/api/lab")).body.title, "My lab");
    assert.equal((await again.get("/auth/me")).body.passkey_count, 1);
  });
});

describe("relying-party configuration", () => {
  test("production RP IDs and origins are configured, not inferred", async () => {
    const { readFileSync } = await import("node:fs");
    const raw = readFileSync(new URL("../../wrangler.jsonc", import.meta.url), "utf8");
    const vars = JSON.parse(raw.replace(/^\s*\/\/.*$/gm, "")).vars;
    assert.deepEqual(vars.WEBAUTHN_RP_ID.split(","), ["labthrift.com", "lab-plan.lmao.workers.dev"]);
    assert.deepEqual(vars.WEBAUTHN_ORIGIN.split(","), [
      "https://plan.labthrift.com",
      "https://lab-plan.lmao.workers.dev",
      "https://app.labthrift.com",
    ]);
  });
});
