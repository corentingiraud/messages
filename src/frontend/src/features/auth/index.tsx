import React, { PropsWithChildren, useEffect, useMemo } from "react";

import { getRequestUrl } from "@/features/api/utils";
import { useUsersMeRetrieve } from "@/features/api/gen/users/users";
import { Spinner } from "@gouvfr-lasuite/ui-kit";
import { UserWithAbilities } from "../api/gen/models/user_with_abilities";
import { addToast, ToasterItem } from "../ui/components/toaster";
import { useTranslation } from "react-i18next";
import { OIDC_LOGIN_ATTEMPT_KEY, SESSION_EXPIRED_KEY } from "../config/constants";
import { useConfig } from "../providers/config";
import { attemptSilentLogin, canAttemptSilentLogin } from "./silent-login";

export const logout = () => {
  window.location.replace(getRequestUrl("/api/v1.0/logout/"));
};

/**
 * Restricts the post-login redirect to the current site origin to prevent
 * open redirects. Accepts a relative path or absolute URL; returns an
 * absolute URL on the current origin, or undefined if the input is malformed
 * or off-origin.
 */
const sanitizeNextUrl = (raw?: string): string | undefined => {
  if (!raw) return undefined;
  try {
    const absolute = new URL(raw, window.location.origin);
    if (absolute.origin !== window.location.origin) return undefined;
    return absolute.href;
  } catch {
    return undefined;
  }
};

export const login = (nextUrl?: string) => {
  const safeNext = sanitizeNextUrl(nextUrl);
  const params = safeNext ? { next: safeNext } : undefined;
  // Marker read back after the OIDC callback to detect a failed sign-in
  // (e.g. no Messages user exists for the authenticated identity).
  sessionStorage.setItem(OIDC_LOGIN_ATTEMPT_KEY, "true");
  window.location.replace(getRequestUrl("/api/v1.0/authenticate/", params));
};

interface AuthContextInterface {
  user?: UserWithAbilities | null;
}

export const AuthContext = React.createContext<AuthContextInterface>({});

export const useAuth = () => React.useContext(AuthContext);

export const Auth = ({
  children,
  redirect,
}: PropsWithChildren & { redirect?: boolean }) => {
  const { t } = useTranslation();
  const config = useConfig();
  const query = useUsersMeRetrieve({
    query: {
      meta: {
        noGlobalError: true,
      },
    },
    request: { logoutOn401: false },
  });

  /* User is null if the query is 401 error
   * User is the user object if the query is successful
   * Otherwise, user is undefined
   */
  const user = useMemo(() => {
    if (query.data?.data) return query.data.data;
    if (query.isError && query.error?.code === 401) return null;
    return undefined;
  }, [query.isError, query.error?.code, query.data]);
  const shouldAttemptSilentLogin = useMemo(() => {
    if (!config.FRONTEND_SILENT_LOGIN_ENABLED) return false;
    if (user !== null) return false;
    if (!canAttemptSilentLogin()) return false;
    if (typeof window === "undefined") return false;
    // Skip silent login while a one-shot toast still needs to be shown,
    // otherwise the redirect unmounts the page before the Toaster renders
    // (e.g. failed explicit sign-in, or session expired notification).
    if (sessionStorage.getItem(OIDC_LOGIN_ATTEMPT_KEY)) return false;
    if (sessionStorage.getItem(SESSION_EXPIRED_KEY)) return false;
    return true;
  }, [config.FRONTEND_SILENT_LOGIN_ENABLED, user]);

  useEffect(() => {
    if (user !== null) return;

    if (shouldAttemptSilentLogin) {
      attemptSilentLogin();
      return;
    }

    if (redirect) {
      login();
    }
  }, [user]);

  // When the session is expired, display a toast to inform the user that
  // they have been disconnected for that reason. Deferred until `user` is
  // resolved so the Toaster has been mounted by the rendered children.
  useEffect(() => {
    if (user === undefined) return;
    if (!sessionStorage.getItem(SESSION_EXPIRED_KEY)) return;
    sessionStorage.removeItem(SESSION_EXPIRED_KEY);
    addToast(
      <ToasterItem type="info">
        {t('Your session has expired. Please log in again.')}
      </ToasterItem>
    );
  }, [user, t]);

  // After an explicit OIDC sign-in attempt, warn the user when no Messages
  // account is associated with the authenticated identity (the backend
  // redirects to the homepage unauthenticated in that case).
  useEffect(() => {
    if (user === undefined) return;
    if (!sessionStorage.getItem(OIDC_LOGIN_ATTEMPT_KEY)) return;
    sessionStorage.removeItem(OIDC_LOGIN_ATTEMPT_KEY);
    if (user === null) {
      addToast(
        <ToasterItem type="warning">
          {t('No Messages account is associated with this identity. Please contact your administrator.')}
        </ToasterItem>
      );
    }
  }, [user, t]);

  if (query.isLoading || shouldAttemptSilentLogin) {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          height: "100vh"
        }}
      >
        <Spinner size="xl" />
      </div>
    );
  }

  return (
    <AuthContext.Provider value={{ user }}>
      {children}
    </AuthContext.Provider>
  );
};
