import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from "@simplewebauthn/server";
import type {
  AuthenticatorTransportFuture,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
  AuthenticationResponseJSON,
} from "@simplewebauthn/server";

type Env = {
  DB: D1Database;
  ASSETS: Fetcher;
  WEBAUTHN_RP_NAME?: string;
  WEBAUTHN_RP_ID?: string;
  WEBAUTHN_ORIGIN?: string;
};

type Vars = { userId: string; username: string };

const SESSION = "lab_plan_session";
const SESSION_DAYS = 30;
const MAX_ITEMS = 100;
const USERNAME_RE = /^[a-zA-Z0-9_-]{3,32}$/;

const CHECKLIST_DEFAULT: Record<string, { label: string; href: string; done: boolean }> = {
  "start-with-what-you-have": {
    label: "Start with what you already have",
    href: "https://labthrift.com/guides/start-with-what-you-have",
    done: false,
  },
  "wipe-marketplace-pc": {
    label: "Wipe a Marketplace PC before you install",
    href: "https://labthrift.com/guides/wipe-marketplace-pc",
    done: false,
  },
  "make-boot-usb": {
    label: "Make a boot USB for the install",
    href: "https://labthrift.com/guides/make-boot-usb",
    done: false,
  },
  "what-os-to-pick": {
    label: "What OS to put on it",
    href: "https://labthrift.com/guides/what-os-to-pick",
    done: false,
  },
  "first-weekend": {
    label: "Your first weekend",
    href: "https://labthrift.com/guides/first-weekend",
    done: false,
  },
  "find-the-leftover-box": {
    label: "Find it on the house network",
    href: "https://labthrift.com/guides/find-the-leftover-box",
    done: false,
  },
  "first-ssh": {
    label: "SSH from the couch",
    href: "https://labthrift.com/guides/first-ssh",
    done: false,
  },
  "first-useful-service": {
    label: "The first useful thing (ad block)",
    href: "https://labthrift.com/guides/first-useful-service",
    done: false,
  },
  "first-file-share": {
    label: "A file share",
    href: "https://labthrift.com/guides/first-file-share",
    done: false,
  },
  "first-backup": {
    label: "A backup of the house folder",
    href: "https://labthrift.com/guides/first-backup",
    done: false,
  },
  "local-chat-on-the-pc": {
    label: "Run a local chat on the old PC",
    href: "https://labthrift.com/guides/local-chat-on-the-pc",
    done: false,
  },
};

const app = new Hono<{ Bindings: Env; Variables: Vars }>();

const SCHEMA_VERSION = 2;
const SESSION_RL_LIMIT = 120;
const SESSION_RL_WINDOW_MS = 60_000;
const sessionRateBuckets = new Map<string, { count: number; resetAt: number }>();

/** Soft per-session bucket (in-isolate). Complements CF bot/IP edges. */
function takeSessionRate(sid: string): boolean {
  const now = Date.now();
  let b = sessionRateBuckets.get(sid);
  if (!b || now >= b.resetAt) {
    b = { count: 0, resetAt: now + SESSION_RL_WINDOW_MS };
    sessionRateBuckets.set(sid, b);
  }
  b.count += 1;
  return b.count <= SESSION_RL_LIMIT;
}

function applySecurityHeaders(headers: Headers) {
  if (!headers.has("Content-Security-Policy")) {
    headers.set(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
    );
  }
  if (!headers.has("X-Frame-Options")) headers.set("X-Frame-Options", "DENY");
  if (!headers.has("Referrer-Policy")) headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  if (!headers.has("X-Content-Type-Options")) headers.set("X-Content-Type-Options", "nosniff");
  if (!headers.has("Permissions-Policy")) {
    headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  }
}

app.use("*", async (c, next) => {
  await next();
  try {
    applySecurityHeaders(c.res.headers);
  } catch {
    // Immutable asset Response — rebuild with mutable headers
    const headers = new Headers(c.res.headers);
    applySecurityHeaders(headers);
    c.res = new Response(c.res.body, {
      status: c.res.status,
      statusText: c.res.statusText,
      headers,
    });
  }
});

app.use("/api/*", async (c, next) => {
  const sid = getCookie(c, SESSION);
  if (sid && !takeSessionRate(sid)) {
    return c.json({ error: "rate_limited" }, 429);
  }
  await next();
});

app.use("/auth/*", async (c, next) => {
  const sid = getCookie(c, SESSION);
  if (sid && !takeSessionRate(sid)) {
    return c.json({ error: "rate_limited" }, 429);
  }
  await next();
});

function nowIso() {
  return new Date().toISOString();
}


