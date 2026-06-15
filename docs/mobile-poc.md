# Mobile POC — Capacitor app with cross-app SSO

This POC wraps the Messages frontend in a [Capacitor](https://capacitorjs.com/)
app (iOS + Android) and validates the authentication architecture intended for
all La Suite mobile apps (mail, calendar, …): **a user who logged in on one app
must not re-enter credentials on the others.**

## How it works

The OIDC flow runs in the **system browser** — `ASWebAuthenticationSession` on
iOS, Chrome Custom Tabs on Android — never in the WebView (RFC 8252). The
system browser shares its cookie jar across apps, so the identity provider
session cookie (ProConnect in production, Keycloak in development) provides the
cross-app SSO: the second app's login flow completes silently.

The backend stays the confidential OIDC client (`django-lasuite`), so the IdP
only ever sees the regular web flow with the backend HTTPS callback — **no
IdP-side configuration is needed for mobile**. The Django session is handed
over to the app at the end of the flow:

```
App                         System browser                  Backend                IdP
 │  openAuthSession()            │                             │                    │
 │──────────────────────────────▶│ GET /api/v1.0/authenticate/ │                    │
 │   (+ mobile_scheme,           │────────────────────────────▶│  302 authorize     │
 │      code_challenge)          │─────────────────────────────┼───────────────────▶│
 │                               │            login form (or silent SSO redirect)   │
 │                               │ GET /api/v1.0/callback/     │◀───────────────────│
 │                               │────────────────────────────▶│ session + one-time │
 │   stmessagesa://auth?token=…  │◀────────────────────────────│ token (60 s TTL)   │
 │◀──────────────────────────────│                             │                    │
 │  POST /api/v1.0/mobile/auth/exchange/ {token, code_verifier}│                    │
 │────────────────────────────────────────────────────────────▶│                    │
 │◀──── Set-Cookie sessionid + csrftoken, body {csrf_token} ───│                    │
```

Inside the WebView, `window.fetch` is routed through the native HTTP layer
(`CapacitorHttp`), so the session cookies live in the native cookie jar: no
`SameSite`/ITP restriction applies and the plain-HTTP dev backend works.

Key code:

- Backend: `src/backend/core/authentication/views.py` (mobile-aware OIDC views),
  `src/backend/core/api/viewsets/mobile_auth.py` (token → session exchange)
- Frontend: `src/frontend/src/features/native/` (platform detection, PKCE,
  system-browser session, native login/logout)
- Shell: `src/frontend/capacitor.config.ts`,
  `src/frontend/ios/App/App/WebAuthSessionPlugin.swift` (ASWebAuthenticationSession)

## Prerequisites

- The development stack: `make bootstrap` once, then `make start-minimal`
  (backend on `http://localhost:8901`, Keycloak on `http://localhost:8902`).
- Android: Android Studio + an emulator image **with Play services** (Custom
  Tabs requires Chrome).
- iOS: a Mac with Xcode 16+.

## Smoke test without any mobile device

The whole backend half can be validated with curl + a desktop browser:

1. `curl -i "http://localhost:8901/api/v1.0/authenticate/?mobile_scheme=stmessagesa&code_challenge=<S256(verifier)>"`
   → `302` towards Keycloak.
2. Open that authenticate URL in a browser, complete the Keycloak login: the
   final redirect is `stmessagesa://auth?token=…` (the browser will say it
   cannot open the address — copy the token).
3. `curl -i -X POST -H 'Content-Type: application/json' -d '{"token":"…","code_verifier":"…"}' http://localhost:8901/api/v1.0/mobile/auth/exchange/`
   → `200` with `Set-Cookie: st_messages_sessionid=…` and `csrftoken=…`.

## Running on Android

```bash
cd src/frontend
npm run mobile:build            # vite build (API origin = localhost:8901) + cap sync
# Start the emulator, then map localhost to the host (rerun after each emulator restart):
adb reverse tcp:8901 tcp:8901 && adb reverse tcp:8902 tcp:8902
# App A:
(cd android && ./gradlew assembleDebug) && adb install android/app/build/outputs/apk/debug/app-debug.apk
# App B (second appId + scheme, proves the cross-app SSO):
(cd android && ./gradlew assembleDebug -PmessagesAppId=fr.gouv.suite.messages.b -PmessagesAuthScheme=stmessagesb) \
  && adb install android/app/build/outputs/apk/debug/app-debug.apk
```

## Running on iOS

```bash
cd src/frontend
npm run mobile:ios              # build + sync + open Xcode
```

Run the `App` target on a simulator (`localhost` reaches the host directly).
For app B, change the bundle identifier to `fr.gouv.suite.messages.b` (Signing
& Capabilities) and run again: thanks to `ASWebAuthenticationSession` no
Info.plist scheme declaration is needed, the JS resolves the scheme from the
application id.

## Acceptance demo

1. Open app A → login → the system browser sheet shows the Keycloak form —
   tick **"Remember me"** (required on iOS, see limitations) → the sheet closes
   and the app shows the mailbox. One single credential entry.
2. Open app B → login → the sheet opens and closes **without showing the
   form** → authenticated. Zero credential entry. This is the cross-app SSO.
3. Open a thread: the message body iframe (srcDoc + sandbox + CSP) must render —
   this is what broke the previous React Native attempt.
4. Logout in app A, login again → still silent (the IdP session is preserved,
   logout only drops the local session).

## Known limitations (POC scope)

- **iOS SSO needs persistent IdP cookies**: `ASWebAuthenticationSession` shares
  Safari's *persistent* cookies only; the Keycloak identity cookie is a session
  cookie unless "Remember me" is ticked. ProConnect session persistence must be
  confirmed for production.
- **Logout is local only**: it clears the native cookies; the server-side
  Django session expires on its own (12 h) and the IdP session is deliberately
  preserved. An IdP-level logout is an iteration-2 topic.
- **CapacitorHttp quirks**: multipart uploads (attachments, import) and blob
  downloads are known to be fragile through the patched fetch — out of POC
  scope.
- **Iframe subresources** (inline images proxied through the API) use the
  WebView network stack, not the native one: they may not load in dev. The
  HTML body itself renders.
- **CSRF on HTTPS**: native requests carry no `Origin`/`Referer`, which Django
  requires on secure requests. Production needs the fetch wrapper to inject an
  `Origin` listed in `CSRF_TRUSTED_ORIGINS` (iteration 2).
- **Custom URL schemes** can be claimed by other apps (mitigated by the
  one-time token + PKCE); production should move to Universal Links / App
  Links.

## Iteration 2 backlog

OTA live updates (self-hosted Capgo) to decouple frontend deploys from store
reviews; Universal Links/App Links; IdP logout; session renewal beyond 12 h
(refresh token server-side); native print (`use-print.tsx` uses
`window.open`); external links through `@capacitor/browser`; App Store
guideline 4.2 mitigations (push notifications…); ProConnect onboarding
(confirm `prompt=none` support and SSO session duration).

## Environment variables

See [env.md](./env.md) — `MOBILE_AUTH_CALLBACK_SCHEMES`, `MOBILE_AUTH_TOKEN_TTL`,
and the `NEXT_PUBLIC_API_ORIGIN` requirement for mobile builds.
