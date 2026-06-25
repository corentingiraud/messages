import type { CapacitorConfig } from "@capacitor/cli";

/**
 * Two POC variants prove cross-app SSO: they install side by side with their
 * own appId and deep-link scheme. The shared JS bundle resolves the scheme at
 * runtime from the appId (see src/features/native/auth.ts SCHEME_BY_APP_ID),
 * so the appId below only seeds Capacitor defaults: on Android the real appId
 * and scheme come from the Gradle product flavors a/b (android/app/build.gradle),
 * on iOS from the App / App B Xcode targets, which differ only by
 * PRODUCT_BUNDLE_IDENTIFIER and PRODUCT_DISPLAY_NAME (ASWebAuthenticationSession
 * needs no Info.plist scheme declaration). See docs/mobile-poc.md.
 */
const variant = "a" as "a" | "b";

const config: CapacitorConfig = {
  appId: `fr.gouv.suite.messages.${variant}`,
  appName: variant === "b" ? "Messages B" : "Messages",
  webDir: "dist",
  server: {
    // Dev only: allows the Android WebView to reach http://localhost:8901.
    cleartext: true,
  },
  plugins: {
    // Route window.fetch through the native HTTP layer: session cookies
    // live in the native jar (no SameSite/ITP restriction, works over the
    // plain-HTTP dev backend) and CORS does not apply.
    CapacitorHttp: {
      enabled: true,
    },
    CapacitorCookies: {
      enabled: true,
    },
    // Disable Capacitor 8's built-in SystemBars inset listener: combined with
    // windowSoftInputMode=adjustResize it double-applies the keyboard inset, so
    // the WebView shrinks by twice the keyboard height (capacitor #8181, the
    // Android < 15 variant). Trade-off: Capacitor stops injecting the safe-area
    // values, so env(safe-area-inset-*) may resolve to 0.
    SystemBars: {
        insetsHandling: "disable",
    },
  },
};

export default config;