function utcDay(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

/** Best-effort bot vs human. Never persist IP or raw UA. */
function isBotRequest(c: { req: { raw: Request; header: (n: string) => string | undefined } }): boolean {
  const req = c.req.raw;
  const cf = req.cf as { botManagement?: { verifiedBot?: boolean; score?: number } } | undefined;
  const bm = cf?.botManagement;
  if (bm?.verifiedBot === true) return true;
  const score = typeof bm?.score === "number" ? bm.score : null;
  // CF Bot Management: 1–29 ≈ bot. Free tier may expose dummy scores — UA still applies.
  if (score != null && score >= 1 && score <= 29) return true;
  const ua = c.req.header("user-agent") || "";
  if (!ua.trim()) return true;
  return /bot|crawl|spider|slurp|scrapy|wget|curl|python-requests|httpclient|headless|preview|monitor|uptime|pingdom|facebookexternalhit|linkedinbot|twitterbot|slackbot|discordbot|applebot|bingbot|googlebot|bytespider|semrush|ahrefs/i.test(
    ua
  );
}

async function bumpMetric(db: D1Database, metric: string) {
  const day = utcDay();
  await db
    .prepare(
      `INSERT INTO metric_daily (day, metric, count) VALUES (?, ?, 1)
       ON CONFLICT(day, metric) DO UPDATE SET count = count + 1`
    )
    .bind(day, metric)
    .run();
}

function scheduleMetric(c: any, metric: string) {
  const task = bumpMetric(c.env.DB, metric).catch(() => {});
  try {
    c.executionCtx.waitUntil(task);
  } catch {
    // ignore if no executionCtx (tests)
  }
}


function b64url(buf: ArrayBuffer | Uint8Array): string {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]!);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(s: string): Uint8Array<ArrayBuffer> {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const b64 = (s + pad).replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function webAuthnUserId(value: string): Uint8Array<ArrayBuffer> {
  const encoded = new TextEncoder().encode(value);
  const out = new Uint8Array(new ArrayBuffer(encoded.length));
  out.set(encoded);
  return out;
}

function randomId(): string {
  const a = new Uint8Array(16);
  crypto.getRandomValues(a);
  return b64url(a);
}

function normalizeUsername(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const u = raw.trim();
  if (!USERNAME_RE.test(u)) return null;
  if (u.includes("@")) return null;
  return u;
}


async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

const ENROLL_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function enrollCode(): string {
  const a = new Uint8Array(8);
  crypto.getRandomValues(a);
  let out = "";
  for (let i = 0; i < 8; i++) out += ENROLL_ALPHABET[a[i]! % ENROLL_ALPHABET.length];
  return out;
}

function normalizeEnrollCode(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const c = raw.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (c.length !== 8) return null;
  for (const ch of c) {
    if (!ENROLL_ALPHABET.includes(ch)) return null;
  }
  return c;
}


function splitCsv(v: string | undefined): string[] {
  if (!v) return [];
  return v
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function rpConfig(c: { req: { url: string; header: (n: string) => string | undefined }; env: Env }) {
  const url = new URL(c.req.url);
  const host = url.hostname;
  const origin = url.origin;
  const rpIds = splitCsv(c.env.WEBAUTHN_RP_ID);
  const origins = splitCsv(c.env.WEBAUTHN_ORIGIN);
  const rpID = rpIds.includes(host) ? host : rpIds[0] || host;
  const expectedOrigins = origins.length ? origins : [origin];
  if (!expectedOrigins.includes(origin)) expectedOrigins.push(origin);
  return {
    rpID,
    rpName: c.env.WEBAUTHN_RP_NAME || "Lab plan",
    expectedOrigins,
    origin,
  };
}

async function createSession(db: D1Database, userId: string) {
  const id = randomId();
  const created = nowIso();
  const expires = new Date(Date.now() + SESSION_DAYS * 864e5).toISOString();
  await db
    .prepare("INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)")
    .bind(id, userId, expires, created)
    .run();
  return { id, expires };
}

function setSessionCookie(c: any, id: string, expires: string) {
  setCookie(c, SESSION, id, {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: "/",
    expires: new Date(expires),
  });
}

async function requireUser(c: any, next: () => Promise<void>) {
  const sid = getCookie(c, SESSION);
  if (!sid) return c.json({ error: "unauthorized" }, 401);
  const row = await c.env.DB.prepare(
    `SELECT s.id AS sid, s.expires_at, u.id AS user_id, u.username
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.id = ?`
  )
    .bind(sid)
    .first<{ sid: string; expires_at: string; user_id: string; username: string }>();
  if (!row || row.expires_at < nowIso()) {
    if (sid) await c.env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(sid).run();
    deleteCookie(c, SESSION, { path: "/" });
    return c.json({ error: "unauthorized" }, 401);
  }
  c.set("userId", row.user_id);
  c.set("username", row.username);
  await next();
}

async function saveChallenge(
  db: D1Database,
  kind: string,
  challenge: string,
  username: string | null,
  userId: string | null
) {
  const id = randomId();
  const expires = new Date(Date.now() + 5 * 60e3).toISOString();
  await db
    .prepare(
      `INSERT INTO webauthn_challenges (id, username, user_id, kind, challenge, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .bind(id, username, userId, kind, challenge, expires)
    .run();
  return id;
}

async function takeChallenge(db: D1Database, kind: string, challenge: string) {
  const row = await db
    .prepare(
      `SELECT id, username, user_id, challenge, expires_at FROM webauthn_challenges
       WHERE kind = ? AND challenge = ?`
    )
    .bind(kind, challenge)
    .first<{ id: string; username: string | null; user_id: string | null; challenge: string; expires_at: string }>();
  if (!row || row.expires_at < nowIso()) return null;
  await db.prepare("DELETE FROM webauthn_challenges WHERE id = ?").bind(row.id).run();
  return row;
}

function emptyLab() {
  return {
    title: "My lab",
    inventory: [] as unknown[],
    services: [] as unknown[],
    checklist: structuredClone(CHECKLIST_DEFAULT),
    closet: { units: 12, slots: [] as unknown[], ports: [] as unknown[] },
    hosts: [] as unknown[],
    bom: [] as unknown[],
    upsVa: undefined as number | undefined,
    powerNote: undefined as string | undefined,
  };
}

function optNum(v: unknown, min: number, max: number): number | undefined {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  if (!Number.isFinite(n)) return undefined;
  return Math.min(max, Math.max(min, n));
}

function sanitizeInventoryItem(raw: any) {
  const it: {
    id?: string;
    name: string;
    note: string;
    role?: string;
    cpu?: number;
    ramGb?: number;
    storageGb?: number;
    watts?: number;
    needsAttention?: boolean;
    attentionNote?: string;
  } = {
    name: typeof raw?.name === "string" ? raw.name.slice(0, 120) : "",
    note: typeof raw?.note === "string" ? raw.note.slice(0, 240) : "",
  };
  if (typeof raw?.id === "string" && raw.id.length <= 64) it.id = raw.id;
  // role: known enum or short free text
  if (typeof raw?.role === "string") {
    const role = raw.role.trim().slice(0, 24);
    if (role) it.role = role;
  }
  const cpu = optNum(raw?.cpu, 0, 512);
  if (cpu != null) it.cpu = cpu;
  const ramGb = optNum(raw?.ramGb, 0, 4096);
  if (ramGb != null) it.ramGb = ramGb;
  const storageGb = optNum(raw?.storageGb, 0, 1_048_576);
  if (storageGb != null) it.storageGb = storageGb;
  const watts = optNum(raw?.watts, 0, 50_000);
  if (watts != null) it.watts = watts;
  if (raw?.needsAttention === true) it.needsAttention = true;
  if (typeof raw?.attentionNote === "string" && raw.attentionNote.trim()) {
    it.attentionNote = raw.attentionNote.slice(0, 240);
  }
  return it;
}

function sanitizeService(raw: any) {
  const it: {
    id?: string;
    name: string;
    hostId?: string;
    ramMb?: number;
    cpuPct?: number;
    notes?: string;
    url?: string;
  } = {
    name: typeof raw?.name === "string" ? raw.name.slice(0, 120) : "",
  };
  if (typeof raw?.id === "string" && raw.id.length <= 64) it.id = raw.id;
  if (typeof raw?.hostId === "string" && raw.hostId.length <= 64) it.hostId = raw.hostId;
  const ramMb = optNum(raw?.ramMb, 0, 1_048_576);
  if (ramMb != null) it.ramMb = ramMb;
  const cpuPct = optNum(raw?.cpuPct, 0, 1000);
  if (cpuPct != null) it.cpuPct = cpuPct;
  if (typeof raw?.notes === "string" && raw.notes.trim()) it.notes = raw.notes.slice(0, 240);
  if (typeof raw?.url === "string" && raw.url.trim()) it.url = raw.url.slice(0, 300);
  return it;
}

function sanitizeCapacity(body: any): { upsVa?: number; powerNote?: string } {
  const out: { upsVa?: number; powerNote?: string } = {};
  const upsVa = optNum(body?.upsVa, 0, 100_000);
  if (upsVa != null) out.upsVa = upsVa;
  if (typeof body?.powerNote === "string" && body.powerNote.trim()) {
    out.powerNote = body.powerNote.slice(0, 240);
  }
  return out;
}

function sanitizeSlot(raw: any, units: number) {
  let start = Math.max(1, Number(raw?.start ?? raw?.startU ?? raw?.u) || 1);
  let height = Math.max(1, Number(raw?.height) || 1);
  if (start > units) start = units;
  if (start + height - 1 > units) height = Math.max(1, units - start + 1);
  const slot: { start: number; height: number; name: string; inventoryId?: string } = {
    start,
    height,
    name: typeof raw?.name === "string" ? raw.name.slice(0, 80) : "",
  };
  if (typeof raw?.inventoryId === "string" && raw.inventoryId.length <= 64) {
    slot.inventoryId = raw.inventoryId;
  }
  return slot;
}

function sanitizePort(raw: any) {
  return {
    port: typeof raw?.port === "string" || typeof raw?.port === "number" ? String(raw.port).slice(0, 8) : "",
    label: typeof raw?.label === "string" ? raw.label.slice(0, 40) : "",
  };
}

function sanitizeHost(raw: any) {
  return {
    hostname: typeof raw?.hostname === "string" ? raw.hostname.slice(0, 80) : "",
    ip: typeof raw?.ip === "string" ? raw.ip.slice(0, 64) : "",
    note: typeof raw?.note === "string" ? raw.note.slice(0, 160) : "",
  };
}

function sanitizeBom(raw: any) {
  const status = raw?.status === "skip" || raw?.status === "bought" ? raw.status : "consider";
  let slug = typeof raw?.slug === "string" ? raw.slug.slice(0, 160) : "";
  const m = slug.match(/labthrift\.com\/guides\/([^/?#]+)/i);
  if (m) slug = m[1]!;
  return {
    slug,
    status,
    note: typeof raw?.note === "string" ? raw.note.slice(0, 240) : "",
  };
}

function clampLab(body: any) {
  const base = emptyLab();
  if (body && typeof body.title === "string") base.title = body.title.slice(0, 80);
  if (Array.isArray(body?.inventory)) {
    base.inventory = body.inventory.slice(0, MAX_ITEMS).map(sanitizeInventoryItem);
  }
  if (Array.isArray(body?.services)) {
    base.services = body.services.slice(0, MAX_ITEMS).map(sanitizeService);
  }
  if (body?.checklist && typeof body.checklist === "object") {
    const out: typeof CHECKLIST_DEFAULT = structuredClone(CHECKLIST_DEFAULT);
    for (const [k] of Object.entries(out)) {
      const incoming = (body.checklist as any)[k];
      if (incoming && typeof incoming === "object") out[k]!.done = !!incoming.done;
    }
    base.checklist = out;
  }
  if (body?.closet && typeof body.closet === "object") {
    const units = Math.min(42, Math.max(1, Number(body.closet.units) || 12));
    base.closet = {
      units,
      slots: Array.isArray(body.closet.slots)
        ? body.closet.slots.slice(0, MAX_ITEMS).map((s: any) => sanitizeSlot(s, units))
        : [],
      ports: Array.isArray(body.closet.ports)
        ? body.closet.ports.slice(0, MAX_ITEMS).map(sanitizePort)
        : [],
    };
  }
  if (Array.isArray(body?.hosts)) base.hosts = body.hosts.slice(0, MAX_ITEMS).map(sanitizeHost);
  if (Array.isArray(body?.bom)) base.bom = body.bom.slice(0, MAX_ITEMS).map(sanitizeBom);
  const cap = sanitizeCapacity(body);
  if (cap.upsVa != null) base.upsVa = cap.upsVa;
  else delete (base as any).upsVa;
  if (cap.powerNote != null) base.powerNote = cap.powerNote;
  else delete (base as any).powerNote;
  return base;
}

async function getLab(db: D1Database, userId: string) {
  const row = await db
    .prepare(
      `SELECT id, title, inventory_json, checklist_json, closet_json, hosts_json, bom_json,
              services_json, capacity_json, updated_at
       FROM labs WHERE user_id = ?`
    )
    .bind(userId)
    .first<{
      id: string;
      title: string;
      inventory_json: string;
      checklist_json: string;
      closet_json: string;
      hosts_json: string;
      bom_json: string;
      services_json: string;
      capacity_json: string;
      updated_at: string;
    }>();
  if (!row) return null;
  const checklist = { ...CHECKLIST_DEFAULT, ...JSON.parse(row.checklist_json || "{}") };
  const capacity = JSON.parse(row.capacity_json || "{}") || {};
  const lab: Record<string, unknown> = {
    id: row.id,
    title: row.title,
    inventory: JSON.parse(row.inventory_json || "[]"),
    services: JSON.parse(row.services_json || "[]"),
    checklist,
    closet: JSON.parse(row.closet_json || "{}"),
    hosts: JSON.parse(row.hosts_json || "[]"),
    bom: JSON.parse(row.bom_json || "[]"),
    updated_at: row.updated_at,
  };
  if (typeof capacity.upsVa === "number") lab.upsVa = capacity.upsVa;
  if (typeof capacity.powerNote === "string" && capacity.powerNote) lab.powerNote = capacity.powerNote;
  return lab;
}

app.post("/auth/register/options", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const username = normalizeUsername((body as any).username);
  if (!username) return c.json({ error: "invalid_username" }, 400);
  const existing = await c.env.DB.prepare("SELECT id FROM users WHERE username = ? COLLATE NOCASE")
    .bind(username)
    .first();
  if (existing) return c.json({ error: "username_taken" }, 409);

  const { rpID, rpName } = rpConfig(c);
  const userId = randomId();
  const options = await generateRegistrationOptions({
    rpName,
    rpID,
    userName: username,
    userDisplayName: username,
    userID: webAuthnUserId(userId),
    attestationType: "none",
    authenticatorSelection: {
      residentKey: "required",
      userVerification: "preferred",
      authenticatorAttachment: undefined,
    },
  });
  await saveChallenge(c.env.DB, "register", options.challenge, username, userId);
  return c.json({ options, userId });
});

app.post("/auth/register/verify", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const username = normalizeUsername((body as any).username);
  const userId = typeof (body as any).userId === "string" ? (body as any).userId : null;
  const cred = (body as any).credential as RegistrationResponseJSON | undefined;
  if (!username || !userId || !cred) return c.json({ error: "bad_request" }, 400);

  const challenge = typeof (body as any).challenge === "string" ? (body as any).challenge : "";
  const row = await c.env.DB.prepare(
    `SELECT id, username, user_id, challenge, expires_at FROM webauthn_challenges
     WHERE kind = 'register' AND challenge = ?`
  )
    .bind(challenge)
    .first<{ id: string; username: string; user_id: string; challenge: string; expires_at: string }>();
  if (!row || row.expires_at < nowIso() || row.username.toLowerCase() !== username.toLowerCase() || row.user_id !== userId) {
    return c.json({ error: "challenge_invalid" }, 400);
  }
  await c.env.DB.prepare("DELETE FROM webauthn_challenges WHERE id = ?").bind(row.id).run();

  const { rpID, expectedOrigins } = rpConfig(c);
  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response: cred,
      expectedChallenge: challenge,
      expectedOrigin: expectedOrigins,
      expectedRPID: rpID,
      requireUserVerification: false,
    });
  } catch {
    return c.json({ error: "verification_failed" }, 400);
  }
  if (!verification.verified || !verification.registrationInfo) {
    return c.json({ error: "verification_failed" }, 400);
  }

  const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo as any;
  const credId = typeof credential.id === "string" ? credential.id : b64url(credential.id);
  const pubKey = b64url(credential.publicKey);
  const transports = credential.transports ? JSON.stringify(credential.transports) : null;
  const ts = nowIso();

  const taken = await c.env.DB.prepare("SELECT id FROM users WHERE username = ? COLLATE NOCASE").bind(username).first();
  if (taken) return c.json({ error: "username_taken" }, 409);

  await c.env.DB.batch([
    c.env.DB.prepare("INSERT INTO users (id, username, created_at, updated_at) VALUES (?, ?, ?, ?)").bind(
      userId,
      username,
      ts,
      ts
    ),
    c.env.DB.prepare(
      `INSERT INTO passkeys (id, user_id, public_key, counter, transports, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(credId, userId, pubKey, credential.counter ?? 0, transports, ts),
    c.env.DB.prepare(
      `INSERT INTO labs (id, user_id, title, inventory_json, checklist_json, closet_json, hosts_json, bom_json, updated_at)
       VALUES (?, ?, 'My lab', '[]', ?, '{}', '[]', '[]', ?)`
    ).bind(randomId(), userId, JSON.stringify(CHECKLIST_DEFAULT), ts),
  ]);

  const session = await createSession(c.env.DB, userId);
  setSessionCookie(c, session.id, session.expires);
  if (!isBotRequest(c)) scheduleMetric(c, "register_human");
  else scheduleMetric(c, "register_bot");
  return c.json({ ok: true, username });
});

app.post("/auth/login/options", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const username = normalizeUsername((body as any).username);
  if (!username) return c.json({ error: "invalid_username" }, 400);
  const user = await c.env.DB.prepare("SELECT id, username FROM users WHERE username = ? COLLATE NOCASE")
    .bind(username)
    .first<{ id: string; username: string }>();
  if (!user) return c.json({ error: "invalid_credentials" }, 401);
  const keys = await c.env.DB.prepare("SELECT id, transports FROM passkeys WHERE user_id = ?")
    .bind(user.id)
    .all<{ id: string; transports: string | null }>();
  const { rpID } = rpConfig(c);
  const options = await generateAuthenticationOptions({
    rpID,
    userVerification: "preferred",
    allowCredentials: (keys.results || []).map((k) => ({
      id: k.id,
      transports: k.transports ? (JSON.parse(k.transports) as AuthenticatorTransportFuture[]) : undefined,
    })),
  });
  await saveChallenge(c.env.DB, "login", options.challenge, user.username, user.id);
  return c.json({ options });
});

