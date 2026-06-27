/* Web Push service worker.
 *
 * Registered by the app (see features/.../devices-view/web-push.ts) when the
 * user enables notifications in a browser.
 *
 * The push payload is deliberately thin and content-free — only routing ids +
 * the unread count. To show a Gmail-style banner (sender + subject) WITHOUT
 * ever putting content on the push transport, we fetch the message over the
 * user's own authenticated session here and rewrite the notification
 * ("fetch-to-enrich"). If that fetch fails (offline, cross-origin API, signed
 * out) we fall back to a generic content-free banner. `userVisibleOnly: true`
 * subscriptions MUST surface a notification for every push, so we always end up
 * calling showNotification exactly once.
 */
/* global self, clients, fetch */

// Same-origin API path. Enrichment only works when the API is served from this
// origin (the common PWA case); otherwise the fetch fails and we fall back.
const MESSAGE_URL = (id) => `/api/v1.0/messages/${encodeURIComponent(id)}/`;

const senderLabel = (message) => {
  const s = message && message.sender;
  return (s && (s.name || s.email)) || "New message";
};

async function buildNotification(payload) {
  // Default: content-free banner (what the thin payload alone can show).
  let title = "New message";
  const tag = payload.thread_id ? "thread-" + payload.thread_id : undefined;
  const options = {
    body: "",
    // Coalesce a burst in one thread into a single notification...
    tag,
    // ...but still re-alert (sound/vibrate) for each new message in that thread,
    // rather than silently swapping the banner. renotify requires a tag.
    renotify: Boolean(tag),
    data: payload,
  };

  // Fetch-to-enrich: pull sender + subject over the authenticated session.
  if (payload.message_id) {
    try {
      const resp = await fetch(MESSAGE_URL(payload.message_id), {
        credentials: "include",
        headers: { Accept: "application/json" },
      });
      if (resp.ok) {
        const message = await resp.json();
        title = senderLabel(message);
        options.body = message.subject || "";
      }
    } catch {
      // Offline / cross-origin / signed out — keep the generic banner.
    }
  }

  // Drive the installed-PWA app badge from the unread count the payload carries.
  // Guarded: Firefox/Safari (and non-installed contexts) lack the Badging API.
  if ("setAppBadge" in self.navigator && typeof payload.unread_count === "number") {
    self.navigator.setAppBadge(payload.unread_count).catch(() => {});
  }

  return self.registration.showNotification(title, options);
}

self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = {};
  }
  event.waitUntil(buildNotification(payload));
});

// Deep-link target from the routing ids the payload carries. mailbox_id is the
// recipient's mailbox the thread is read in (added to the thin payload precisely
// so we can route here); without it we can only open the app root.
const targetUrl = (payload) =>
  payload && payload.mailbox_id && payload.thread_id
    ? `/mailbox/${payload.mailbox_id}/thread/${payload.thread_id}`
    : "/";

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = targetUrl(event.notification.data);

  event.waitUntil(
    clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((windowClients) => {
        // Reuse an existing tab where possible: focus it and navigate to the
        // thread (refetches and clears the badge).
        for (const client of windowClients) {
          if ("focus" in client) {
            if ("navigate" in client && url !== "/") {
              return client.focus().then((c) => (c || client).navigate(url));
            }
            return client.focus();
          }
        }
        if (clients.openWindow) {
          return clients.openWindow(url);
        }
        return undefined;
      }),
  );
});

// The CSRF cookie name the backend (Django) sets; mirrored from the app's API
// client, which sends it back as the X-CSRFToken header on unsafe methods.
const CSRF_COOKIE = "csrftoken";
const CHANNELS_URL = "/api/v1.0/users/me/channels/";

// Read the CSRF token without `document` (unavailable in a worker). The Cookie
// Store API is present in Chromium — which is also where pushsubscriptionchange
// fires in practice — so this covers the case that matters; elsewhere we POST
// without it and the app's next on-load refresh reconciles instead.
async function readCsrfToken() {
  try {
    if (self.cookieStore) {
      const cookie = await self.cookieStore.get(CSRF_COOKIE);
      return cookie ? cookie.value : null;
    }
  } catch {
    /* cookieStore unavailable or blocked — fall through */
  }
  return null;
}

// The browser can rotate or expire our push subscription at any time (clearing
// site data, periodic rotation, key changes). Without this the user silently
// stops receiving pushes until they revisit settings. Re-subscribe with the
// same VAPID key (carried on the old subscription) and re-register the new
// endpoint so delivery self-heals.
self.addEventListener("pushsubscriptionchange", (event) => {
  const applicationServerKey =
    event.oldSubscription &&
    event.oldSubscription.options &&
    event.oldSubscription.options.applicationServerKey;

  event.waitUntil(
    (async () => {
      try {
        const subscription = await self.registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey,
        });
        const json = subscription.toJSON();
        const p256dh = json.keys && json.keys.p256dh;
        const auth = json.keys && json.keys.auth;
        if (!json.endpoint || !p256dh || !auth) {
          return;
        }
        const csrf = await readCsrfToken();
        await fetch(CHANNELS_URL, {
          method: "POST",
          credentials: "include",
          headers: {
            "Content-Type": "application/json",
            ...(csrf ? { "X-CSRFToken": csrf } : {}),
          },
          body: JSON.stringify({
            type: "push",
            platform: "web",
            token: json.endpoint,
            keys: { p256dh, auth },
          }),
        });
      } catch {
        // Best-effort self-heal; the app's on-load refresh is the fallback.
      }
    })(),
  );
});
