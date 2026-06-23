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

## Running both apps on one Android emulator

The two POC apps are built from **Gradle product flavors** (`a` and `b`,
dimension `variant`, declared in `android/app/build.gradle`). Each flavor sets
its own `applicationId`, deep-link `authScheme` and launcher label, so the two
apps install **side by side** and produce **distinct APKs** (no overwrite):

| Flavor | applicationId                  | scheme        | label        | APK                                              |
| ------ | ------------------------------ | ------------- | ------------ | ------------------------------------------------ |
| `a`    | `fr.gouv.suite.messages.a`     | `stmessagesa` | `Messages`   | `app/build/outputs/apk/a/debug/app-a-debug.apk`  |
| `b`    | `fr.gouv.suite.messages.b`     | `stmessagesb` | `Messages B` | `app/build/outputs/apk/b/debug/app-b-debug.apk`  |

The web bundle is shared by both flavors; each running app resolves its own
deep-link scheme at runtime from its `applicationId`
(`src/features/native/auth.ts` → `SCHEME_BY_APP_ID`).

### One-shot

Start an emulator first (image **with Play services** — Custom Tabs needs
Chrome), then:

```bash
make mobile-android-sso         # web build (container) + both APKs, install both, adb reverse
```

### Step by step (equivalent)

```bash
make mobile-build               # container: vite build (env from env.d) + cap copy
cd src/frontend
npm run android:apk:a           # assembleADebug → app-a-debug.apk            (host)
npm run android:apk:b           # assembleBDebug → app-b-debug.apk            (host)
npm run android:install:a       # adb install -r … app-a-debug.apk            (host)
npm run android:install:b       # adb install -r … app-b-debug.apk            (host)
npm run android:reverse         # map emulator localhost → host (8900/8901/8902)
```

> The web bundle is built **inside a container** (`frontend-mobile`) so it picks
> up the `NEXT_PUBLIC_*` vars from `env.d/development/frontend.{defaults,local}`
> — exactly like the dev server. Building it on the host with a bare `npm run`
> would inline none of them (Vite has no `.env` file here). The native compile,
> `adb` and the IDE stay on the host.

> `adb reverse` is dropped on every emulator reboot or adb reconnection — rerun
> `npm run android:reverse` if the apps suddenly cannot reach the backend.
> With several emulators/devices connected, target one with
> `adb -s <serial> …` (`adb devices` to list them).

## The cross-app SSO test

After the steps above, both **Messages** and **Messages B** are on the home
screen. The goal is to prove that logging into one logs you into the other.

1. **App A — first login.** Open **Messages** → tap login. The Chrome Custom Tab
   opens the Keycloak form. Sign in with `user1@example.local` / `user1`. The
   tab closes and the mailbox appears. *One single credential entry.*
2. **App B — silent SSO.** Open **Messages B** → tap login. The Custom Tab opens
   and closes **without showing the form** → the mailbox appears. *Zero
   credential entry.* This is the cross-app SSO.

### Prove it objectively (not just "it worked")

- **Keycloak events** — the server-side proof:

  ```bash
  docker compose logs -f keycloak | grep -iE "type=(LOGIN|CODE_TO_TOKEN)|sessionId"
  ```

  App A's login emits an interactive `LOGIN`; app B emits **no** new `LOGIN`
  (no form submission) and reuses the same SSO `sessionId` (`CODE_TO_TOKEN`).
  Also visible in the admin console → realm `messages` → *Sessions*.
- **Negative control** — clear Chrome's cookies (or log the IdP session out),
  then reopen app B: the credential entry becomes mandatory again. This proves
  the SSO came from the shared system-browser session, not a local cache.

### Common false negative

If app B still shows the login form, the emulator most likely lacks Chrome:
Custom Tabs then falls back to a WebView with an **isolated** cookie jar and the
IdP session cannot be shared. Use a **Google Play / Google APIs** emulator image
and open Chrome once to warm it up.

## Testing on a physical Android device

`adb reverse` works over USB too, so a real device needs **no rebuild and no URL
change**: the bundle keeps targeting `localhost:8901`, the forward tunnels it to
your machine. A real device also always ships Chrome, so the Custom Tabs false
negative above cannot happen.

1. **Enable developer mode** on the phone: Settings → About → tap *Build number*
   7 times. Then Settings → Developer options → enable **USB debugging**.