app.post("/auth/login/verify", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const username = normalizeUsername((body as any).username);
  const challenge = typeof (body as any).challenge === "string" ? (body as any).challenge : "";
  const cred = (body as any).credential as AuthenticationResponseJSON | undefined;
  if (!username || !challenge || !cred) return c.json({ error: "bad_request" }, 400);

  const row = await c.env.DB.prepare(
    `SELECT id, username, user_id, challenge, expires_at FROM webauthn_challenges
     WHERE kind = 'login' AND challenge = ?`
  )
    .bind(challenge)
    .first<{ id: string; username: string; user_id: string; challenge: string; expires_at: string }>();
  if (!row || row.expires_at < nowIso() || row.username.toLowerCase() !== username.toLowerCase()) {
    return c.json({ error: "invalid_credentials" }, 401);
  }
  await c.env.DB.prepare("DELETE FROM webauthn_challenges WHERE id = ?").bind(row.id).run();

  const passkey = await c.env.DB.prepare(
    "SELECT id, public_key, counter, transports FROM passkeys WHERE id = ? AND user_id = ?"
  )
    .bind(cred.id, row.user_id)
    .first<{ id: string; public_key: string; counter: number; transports: string | null }>();
  if (!passkey) return c.json({ error: "invalid_credentials" }, 401);

  const { rpID, expectedOrigins } = rpConfig(c);
  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response: cred,
      expectedChallenge: challenge,
      expectedOrigin: expectedOrigins,
      expectedRPID: rpID,
      credential: {
        id: passkey.id,
        publicKey: fromB64url(passkey.public_key),
        counter: passkey.counter,
        transports: passkey.transports
          ? (JSON.parse(passkey.transports) as AuthenticatorTransportFuture[])
          : undefined,
      },
      requireUserVerification: false,
    });
  } catch {
    return c.json({ error: "invalid_credentials" }, 401);
  }
  if (!verification.verified) return c.json({ error: "invalid_credentials" }, 401);

  await c.env.DB.prepare("UPDATE passkeys SET counter = ? WHERE id = ?")
    .bind(verification.authenticationInfo.newCounter, passkey.id)
    .run();

  const session = await createSession(c.env.DB, row.user_id);
  setSessionCookie(c, session.id, session.expires);
  return c.json({ ok: true, username: row.username });
});

