// Browser helpers: Chromium via playwright-core with a CDP virtual authenticator,
// so the real app.js passkey flows run without a physical device.
import { chromium } from "playwright-core";

export async function launch() {
  try {
    return await chromium.launch({ executablePath: process.env.PLAN_TEST_CHROMIUM || undefined });
  } catch (e) {
    throw new Error(
      "Chromium for browser checks is missing. Run `npx playwright-core install chromium` " +
        "or set PLAN_TEST_CHROMIUM to a Chromium executable.\n" + e.message
    );
  }
}

/** A fresh browser profile (one "device") with its own virtual platform authenticator. */
export async function device(browser, origin, { serviceWorkers = "allow" } = {}) {
  const context = await browser.newContext({ baseURL: origin, serviceWorkers });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e));
  return { context, page, cdp, authenticatorId, errors };
}

/** Create an account through the gate UI and wait for the notebook to load. */
export async function createAccount(page, username) {
  // app.js binds the gate buttons before its first session check, so wait for that request.
  const booted = page.waitForResponse((r) => r.url().endsWith("/auth/me"));
  await page.goto("/");
  await booted;
  await page.locator("#username").fill(username);
  await page.locator("#createBtn").click();
  await page.locator("#who").waitFor({ state: "visible" });
  // Dismiss the first-run tour if it opened.
  const skip = page.locator("#tourSkip");
  if (await skip.isVisible().catch(() => false)) await skip.click();
}

/** Copy the browser's session cookie into an API client (same account, second device). */
export async function sessionCookie(context) {
  const c = (await context.cookies()).find((x) => x.name === "lab_plan_session");
  return c ? `lab_plan_session=${c.value}` : null;
}

/** Wait until the app's service worker controls the page. */
export async function swControlled(page) {
  await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 15_000 });
}