2. **Plug in over USB** and **authorize** the computer's RSA key on the phone.
   Some vendors (Xiaomi/MIUI, Samsung…) also require *Install via USB* in the
   developer options, otherwise `adb install` is refused.
3. **Verify and target the device.** With an emulator *and* the phone attached,
   `adb` (and the `android:*` npm scripts) is ambiguous — pin the device for the
   whole session:

   ```bash
   adb devices                    # find the phone's serial
   export ANDROID_SERIAL=XXXXXXXX # every following adb targets this device
   ```

4. **Install both APKs, forward the ports, launch.** Same commands as the
   emulator:

   ```bash
   cd src/frontend
   npm run android:apk:a && npm run android:apk:b      # if not built yet
   npm run android:install:a && npm run android:install:b
   npm run android:reverse                             # USB forward 8900/8901/8902 → host
   ```

   `adb reverse` is dropped on every USB disconnect/reconnect — rerun
   `npm run android:reverse` if the apps can no longer reach the backend.

Then run [The cross-app SSO test](#the-cross-app-sso-test) exactly as on the
emulator. Wireless debugging (Android 11+, `adb pair` / `adb connect`) works the
same way once the adb connection is up.

## Running both apps on one iOS simulator

iOS mirrors the Android two-flavors setup with **two targets in the single
`App.xcodeproj`** (no duplicated project): `App` (`…messages.a`, "Messages") and
`App B` (`…messages.b`, "Messages B"). Both targets share the same Swift
sources, the same `App/public` web bundle (so `cap copy` feeds both) and the
same `Info.plist`; they differ only by two build settings:

| Setting                       | App                        | App B                        |
| ----------------------------- | -------------------------- | ---------------------------- |
| `PRODUCT_BUNDLE_IDENTIFIER`   | `fr.gouv.suite.messages.a` | `fr.gouv.suite.messages.b`   |
| `PRODUCT_DISPLAY_NAME` (User-Defined) | `Messages` (default) | `Messages B`                 |

`Info.plist` reads the launcher name from `$(PRODUCT_DISPLAY_NAME:default=Messages)`,
and `ASWebAuthenticationSession` needs no URL-scheme declaration — the JS bundle
resolves the deep-link scheme at runtime from the bundle id
(`SCHEME_BY_APP_ID`). So a target is all that differs.

```bash
make mobile-ios                 # web build (container) + cap copy, then open Xcode (host)
```

Then run the `App` scheme, and the `App B` scheme, on the **same** simulator
(`localhost` reaches the host directly — no `adb reverse` equivalent needed).

### One-time Xcode setup of the `App B` target

This is the only manual step (Xcode does not script target creation reliably):

1. **Duplicate the target.** Project navigator → select the `App` target →
   right-click → **Duplicate**. Xcode creates `App copy`.
2. **Rename** `App copy` → `App B` (double-click the target name).
3. **Drop the duplicated Info.plist.** Duplication creates `App copy-Info.plist`;
   delete it, then set the `App B` target → Build Settings → *Packaging* →
   **Info.plist File** = `App/Info.plist` (reuse App's, single source of truth).
4. **Set the two build settings** on the `App B` target → Build Settings:
   - **Bundle Identifier** = `fr.gouv.suite.messages.b`
   - add a **User-Defined** setting `PRODUCT_DISPLAY_NAME` = `Messages B`
     (the `App` target keeps the `Messages` default, nothing to set there).
5. **Check membership of the shared inputs** on `App B`:
   - Build Phases → *Copy Bundle Resources* contains the `public` folder
     (blue reference) and `Assets.xcassets`.
   - Build Phases → *Compile Sources* contains `AppDelegate.swift`,
     `MainViewController.swift`, `WebAuthSessionPlugin.swift`.
   - The local Swift package `CapApp-SPM` is in *Link Binary With Libraries*
     (re-add it from the Package Dependencies if Xcode dropped it).
6. **Wire the shared scheme.** Two shared schemes are already committed under
   `App.xcodeproj/xcshareddata/xcschemes/` (`App.xcscheme`, `App B.xcscheme`),
   so you do not need *Manage Schemes → Shared*. `App B.xcscheme` ships with a
   placeholder target id: replace the three `__APP_B_TARGET_UUID__` occurrences
   with the UUID Xcode gave the `App B` target — find it in `project.pbxproj` on
   the line `<UUID> /* App B */ = { isa = PBXNativeTarget;`:

   ```bash
   cd src/frontend/ios
   # The UUID sits on the line above `isa = PBXNativeTarget`.
   APP_B_UUID=$(grep -B1 "isa = PBXNativeTarget" App/App.xcodeproj/project.pbxproj \
     | grep "/\* App B \*/" | grep -oE "[0-9A-F]{24}" | head -1)
   sed -i '' "s/__APP_B_TARGET_UUID__/$APP_B_UUID/g" "App/App.xcodeproj/xcshareddata/xcschemes/App B.xcscheme"
   ```

   If Xcode also auto-created an `App B` scheme in your `xcuserdata`, delete it so
   the shared one wins.

Commit `project.pbxproj` and the finalized `App B.xcscheme` — the `App B`
target is then reproducible for everyone.

> Alternative without a second target (CLI only): build App B by overriding the
> two settings at build time —
> `xcodebuild -scheme App -sdk iphonesimulator PRODUCT_BUNDLE_IDENTIFIER=fr.gouv.suite.messages.b PRODUCT_DISPLAY_NAME="Messages B"`.
> Handy for CI, but the in-IDE run-and-debug flow is nicer with a real target.

## Further acceptance checks

The core cross-app SSO check is described in
[The cross-app SSO test](#the-cross-app-sso-test) (Android). Beyond it:

- **iOS — tick "Remember me"** on the Keycloak form at app A's first login.
  `ASWebAuthenticationSession` only shares Safari's *persistent* cookies, and
  the Keycloak identity cookie is a session cookie unless "Remember me" is set
  (see limitations). On Android Custom Tabs this is not required.
- **Thread rendering**: open a thread — the message body iframe (srcDoc +
  sandbox + CSP) must render. This is what broke the previous React Native
  attempt.
- **Silent re-login**: logout in app A, then login again → still silent. Logout
  only drops the local session; the IdP session is deliberately preserved.

## Cross-app SSO depends on the IdP honoring its session for the requested LoA

The whole cross-app SSO rests on the second app's `/authenticate/` reaching the
IdP and the IdP **silently reusing its existing session** instead of showing the
form. Two server-side conditions must hold — both bit us during the POC:

- **Requested ACR must be satisfiable.** The backend sends
  `OIDC_AUTH_REQUEST_EXTRA_PARAMS={"acr_values": "eidas1"}` (required by
  ProConnect). The IdP only skips the form if the existing session already meets
  that Level of Assurance. The **dev Keycloak realm therefore maps `eidas1`**
  (`acr.loa.map` on the `messages` client in `src/keycloak/realm.json`) — with an
  empty map Keycloak cannot resolve `eidas1`, **forces re-authentication on every
  OIDC flow, and silently breaks cross-app SSO**. Do not remove that mapping.
  *Validated against ProConnect (agentconnect integ): it reuses its session with
  `eidas1`.*
- **The IdP session cookie must be persistent for iOS** (see below).

> Beware the false positive: visiting the web app at `localhost:8900` may "log in
> silently" simply because the **Django** session cookie is still valid — that
> path never hits `/authorize`, so it does **not** prove IdP SSO. Always test the
> mobile flow (`/api/v1.0/authenticate/?mobile_scheme=…`) to exercise Keycloak.

## Known limitations (POC scope)

- **iOS SSO needs persistent IdP cookies**: `ASWebAuthenticationSession` shares
  Safari's *persistent* cookies only; the Keycloak identity cookie is a session
  cookie unless "Remember me" is ticked. The dev realm sets
  `ssoSessionIdleTimeoutRememberMe` / `ssoSessionMaxLifespanRememberMe` so that
  ticking "Remember me" yields a persistent cookie (validated on the iOS
  simulator). The same constraint applies on a fresh Android Custom Tab, which
  also only reliably inherits *persistent* IdP cookies. ProConnect session
  persistence must be confirmed for production.
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
(cross-app session reuse with `acr_values=eidas1` is validated on agentconnect
integ; still to confirm: SSO session duration and persistent-cookie behaviour
for iOS in production).

## Environment variables

See [env.md](./env.md) — `MOBILE_AUTH_CALLBACK_SCHEMES`, `MOBILE_AUTH_TOKEN_TTL`,
and the `NEXT_PUBLIC_API_ORIGIN` requirement for mobile builds.