app.post("/auth/logout", async (c) => {
  const sid = getCookie(c, SESSION);
  if (sid) await c.env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(sid).run();
  deleteCookie(c, SESSION, { path: "/" });
  return c.json({ ok: true });
});

app.get("/auth/me", requireUser, async (c) => {
  const row = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM passkeys WHERE user_id = ?")
    .bind(c.get("userId"))
    .first<{ n: number }>();
  return c.json({
    username: c.get("username"),
    userId: c.get("userId"),
    passkey_count: Number(row?.n || 0),
  });
});

app.delete("/auth/me", requireUser, async (c) => {
  const userId = c.get("userId");
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM webauthn_challenges WHERE user_id = ?").bind(userId),
    c.env.DB.prepare("DELETE FROM enroll_tokens WHERE user_id = ?").bind(userId),
    c.env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(userId),
    c.env.DB.prepare("DELETE FROM passkeys WHERE user_id = ?").bind(userId),
    c.env.DB.prepare("DELETE FROM labs WHERE user_id = ?").bind(userId),
    c.env.DB.prepare("DELETE FROM users WHERE id = ?").bind(userId),
  ]);
  deleteCookie(c, SESSION, { path: "/" });
  return c.json({ ok: true });
});


app.post("/auth/enroll/create", requireUser, async (c) => {
  const userId = c.get("userId");
  const username = c.get("username");
  const code = enrollCode();
  const codeHash = await sha256Hex(code);
  const created = nowIso();
  const expires = new Date(Date.now() + 15 * 60e3).toISOString();

  await c.env.DB.prepare(
    "DELETE FROM enroll_tokens WHERE user_id = ? AND used_at IS NULL"
  )
    .bind(userId)
    .run();

  await c.env.DB.prepare(
    `INSERT INTO enroll_tokens (id, user_id, code_hash, expires_at, created_at, used_at)
     VALUES (?, ?, ?, ?, ?, NULL)`
  )
    .bind(randomId(), userId, codeHash, expires, created)
    .run();

  const { origin } = rpConfig(c);
  const url = `${origin}/?enroll=1&user=${encodeURIComponent(username)}&code=${encodeURIComponent(code)}`;
  return c.json({ code, url, expires_at: expires, username });
});

