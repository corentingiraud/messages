import { App } from "@capacitor/app";
import { CapacitorCookies } from "@capacitor/core";

import { getRequestUrl } from "@/features/api/utils";

import { openAuthSession } from "./auth-session";
import { setNativeCsrfToken } from "./csrf";
import { computeCodeChallenge, generateCodeVerifier } from "./pkce";

/**
 * Deep-link scheme of each app variant, keyed by application id. Allows a
 * single JS bundle to serve both POC builds; the backend allowlists the
 * schemes through MOBILE_AUTH_CALLBACK_SCHEMES.
 */
const SCHEME_BY_APP_ID: Record<string, string> = {
  "fr.gouv.suite.messages.a": "stmessagesa",
  "fr.gouv.suite.messages.b": "stmessagesb",
};

type ExchangeResponse = {
  csrf_token: string;
};

const getCallbackScheme = async (): Promise<string> => {
  const { id } = await App.getInfo();
  const scheme = SCHEME_BY_APP_ID[id];
  if (!scheme) {
    throw new Error(`No auth callback scheme registered for app id "${id}".`);
  }
  return scheme;
};

/**
 * Run the OIDC login in the system browser and hand the resulting Django
 * session over to the native HTTP layer.
 *
 * The system browser shares the identity provider session cookie across
 * apps, which is what provides cross-app SSO. The backend ends the flow
 * with a deep link carrying a one-time token, exchanged here (with the
 * PKCE verifier) for the session cookie.
 */
export const nativeLogin = async (): Promise<void> => {
  try {
    const scheme = await getCallbackScheme();
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = await computeCodeChallenge(codeVerifier);

    const callbackUrl = await openAuthSession(
      getRequestUrl("/api/v1.0/authenticate/", {
        mobile_scheme: scheme,
        code_challenge: codeChallenge,
      }),
      scheme,
    );

    const callbackParams = new URL(callbackUrl).searchParams;
    const token = callbackParams.get("token");
    if (!token) {
      throw new Error(
        `Native login failed: ${callbackParams.get("error") ?? "no token in callback"}`,
      );
    }

    const response = await fetch(getRequestUrl("/api/v1.0/mobile/auth/exchange/"), {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, code_verifier: codeVerifier }),
    });
    if (!response.ok) {
      throw new Error(`Mobile session exchange failed (${response.status}).`);
    }

    const { csrf_token: csrfToken } = (await response.json()) as ExchangeResponse;
    setNativeCsrfToken(csrfToken);
    window.location.reload();
  } catch (error) {
    // A cancelled system-browser sheet lands here too: stay on the login
    // screen instead of crashing the shell.
    console.warn("Native login did not complete:", error);
  }
};

/**
 * Drop the local session.
 *
 * POC scope: calling /api/v1.0/logout/ would trigger the RP-initiated IdP
 * logout (id_token_hint) and terminate the cross-app SSO session. Instead
 * only the native cookies are cleared; the server-side Django session
 * simply expires (12h TTL).
 */
export const nativeLogout = async (): Promise<void> => {
  await CapacitorCookies.clearAllCookies();
  setNativeCsrfToken(null);
  window.location.reload();
};
