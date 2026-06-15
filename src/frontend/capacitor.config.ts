import type { CapacitorConfig } from "@capacitor/cli";

/**
 * Two POC variants prove cross-app SSO: variant "a" is the default build,
 * variant "b" (MESSAGES_APP_VARIANT=b) installs side by side with its own
 * appId and deep-link scheme. On Android the appId/scheme of the actual
 * build are driven by the Gradle properties messagesAppId/messagesAuthScheme;
 * on iOS by PRODUCT_BUNDLE_IDENTIFIER (ASWebAuthenticationSession needs no
 * Info.plist scheme declaration).
 */
// const variant = process.env.MESSAGES_APP_VARIANT === "b" ? "b" : "a";
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
  },
};

export default config;