app.post("/auth/enroll/options", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const username = normalizeUsername((body as any).username);
  const code = normalizeEnrollCode((body as any).code);
  if (!username || !code) return c.json({ error: "bad_request" }, 400);

  const user = await c.env.DB.prepare("SELECT id, username FROM users WHERE username = ? COLLATE NOCASE")
    .bind(username)
    .first<{ id: string; username: string }>();
  if (!user) return c.json({ error: "invalid_enroll" }, 400);

  const codeHash = await sha256Hex(code);
  const token = await c.env.DB.prepare(
    `SELECT id, expires_at, used_at FROM enroll_tokens
     WHERE user_id = ? AND code_hash = ?`
  )
    .bind(user.id, codeHash)
    .first<{ id: string; expires_at: string; used_at: string | null }>();
  if (!token || token.used_at || token.expires_at < nowIso()) {
    return c.json({ error: "invalid_enroll" }, 400);
  }

  const keys = await c.env.DB.prepare("SELECT id, transports FROM passkeys WHERE user_id = ?")
    .bind(user.id)
    .all<{ id: string; transports: string | null }>();
  const { rpID, rpName } = rpConfig(c);
  const options = await generateRegistrationOptions({
    rpName,
    rpID,
    userName: user.username,
    userDisplayName: user.username,
    userID: webAuthnUserId(user.id),
    attestationType: "none",
    excludeCredentials: (keys.results || []).map((k) => ({
      id: k.id,
      transports: k.transports ? (JSON.parse(k.transports) as AuthenticatorTransportFuture[]) : undefined,
    })),
    authenticatorSelection: {
      residentKey: "required",
      userVerification: "preferred",
    },
  });
  await saveChallenge(c.env.DB, "enroll", options.challenge, user.username, user.id);
  return c.json({ options, userId: user.id });
});

