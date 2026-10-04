// Browser checks for P01 (autosave and conflict states), P02 (import confirmation),
// P03 (passkey UI) and P04 (offline behavior), against the real SPA and Worker.
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { startWorker, uniqueName } from "../support/harness.mjs";
import { createAccount, device, launch, sessionCookie, swControlled } from "../support/browser.mjs";

let w;
let browser;
let scratch;
before(async () => {
  w = await startWorker();
  browser = await launch();
  scratch = mkdtempSync(join(tmpdir(), "lab-plan-browser-"));
});
after(async () => {
  await browser?.close();
  await w?.stop();
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

const saveMsg = (page) => page.locator("#saveMsg");
const serverLab = async (context) => {
  const api = w.client();
  api.cookie = await sessionCookie(context);
  return (await api.get("/api/lab")).body;
};

async function signedInDevice(prefix) {
  const d = await device(browser, w.origin);
  const name = uniqueName(prefix);
  await createAccount(d.page, name);
  return { ...d, name };
}

describe("autosave", () => {
  test("an edit shows Saving… then Saved and survives a reload", async () => {
    const { context, page, errors } = await signedInDevice("ui_save");
    await page.locator("#labTitle").fill("Garage rack");
    await assert.doesNotReject(page.waitForFunction(() => /^Saved /.test(document.querySelector("#saveMsg").textContent)));
    assert.equal((await serverLab(context)).title, "Garage rack");
    await page.reload();
    await page.locator("#who").waitFor();
    assert.equal(await page.locator("#labTitle").inputValue(), "Garage rack");
    assert.deepEqual(errors, []);
    await context.close();
  });

  test("typing while a slow save is in flight never conflicts with itself", async () => {
    const { context, page } = await signedInDevice("ui_slow");
    // Every save takes 1.2 s, longer than the autosave debounce.
    await page.route("**/api/lab", async (route) => {
      if (route.request().method() === "PUT") await new Promise((r) => setTimeout(r, 1200));
      await route.continue();
    });
    const title = page.locator("#labTitle");
    for (const text of ["Slow", "Slow link", "Slow link lab", "Slow link lab final"]) {
      await title.fill(text);
      await page.waitForTimeout(700);
    }
    await page.waitForFunction(() => /^Saved /.test(document.querySelector("#saveMsg").textContent), null, { timeout: 15_000 });
    await page.waitForTimeout(1500);
    assert.equal(await page.locator("#conflictBar").isHidden(), true, "no false conflict");
    assert.match(await saveMsg(page).textContent(), /^Saved /);
    assert.equal((await serverLab(context)).title, "Slow link lab final");
    await context.close();
  });

  test("a save failure keeps the change unsaved and says so", async () => {
    const { context, page } = await signedInDevice("ui_fail");
    await page.route("**/api/lab", (route) => (route.request().method() === "PUT" ? route.abort("connectionreset") : route.continue()));
    await page.locator("#labTitle").fill("Will fail");
    await page.waitForFunction(() => /Couldn't save/.test(document.querySelector("#saveMsg").textContent));
    assert.notEqual((await serverLab(context)).title, "Will fail");
    await page.unroute("**/api/lab");
    await page.locator("#saveBtn").click();
    await page.waitForFunction(() => /^Saved /.test(document.querySelector("#saveMsg").textContent));
    assert.equal((await serverLab(context)).title, "Will fail");
    await context.close();
  });

  test("a server error is reported, not shown as saved", async () => {
    const { context, page } = await signedInDevice("ui_500");
    await page.route("**/api/lab", (route) =>
      route.request().method() === "PUT" ? route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"boom"}' }) : route.continue()
    );
    await page.locator("#labTitle").fill("Server says no");
    await page.waitForFunction(() => /Couldn't save — retry: boom/.test(document.querySelector("#saveMsg").textContent));
    await context.close();
  });
});

describe("conflicts between devices", () => {
  test("a stale device sees the conflict bar; Reload shows the other device's notebook", async () => {
    const { context, page } = await signedInDevice("ui_conflict");
    const other = w.client();
    other.cookie = await sessionCookie(context);
    const cur = (await other.get("/api/lab")).body;
    assert.equal((await other.put("/api/lab", { title: "From the laptop", updated_at: cur.updated_at })).status, 200);

    await page.locator("#labTitle").fill("From the phone");
    await page.locator("#conflictBar").waitFor({ state: "visible" });
    assert.equal(await saveMsg(page).textContent(), "Conflict — open elsewhere");
    assert.equal((await serverLab(context)).title, "From the laptop", "conflict did not overwrite");

    await page.locator("#conflictReload").click();
    await page.waitForFunction(() => document.querySelector("#saveMsg").textContent === "Reloaded from server");
    assert.equal(await page.locator("#labTitle").inputValue(), "From the laptop");
    assert.equal(await page.locator("#conflictBar").isHidden(), true);
    await context.close();
  });

  test("Force save keeps this device's version after a conflict", async () => {
    const { context, page } = await signedInDevice("ui_force");
    const other = w.client();
    other.cookie = await sessionCookie(context);
    const cur = (await other.get("/api/lab")).body;
    await other.put("/api/lab", { title: "Other device", updated_at: cur.updated_at });

    await page.locator("#labTitle").fill("This device");
    await page.locator("#conflictBar").waitFor({ state: "visible" });
    await page.locator("#conflictForce").click();
    await page.waitForFunction(() => /^Saved /.test(document.querySelector("#saveMsg").textContent));
    assert.equal(await page.locator("#conflictBar").isHidden(), true);
    assert.equal((await serverLab(context)).title, "This device");
    // Ordinary saves continue from the forced version without conflicting.
    await page.locator("#labTitle").fill("This device, again");
    await page.waitForTimeout(800);
    await page.waitForFunction(() => /^Saved /.test(document.querySelector("#saveMsg").textContent));
    assert.equal((await serverLab(context)).title, "This device, again");
    await context.close();
  });
});

describe("offline", () => {
  test("offline edits are never reported as saved and sync on reconnect", async () => {
    // Browser-level offline (navigator.onLine false). Service workers are blocked here because
    // Chromium's offline emulation does not cover service-worker fetches.
    const d = await device(browser, w.origin, { serviceWorkers: "block" });
    await createAccount(d.page, uniqueName("ui_offline"));
    const { context, page } = d;
    await context.setOffline(true);
    await page.locator("#offlineBanner").waitFor({ state: "visible" });
    const banner = await page.locator("#offlineBanner").textContent();
    assert.match(banner, /not saved/i, "banner does not promise local persistence");
    await page.locator("#labTitle").fill("Edited offline");
    await page.waitForTimeout(800);
    assert.doesNotMatch(await saveMsg(page).textContent(), /^Saved/);
    assert.match(await saveMsg(page).textContent(), /Offline/);

    await context.setOffline(false);
    await page.waitForFunction(() => /^Saved /.test(document.querySelector("#saveMsg").textContent));
    assert.equal(await page.locator("#offlineBanner").isHidden(), true);
    assert.equal((await serverLab(context)).title, "Edited offline");
    await context.close();
  });

  test("a server outage is reported as unsaved and recovers without a browser online event", async () => {
    const { context, page } = await signedInDevice("ui_outage");
    w.setReachable(false);
    try {
      await page.locator("#labTitle").fill("During outage");
      await page.waitForFunction(() => /Couldn't save/.test(document.querySelector("#saveMsg").textContent));
      await page.locator("#offlineBanner").waitFor({ state: "visible" });
    } finally {
      w.setReachable(true);
    }
    // The next edit retries even though the browser never reported going offline.
    await page.locator("#labTitle").fill("After outage");
    await page.waitForFunction(() => /^Saved /.test(document.querySelector("#saveMsg").textContent));
    assert.equal(await page.locator("#offlineBanner").isHidden(), true);
    assert.equal((await serverLab(context)).title, "After outage");
    await context.close();
  });

  test("the service worker installs and serves the offline page, not a cached session", async () => {
    const { context, page } = await signedInDevice("ui_sw");
    await swControlled(page);
    w.setReachable(false);
    try {
      await page.reload();
      await page.getByText("Lab plan is offline").waitFor();
      assert.equal(await page.locator("#who").count(), 0, "no app shell or username offline");
      const me = await page.evaluate(async () => {
        const r = await fetch("/auth/me");
        return { status: r.status, body: await r.json() };
      });
      assert.deepEqual(me, { status: 503, body: { error: "offline" } }, "session checks fail closed");
    } finally {
      w.setReachable(true);
    }
    await page.reload();
    await page.locator("#who").waitFor({ state: "visible" });
    await context.close();
  });

  test("a service-worker offline reply keeps the offline state instead of looking online", async () => {
    const { context, page } = await signedInDevice("ui_sw503");
    await swControlled(page);
    const other = w.client();
    other.cookie = await sessionCookie(context);
    const cur = (await other.get("/api/lab")).body;
    await other.put("/api/lab", { title: "elsewhere", updated_at: cur.updated_at });
    await page.locator("#labTitle").fill("here");
    await page.locator("#conflictBar").waitFor({ state: "visible" });
    w.setReachable(false);
    try {
      // Reload goes through the service worker, which answers 503 {error:"offline"}.
      await page.locator("#conflictReload").click();
      await page.waitForFunction(() => /Reload failed/.test(document.querySelector("#saveMsg").textContent));
      assert.equal(await page.locator("#offlineBanner").isVisible(), true);
      assert.equal(await page.locator("#labTitle").inputValue(), "here", "unsaved edit is kept");
    } finally {
      w.setReachable(true);
    }
    await context.close();
  });
});

describe("import and export", () => {
  test("import asks for confirmation before replacing, and cancel changes nothing", async () => {
    const { context, page } = await signedInDevice("ui_import");
    await page.locator("#labTitle").fill("Keep me");
    await page.waitForFunction(() => /^Saved /.test(document.querySelector("#saveMsg").textContent));
    const file = join(scratch, "import.json");
    writeFileSync(file, JSON.stringify({ schema_version: 2, lab: { title: "Imported lab", hosts: [{ hostname: "nas" }] } }));

    await page.goto("/#settings");
    let message = "";
    page.once("dialog", (d) => ((message = d.message()), d.dismiss()));
    await page.locator("#importFile").setInputFiles(file);
    await page.waitForTimeout(300);
    assert.match(message, /Replace your current lab plan/);
    assert.match(message, /cannot be undone/);
    assert.equal((await serverLab(context)).title, "Keep me");

    page.once("dialog", (d) => d.accept());
    await page.locator("#importFile").setInputFiles(file);
    await page.waitForFunction(() => document.querySelector("#saveMsg").textContent === "Imported lab JSON");
    assert.equal(await page.locator("#labTitle").inputValue(), "Imported lab");
    assert.equal((await serverLab(context)).title, "Imported lab");
    await context.close();
  });

  test("an unsupported file version is refused in the browser before upload", async () => {
    const { context, page } = await signedInDevice("ui_import_v9");
    const file = join(scratch, "v9.json");
    writeFileSync(file, JSON.stringify({ schema_version: 9, lab: { title: "future" } }));
    await page.goto("/#settings");
    page.once("dialog", (d) => d.accept());
    await page.locator("#importFile").setInputFiles(file);
    await page.locator("#setErr").waitFor({ state: "visible" });
    assert.match(await page.locator("#setErr").textContent(), /Unsupported schema_version/);
    assert.equal((await serverLab(context)).title, "My lab");
    await context.close();
  });

  test("imported text is rendered as text, never as markup", async () => {
    const { context, page } = await signedInDevice("ui_xss");
    const payload = "<img src=x onerror=window.__xss=1>";
    const api = w.client();
    api.cookie = await sessionCookie(context);
    const res = await api.post("/api/lab/import", {
      schema_version: 2,
      lab: {
        title: payload,
        inventory: [{ id: 'x" onfocus="window.__xss=2', name: payload, role: "<img src=x onerror=window.__xss=3>".slice(0, 24), ramGb: 8 }],
        services: [{ name: payload, hostId: 'x" onfocus="window.__xss=2', ramMb: 100 }],
        hosts: [{ hostname: payload, ip: payload, note: payload }],
        bom: [{ slug: payload, note: payload }],
        closet: { units: 4, slots: [{ start: 1, name: payload }], ports: [{ port: "1", label: payload }] },
        powerNote: payload,
        upsVa: 500,
      },
    });
    assert.equal(res.status, 200);
    await page.reload();
    await page.locator("#who").waitFor();
    for (const pane of ["stuff", "services", "headroom", "closet", "hosts", "bom", "settings"]) {
      await page.goto(`/#${pane}`);
      await page.waitForTimeout(150);
    }
    await page.locator("details.inv-specs").first().evaluate((d) => (d.open = true)).catch(() => {});
    await page.goto("/#headroom");
    await page.waitForTimeout(300);
    assert.equal(await page.evaluate(() => window.__xss), undefined);
    assert.equal(await page.locator("img[src='x']").count(), 0);
    await context.close();
  });
});

describe("passkeys and account in the browser", () => {
  test("sign out and back in with the device passkey", async () => {
    const { context, page, name } = await signedInDevice("ui_login");
    await page.locator("#logoutBtn").click();
    await page.locator("#gate").waitFor({ state: "visible" });
    await page.locator("#username").fill(name);
    await page.locator("#signinBtn").click();
    await page.locator("#who").waitFor({ state: "visible" });
    assert.equal(await page.locator("#who").textContent(), "@" + name);
    await context.close();
  });

  test("a failed sign-in shows a readable message", async () => {
    const { context, page } = await signedInDevice("ui_badlogin");
    await page.locator("#logoutBtn").click();
    await page.locator("#username").fill(uniqueName("nobody"));
    await page.locator("#signinBtn").click();
    await page.locator("#gateErr").waitFor({ state: "visible" });
    assert.doesNotMatch(await page.locator("#gateErr").textContent(), /invalid_credentials/);
    await context.close();
  });

  test("the only passkey cannot be removed, and the nudge offers a second one", async () => {
    const { context, page } = await signedInDevice("ui_lastkey");
    await page.locator("#passkeyNudge").waitFor({ state: "visible" });
    await page.goto("/#settings");
    await page.locator("#passkeyList").getByText("Passkey 1").waitFor();
    assert.equal(await page.locator("#passkeyList button").count(), 0, "no remove button for the last passkey");
    await context.close();
  });

  test("deleting the account returns to the gate and ends the session", async () => {
    const { context, page, name } = await signedInDevice("ui_delete");
    const cookie = await sessionCookie(context);
    await page.goto("/#settings");
    page.once("dialog", (d) => d.accept());
    await page.locator("#deleteBtn").click();
    await page.locator("#gate").waitFor({ state: "visible" });
    const api = w.client();
    api.cookie = cookie;
    assert.equal((await api.get("/auth/me")).status, 401);
    assert.equal(w.db.prepare("SELECT COUNT(*) AS n FROM users WHERE username = ?").get(name).n, 0);
    await context.close();
  });
});
