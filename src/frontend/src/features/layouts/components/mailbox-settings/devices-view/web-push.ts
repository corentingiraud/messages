/**
 * Web Push enable flow for browsers / installed PWAs.
 *
 * Native (Capacitor) builds use the OS push plugins instead — this path is only
 * for the `web` transport. Registers the service worker, requests notification
 * permission, subscribes with the server's VAPID public key, and registers the
 * resulting subscription as a user-scoped `push` channel via the API.
 */
import {
  PlatformEnum,
  PushChannelCreateTypeEnum,
  usersMeChannelsCreate,
} from "@/features/api/gen";

export type EnableWebPushResult =
  | "subscribed"
  | "denied" // permission explicitly refused (needs OS/browser settings)
  | "dismissed" // prompt closed without choosing — retrying is fine
  | "unsupported"
  | "registration_failed" // the service worker (/sw.js) failed to register
  | "push_service_error"; // browser↔push-service handshake failed (e.g. Brave)

/** True when this browser can do Web Push at all. */
export const isWebPushSupported = (): boolean =>
  typeof navigator !== "undefined" &&
  "serviceWorker" in navigator &&
  typeof window !== "undefined" &&
  "PushManager" in window &&
  "Notification" in window;

/** Decode a base64url VAPID key into the BufferSource subscribe() expects.
 * Backed by an explicit ArrayBuffer so the type is the non-shared
 * Uint8Array<ArrayBuffer> applicationServerKey requires.
 *
 * Throws if the result isn't a 65-byte uncompressed P-256 point: that's the
 * only shape a VAPID applicationServerKey can be, and a malformed key (e.g. a
 * mis-pinned PUSH_VAPID_PUBLIC_KEY) otherwise fails later inside subscribe()
 * with an opaque error. Failing here surfaces the real cause. */
const urlBase64ToUint8Array = (
  base64String: string,
): Uint8Array<ArrayBuffer> => {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const output = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i += 1) {
    output[i] = raw.charCodeAt(i);
  }
  if (output.length !== 65) {
    throw new Error(
      `Invalid VAPID public key: expected 65 bytes, got ${output.length}`,
    );
  }
  return output;
};

/** Best-effort human label so the device list can tell browsers apart. */
const deviceName = (): string => {
  const ua = navigator.userAgent;
  let browser = "Browser";
  if (/Edg\//.test(ua)) browser = "Edge";
  else if (/OPR\//.test(ua) || /Opera/.test(ua)) browser = "Opera";
  else if (/Chrome\//.test(ua)) browser = "Chrome";
  else if (/Firefox\//.test(ua)) browser = "Firefox";
  else if (/Safari\//.test(ua)) browser = "Safari";
  return `${browser} (web)`;
};

/**
 * Run the full enable flow. Returns a discriminated outcome for every expected
 * non-success case (so the caller can show an accurate message); throws only on
 * truly unexpected failures.
 *
 * - "dismissed": the user closed the permission prompt without choosing — safe
 *   to retry, nothing is blocked.
 * - "denied": permission explicitly refused — needs OS/browser settings.
 * - "push_service_error": permission granted but `subscribe()` failed to register
 *   with the browser's push service (an `AbortError`). The classic cause is Brave
 *   with "Use Google services for push messaging" off, or no network to the push
 *   service — retryable, but needs that setting flipped.
 */
export const enableWebPush = async (
  vapidPublicKey: string,
): Promise<EnableWebPushResult> => {
  if (!isWebPushSupported()) {
    return "unsupported";
  }

  const permission = await Notification.requestPermission();
  if (permission === "denied") {
    return "denied";
  }
  if (permission !== "granted") {
    return "dismissed"; // "default" — prompt closed without a choice
  }

  let registration: ServiceWorkerRegistration;
  try {
    registration = await navigator.serviceWorker.register("/sw.js");
    await navigator.serviceWorker.ready;
  } catch {
    // /sw.js missing (404), blocked by CSP, or otherwise unregisterable —
    // distinct from a permission or push-service failure.
    return "registration_failed";
  }

  // Reuse an existing subscription if the browser already has one for this key.
  let subscription = await registration.pushManager.getSubscription();
  if (!subscription) {
    try {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
      });
    } catch (err) {
      // `subscribe()` rejects with AbortError ("Registration failed - push
      // service error") when the browser can't reach/register with its push
      // service. Report it distinctly rather than as a generic failure.
      if (err instanceof DOMException && err.name === "AbortError") {
        return "push_service_error";
      }
      throw err;
    }
  }

  const json = subscription.toJSON();
  const p256dh = json.keys?.p256dh;
  const auth = json.keys?.auth;
  if (!json.endpoint || !p256dh || !auth) {
    throw new Error("Incomplete push subscription");
  }

  // Push devices register through the generic channels create with type=push;
  // the backend upserts on the token's hash (globally unique), so re-running
  // this is idempotent.
  await usersMeChannelsCreate({
    type: PushChannelCreateTypeEnum.push,
    platform: PlatformEnum.web,
    token: json.endpoint,
    keys: { p256dh, auth },
    name: deviceName(),
  });

  return "subscribed";
};

/**
 * Re-register the *existing* subscription on app load, to self-heal a rotated
 * endpoint and refresh `last_used_at`.
 *
 * Complements the service worker's `pushsubscriptionchange` handler: that fires
 * only while the browser is running and (on non-Chromium engines) can't attach
 * the CSRF token, so this re-posts through the app's normal, CSRF-correct API
 * client whenever the app opens. It is deliberately passive — it only acts when
 * the user has already enabled push in this browser (permission granted, a
 * service worker registered, and a live subscription). It never prompts,
 * registers a worker, or subscribes; nothing happens for users who never opted
 * in. Best-effort: any failure is swallowed.
 */
export const refreshWebPushSubscription = async (
  vapidPublicKey: string,
): Promise<void> => {
  try {
    if (!isWebPushSupported() || !vapidPublicKey) return;
    if (Notification.permission !== "granted") return;

    const registration = await navigator.serviceWorker.getRegistration("/sw.js");
    if (!registration) return; // user never enabled push in this browser

    const subscription = await registration.pushManager.getSubscription();
    if (!subscription) return;

    const json = subscription.toJSON();
    const p256dh = json.keys?.p256dh;
    const auth = json.keys?.auth;
    if (!json.endpoint || !p256dh || !auth) return;

    await usersMeChannelsCreate({
      type: PushChannelCreateTypeEnum.push,
      platform: PlatformEnum.web,
      token: json.endpoint,
      keys: { p256dh, auth },
      name: deviceName(),
    });
  } catch {
    // Best-effort refresh — never disrupt app load.
  }
};