app.post("/auth/enroll/verify", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const username = normalizeUsername((body as any).username);
  const code = normalizeEnrollCode((body as any).code);
  const userId = typeof (body as any).userId === "string" ? (body as any).userId : null;
  const challenge = typeof (body as any).challenge === "string" ? (body as any).challenge : "";
  const cred = (body as any).credential as RegistrationResponseJSON | undefined;
  if (!username || !code || !userId || !challenge || !cred) return c.json({ error: "bad_request" }, 400);

  const row = await c.env.DB.prepare(
    `SELECT id, username, user_id, challenge, expires_at FROM webauthn_challenges
     WHERE kind = 'enroll' AND challenge = ?`
  )
    .bind(challenge)
    .first<{ id: string; username: string; user_id: string; challenge: string; expires_at: string }>();
  if (
    !row ||
    row.expires_at < nowIso() ||
    row.username.toLowerCase() !== username.toLowerCase() ||
    row.user_id !== userId
  ) {
    return c.json({ error: "challenge_invalid" }, 400);
  }
  await c.env.DB.prepare("DELETE FROM webauthn_challenges WHERE id = ?").bind(row.id).run();

  const codeHash = await sha256Hex(code);
  const token = await c.env.DB.prepare(
    `SELECT id, expires_at, used_at FROM enroll_tokens
     WHERE user_id = ? AND code_hash = ?`
  )
    .bind(userId, codeHash)
    .first<{ id: string; expires_at: string; used_at: string | null }>();
  if (!token || token.used_at || token.expires_at < nowIso()) {
    return c.json({ error: "invalid_enroll" }, 400);
  }

  const { rpID, expectedOrigins } = rpConfig(c);
  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response: cred,
      expectedChallenge: challenge,
      expectedOrigin: expectedOrigins,
      expectedRPID: rpID,
      requireUserVerification: false,
    });
  } catch {
    return c.json({ error: "verification_failed" }, 400);
  }
  if (!verification.verified || !verification.registrationInfo) {
    return c.json({ error: "verification_failed" }, 400);
  }

  const { credential } = verification.registrationInfo as any;
  const credId = typeof credential.id === "string" ? credential.id : b64url(credential.id);
  const pubKey = b64url(credential.publicKey);
  const transports = credential.transports ? JSON.stringify(credential.transports) : null;
  const ts = nowIso();

  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO passkeys (id, user_id, public_key, counter, transports, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(credId, userId, pubKey, credential.counter ?? 0, transports, ts),
    c.env.DB.prepare("UPDATE enroll_tokens SET used_at = ? WHERE id = ?").bind(ts, token.id),
  ]);

  const session = await createSession(c.env.DB, userId);
  setSessionCookie(c, session.id, session.expires);
  return c.json({ ok: true, username: row.username });
});

