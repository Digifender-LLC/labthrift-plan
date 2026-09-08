/* Lab plan service worker — static cache + network-first API/auth */
const CACHE = "lab-plan-static-v3";
const OFFLINE_URL = "/offline";

const PRECACHE = [
  "/",
  "/index.html",
  "/styles.css",
  "/app.js",
  "/manifest.webmanifest",
  "/offline",
  "/offline.html",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
];

// Vendor modules pulled in by /app.js (cache individually so one miss doesn't fail install)
const VENDOR = [
  "/vendor/simplewebauthn-browser/index.js",
  "/vendor/simplewebauthn-browser/methods/startRegistration.js",
  "/vendor/simplewebauthn-browser/methods/startAuthentication.js",
  "/vendor/simplewebauthn-browser/methods/sendSignal.js",
  "/vendor/simplewebauthn-browser/helpers/bufferToBase64URLString.js",
  "/vendor/simplewebauthn-browser/helpers/base64URLStringToBuffer.js",
  "/vendor/simplewebauthn-browser/helpers/browserSupportsWebAuthn.js",
  "/vendor/simplewebauthn-browser/helpers/browserSupportsWebAuthnAutofill.js",
  "/vendor/simplewebauthn-browser/helpers/browserSupportsPasskeys.js",
  "/vendor/simplewebauthn-browser/helpers/platformAuthenticatorIsAvailable.js",
  "/vendor/simplewebauthn-browser/helpers/getBrowserCapabilities.js",
  "/vendor/simplewebauthn-browser/helpers/toPublicKeyCredentialDescriptor.js",
  "/vendor/simplewebauthn-browser/helpers/identifyAuthenticationError.js",
  "/vendor/simplewebauthn-browser/helpers/identifyRegistrationError.js",
  "/vendor/simplewebauthn-browser/helpers/identifySignalError.js",
  "/vendor/simplewebauthn-browser/helpers/webAuthnAbortService.js",
  "/vendor/simplewebauthn-browser/helpers/webAuthnError.js",
  "/vendor/simplewebauthn-browser/helpers/toAuthenticatorAttachment.js",
  "/vendor/simplewebauthn-browser/types/index.js",
  "/vendor/simplewebauthn-browser/types/dom.js",
];

async function cacheAll(cache, urls) {
  await Promise.all(
    urls.map(async (url) => {
      try {
        await cache.add(url);
      } catch (_) {
        /* skip missing / opaque failures */
      }
    })
  );
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      await cache.addAll(PRECACHE);
      await cacheAll(cache, VENDOR);
      await self.skipWaiting();
    })()
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
    })()
  );
});

function isApiOrAuth(url) {
  return url.pathname.startsWith("/api/") || url.pathname.startsWith("/auth/");
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Network-first for API/auth — never treat cache as source of truth
  if (isApiOrAuth(url)) {
    event.respondWith(
      (async () => {
        try {
          return await fetch(req);
        } catch {
          return new Response(JSON.stringify({ error: "offline" }), {
            status: 503,
            headers: { "content-type": "application/json; charset=utf-8" },
          });
        }
      })()
    );
    return;
  }

  // Navigations: network-first, offline.html fallback (no fake session)
  if (req.mode === "navigate") {
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetch(req);
          const cache = await caches.open(CACHE);
          cache.put("/", fresh.clone()).catch(() => {});
          return fresh;
        } catch {
          const cache = await caches.open(CACHE);
          const offline = await cache.match(OFFLINE_URL);
          return (
            offline ||
            new Response("Offline", {
              status: 503,
              headers: { "content-type": "text/plain; charset=utf-8" },
            })
          );
        }
      })()
    );
    return;
  }

  // Static assets: cache-first, then network (and populate cache)
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      const cached = await cache.match(req);
      if (cached) return cached;
      try {
        const fresh = await fetch(req);
        if (fresh.ok) cache.put(req, fresh.clone()).catch(() => {});
        return fresh;
      } catch {
        if (url.pathname.endsWith(".html")) {
          const offline = await cache.match(OFFLINE_URL);
          if (offline) return offline;
        }
        return new Response("Offline", {
          status: 503,
          headers: { "content-type": "text/plain; charset=utf-8" },
        });
      }
    })()
  );
});