app.post("/auth/passkeys/options", requireUser, async (c) => {
  const userId = c.get("userId");
  const username = c.get("username");
  const keys = await c.env.DB.prepare("SELECT id, transports FROM passkeys WHERE user_id = ?")
    .bind(userId)
    .all<{ id: string; transports: string | null }>();
  const { rpID, rpName } = rpConfig(c);
  const options = await generateRegistrationOptions({
    rpName,
    rpID,
    userName: username,
    userDisplayName: username,
    userID: webAuthnUserId(userId),
    attestationType: "none",
    excludeCredentials: (keys.results || []).map((k) => ({
      id: k.id,
      transports: k.transports ? (JSON.parse(k.transports) as AuthenticatorTransportFuture[]) : undefined,
    })),
    authenticatorSelection: {
      residentKey: "required",
      userVerification: "preferred",
    },
  });
  await saveChallenge(c.env.DB, "add-passkey", options.challenge, username, userId);
  return c.json({ options });
});

app.post("/auth/passkeys/verify", requireUser, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const challenge = typeof (body as any).challenge === "string" ? (body as any).challenge : "";
  const cred = (body as any).credential as RegistrationResponseJSON | undefined;
  if (!challenge || !cred) return c.json({ error: "bad_request" }, 400);
  const row = await c.env.DB.prepare(
    `SELECT id, user_id, expires_at FROM webauthn_challenges WHERE kind = 'add-passkey' AND challenge = ?`
  )
    .bind(challenge)
    .first<{ id: string; user_id: string; expires_at: string }>();
  if (!row || row.expires_at < nowIso() || row.user_id !== c.get("userId")) {
    return c.json({ error: "challenge_invalid" }, 400);
  }
  await c.env.DB.prepare("DELETE FROM webauthn_challenges WHERE id = ?").bind(row.id).run();
  const { rpID, expectedOrigins } = rpConfig(c);
  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response: cred,
      expectedChallenge: challenge,
      expectedOrigin: expectedOrigins,
      expectedRPID: rpID,
      requireUserVerification: false,
    });
  } catch {
    return c.json({ error: "verification_failed" }, 400);
  }
  if (!verification.verified || !verification.registrationInfo) {
    return c.json({ error: "verification_failed" }, 400);
  }
  const { credential } = verification.registrationInfo as any;
  const credId = typeof credential.id === "string" ? credential.id : b64url(credential.id);
  const pubKey = b64url(credential.publicKey);
  const transports = credential.transports ? JSON.stringify(credential.transports) : null;
  await c.env.DB.prepare(
    `INSERT INTO passkeys (id, user_id, public_key, counter, transports, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  )
    .bind(credId, c.get("userId"), pubKey, credential.counter ?? 0, transports, nowIso())
    .run();
  const countRow = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM passkeys WHERE user_id = ?")
    .bind(c.get("userId"))
    .first<{ n: number }>();
  return c.json({ ok: true, passkey_count: Number(countRow?.n || 0) });
});

app.get("/auth/passkeys", requireUser, async (c) => {
  const keys = await c.env.DB.prepare(
    "SELECT id, created_at, transports FROM passkeys WHERE user_id = ? ORDER BY created_at ASC"
  )
    .bind(c.get("userId"))
    .all<{ id: string; created_at: string; transports: string | null }>();
  const list = (keys.results || []).map((k, i) => ({
    id: k.id,
    created_at: k.created_at,
    label: `Passkey ${i + 1}`,
    id_hint: k.id.length > 12 ? `${k.id.slice(0, 8)}…` : k.id,
  }));
  return c.json({ passkeys: list, passkey_count: list.length });
});

app.delete("/auth/passkeys/:id", requireUser, async (c) => {
  const userId = c.get("userId");
  const id = c.req.param("id");
  if (!id) return c.json({ error: "bad_request" }, 400);
  const countRow = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM passkeys WHERE user_id = ?")
    .bind(userId)
    .first<{ n: number }>();
  const n = Number(countRow?.n || 0);
  if (n < 2) return c.json({ error: "last_passkey" }, 400);
  const owned = await c.env.DB.prepare("SELECT id FROM passkeys WHERE id = ? AND user_id = ?")
    .bind(id, userId)
    .first();
  if (!owned) return c.json({ error: "not_found" }, 404);
  await c.env.DB.prepare("DELETE FROM passkeys WHERE id = ? AND user_id = ?").bind(id, userId).run();
  return c.json({ ok: true, passkey_count: n - 1 });
});

app.get("/api/lab", requireUser, async (c) => {
  const lab = await getLab(c.env.DB, c.get("userId"));
  if (!lab) return c.json({ error: "missing_lab" }, 404);
  if (!isBotRequest(c)) scheduleMetric(c, "page_view_human");
  else scheduleMetric(c, "page_view_bot");
  return c.json(lab);
});

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** Next lab revision: now, but always strictly after the previous revision so versions never repeat. */
function nextRevision(prev: string): string {
  const now = Date.now();
  const prevMs = Date.parse(prev);
  return new Date(Number.isFinite(prevMs) && prevMs >= now ? prevMs + 1 : now).toISOString();
}

/**
 * Conditional write: replaces the notebook only if its revision is still `expected`.
 * Returns false when another write landed first (or the lab is gone).
 */
async function writeLab(
  db: D1Database,
  userId: string,
  lab: ReturnType<typeof clampLab>,
  expected: string,
  revision: string
): Promise<boolean> {
  const capacity = sanitizeCapacity(lab);
  const res = await db
    .prepare(
      `UPDATE labs SET title = ?, inventory_json = ?, checklist_json = ?, closet_json = ?,
       hosts_json = ?, bom_json = ?, services_json = ?, capacity_json = ?, updated_at = ?
       WHERE user_id = ? AND updated_at = ?`
    )
    .bind(
      lab.title,
      JSON.stringify(lab.inventory),
      JSON.stringify(lab.checklist),
      JSON.stringify(lab.closet),
      JSON.stringify(lab.hosts),
      JSON.stringify(lab.bom),
      JSON.stringify(lab.services),
      JSON.stringify(capacity),
      revision,
      userId,
      expected
    )
    .run();
  return (res.meta?.changes ?? 0) === 1;
}

async function currentRevision(db: D1Database, userId: string): Promise<string | null> {
  const row = await db.prepare("SELECT updated_at FROM labs WHERE user_id = ?").bind(userId).first<{ updated_at: string }>();
  return row ? row.updated_at : null;
}

/**
 * Explicit replacement (force save or import): ignores the client's version but still writes
 * conditionally against the latest revision, so concurrent writes each get their own version.
 */
async function replaceLab(
  db: D1Database,
  userId: string,
  lab: ReturnType<typeof clampLab>
): Promise<{ revision: string } | { error: "missing_lab" | "busy" }> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const current = await currentRevision(db, userId);
    if (!current) return { error: "missing_lab" };
    const revision = nextRevision(current);
    if (await writeLab(db, userId, lab, current, revision)) return { revision };
  }
  return { error: "busy" };
}

async function conflictResponse(c: any, userId: string) {
  const full = await getLab(c.env.DB, userId);
  if (!full) return c.json({ error: "missing_lab" }, 404);
  return c.json(
    {
      error: "conflict",
      message: "Lab was updated elsewhere",
      updated_at: full.updated_at,
      lab: full,
    },
    409
  );
}

app.put("/api/lab", requireUser, async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!isPlainObject(body)) return c.json({ error: "bad_request" }, 400);
  const lab = clampLab(body);
  const userId = c.get("userId");
  const force = body.force === true;
  const clientVersion =
    (typeof body.updated_at === "string" && body.updated_at) ||
    c.req.header("if-match") ||
    c.req.header("If-Match") ||
    null;

  let revision: string;
  if (force) {
    const res = await replaceLab(c.env.DB, userId, lab);
    if ("error" in res) return c.json({ error: res.error }, res.error === "busy" ? 503 : 404);
    revision = res.revision;
  } else {
    const current = await currentRevision(c.env.DB, userId);
    if (!current) return c.json({ error: "missing_lab" }, 404);
    // Without a version the save is based on whatever was current when it was read.
    const expected = clientVersion ?? current;
    if (expected !== current) return conflictResponse(c, userId);
    revision = nextRevision(current);
    // The version check is part of the UPDATE predicate, so a racing save cannot slip in between.
    if (!(await writeLab(c.env.DB, userId, lab, expected, revision))) return conflictResponse(c, userId);
  }

  if (!isBotRequest(c)) scheduleMetric(c, "lab_save_human");
  else scheduleMetric(c, "lab_save_bot");
  return c.json({ ok: true, updated_at: revision });
});

app.post("/api/lab/import", requireUser, async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!isPlainObject(body)) return c.json({ error: "bad_request" }, 400);

  const version = body.schema_version;
  // Legacy exports omit schema_version — treat as v1. Accept 1–2; reject unknown future versions.
  if (version != null) {
    const v = Number(version);
    if (v !== 1 && v !== 2) {
      return c.json({ error: "unsupported_schema", schema_version: version }, 400);
    }
  }

  const rawLab = isPlainObject(body.lab) ? body.lab : body;
  const lab = clampLab(rawLab);
  const userId = c.get("userId");
  // Import is an explicit, user-confirmed replacement of the whole notebook.
  const res = await replaceLab(c.env.DB, userId, lab);
  if ("error" in res) return c.json({ error: res.error }, res.error === "busy" ? 503 : 404);
  if (!isBotRequest(c)) scheduleMetric(c, "lab_save_human");
  else scheduleMetric(c, "lab_save_bot");
  const full = await getLab(c.env.DB, userId);
  return c.json({ ok: true, updated_at: res.revision, lab: full });
});

app.get("/api/lab/export", requireUser, async (c) => {
  const lab = await getLab(c.env.DB, c.get("userId"));
  if (!lab) return c.json({ error: "missing_lab" }, 404);
  const payload = {
    schema_version: SCHEMA_VERSION,
    exported_at: nowIso(),
    username: c.get("username"),
    lab,
  };
  return new Response(JSON.stringify(payload, null, 2), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="lab-plan-${c.get("username")}.json"`,
    },
  });
});


app.get("/manifest.webmanifest", async (c) => {
  const res = await c.env.ASSETS.fetch(c.req.raw);
  if (!res.ok) return res;
  const headers = new Headers(res.headers);
  headers.set("content-type", "application/manifest+json; charset=utf-8");
  headers.set("cache-control", "public, max-age=3600");
  return new Response(res.body, { status: res.status, headers });
});

app.all("*", async (c) => {
  const res = await c.env.ASSETS.fetch(c.req.raw);
  const headers = new Headers(res.headers);
  applySecurityHeaders(headers);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
});

export default app;
