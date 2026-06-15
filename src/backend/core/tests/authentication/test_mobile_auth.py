"""Tests for the mobile (Capacitor) OIDC session handoff."""

import time
from importlib import import_module
from urllib.parse import parse_qs, urlparse

from django.conf import settings
from django.contrib.auth import BACKEND_SESSION_KEY, HASH_SESSION_KEY, SESSION_KEY
from django.contrib.sessions.middleware import SessionMiddleware
from django.core.cache import cache
from django.test import RequestFactory
from django.test.utils import override_settings
from django.urls import reverse

import pytest
from rest_framework import status
from rest_framework.test import APIClient

from core import factories
from core.api.viewsets.mobile_auth import _s256
from core.authentication.views import (
    MOBILE_AUTH_SESSION_KEY,
    MOBILE_AUTH_TOKEN_CACHE_PREFIX,
    OIDCAuthenticationCallbackView,
)

pytestmark = pytest.mark.django_db

AUTHENTICATE_SETTINGS = {
    "MOBILE_AUTH_CALLBACK_SCHEMES": ["stmessagesa", "stmessagesb"],
    "OIDC_OP_AUTHORIZATION_ENDPOINT": "https://oidc.test/authorize",
}


class TestMobileAuthenticationRequest:
    """Tests for the mobile parameters of the authenticate view."""

    @override_settings(**AUTHENTICATE_SETTINGS)
    def test_unknown_scheme_is_rejected(self):
        """A scheme not in the allowlist must be rejected as suspicious."""
        response = APIClient().get(
            reverse("oidc_authentication_init"),
            {"mobile_scheme": "evilapp", "code_challenge": "challenge"},
        )
        assert response.status_code == status.HTTP_400_BAD_REQUEST

    @override_settings(**AUTHENTICATE_SETTINGS)
    def test_missing_code_challenge_is_rejected(self):
        """A mobile login without PKCE challenge must be rejected."""
        response = APIClient().get(
            reverse("oidc_authentication_init"), {"mobile_scheme": "stmessagesa"}
        )
        assert response.status_code == status.HTTP_400_BAD_REQUEST

    @override_settings(**AUTHENTICATE_SETTINGS)
    def test_mobile_login_flags_the_session(self):
        """A valid mobile login redirects to the IdP and flags the session."""
        client = APIClient()
        response = client.get(
            reverse("oidc_authentication_init"),
            {"mobile_scheme": "stmessagesa", "code_challenge": "challenge"},
        )
        assert response.status_code == status.HTTP_302_FOUND
        assert response["Location"].startswith("https://oidc.test/authorize")
        mobile_auth = client.session[MOBILE_AUTH_SESSION_KEY]
        assert mobile_auth["scheme"] == "stmessagesa"
        assert mobile_auth["code_challenge"] == "challenge"

    @override_settings(**AUTHENTICATE_SETTINGS)
    def test_web_login_does_not_flag_the_session(self):
        """The web flow must not be affected by the mobile handoff support."""
        client = APIClient()
        response = client.get(reverse("oidc_authentication_init"))
        assert response.status_code == status.HTTP_302_FOUND
        assert MOBILE_AUTH_SESSION_KEY not in client.session


@override_settings(
    MOBILE_AUTH_CALLBACK_SCHEMES=["stmessagesa", "stmessagesb"],
    LOGIN_REDIRECT_URL="/",
    LOGIN_REDIRECT_URL_FAILURE="/auth-failure",
)
class TestMobileAuthenticationCallback:
    """Tests for the mobile handoff performed by the callback view."""

    def _build_view(self, session_data=None):
        """Return a callback view bound to a request with a real session."""
        request = RequestFactory().get("/api/v1.0/callback/")
        SessionMiddleware(lambda _request: None).process_request(request)
        for key, value in (session_data or {}).items():
            request.session[key] = value
        request.session.save()

        user = factories.UserFactory()
        user.backend = "core.authentication.backends.OIDCAuthenticationBackend"

        view = OIDCAuthenticationCallbackView()
        view.request = request
        view.user = user
        return view

    def test_mobile_login_success_redirects_to_the_app(self):
        """A mobile login ends with a deep link carrying a one-time token."""
        view = self._build_view(
            {
                MOBILE_AUTH_SESSION_KEY: {
                    "scheme": "stmessagesa",
                    "code_challenge": "challenge",
                    "created_at": time.time(),
                }
            }
        )
        response = view.login_success()

        assert response.status_code == status.HTTP_302_FOUND
        location = urlparse(response["Location"])
        assert location.scheme == "stmessagesa"
        assert location.netloc == "auth"

        token = parse_qs(location.query)["token"][0]
        payload = cache.get(f"{MOBILE_AUTH_TOKEN_CACHE_PREFIX}:{token}")
        assert payload["code_challenge"] == "challenge"
        # The session key is cycled by auth.login, the cache entry must hold
        # the post-login key so the exchanged cookie authenticates requests.
        assert payload["session_key"] == view.request.session.session_key
        assert MOBILE_AUTH_SESSION_KEY not in view.request.session

    def test_web_login_success_is_unchanged(self):
        """Without the mobile flag, the callback keeps its web behavior."""
        view = self._build_view()
        response = view.login_success()
        assert response.status_code == status.HTTP_302_FOUND
        assert response["Location"] == "/"

    def test_stale_mobile_flag_is_ignored(self):
        """An abandoned mobile attempt must not hijack a later web login."""
        view = self._build_view(
            {
                MOBILE_AUTH_SESSION_KEY: {
                    "scheme": "stmessagesa",
                    "code_challenge": "challenge",
                    "created_at": time.time() - 3600,
                }
            }
        )
        response = view.login_success()
        assert response["Location"] == "/"
        assert MOBILE_AUTH_SESSION_KEY not in view.request.session

    def test_mobile_login_failure_redirects_to_the_app(self):
        """A failed mobile login notifies the app through the deep link."""
        view = self._build_view(
            {
                MOBILE_AUTH_SESSION_KEY: {
                    "scheme": "stmessagesa",
                    "code_challenge": "challenge",
                    "created_at": time.time(),
                }
            }
        )
        response = view.login_failure()
        assert response.status_code == status.HTTP_302_FOUND
        assert response["Location"] == "stmessagesa://auth?error=login_failed"

    def test_web_login_failure_is_unchanged(self):
        """Without the mobile flag, a failed login keeps its web behavior."""
        view = self._build_view()
        response = view.login_failure()
        assert response["Location"] == "/auth-failure"


class TestMobileSessionExchange:
    """Tests for the one-time token → session cookie exchange endpoint."""

    VERIFIER = "mobile-app-code-verifier"
    TOKEN = "one-time-token"

    def _mint_token(self, user):
        """Create an authenticated session and the matching one-time token."""
        engine = import_module(settings.SESSION_ENGINE)
        session = engine.SessionStore()
        session[SESSION_KEY] = str(user.pk)
        session[BACKEND_SESSION_KEY] = (
            "core.authentication.backends.OIDCAuthenticationBackend"
        )
        session[HASH_SESSION_KEY] = user.get_session_auth_hash()
        session.save()

        cache.set(
            f"{MOBILE_AUTH_TOKEN_CACHE_PREFIX}:{self.TOKEN}",
            {
                "session_key": session.session_key,
                "code_challenge": _s256(self.VERIFIER),
            },
            timeout=60,
        )
        return session

    def _exchange(self, client, **overrides):
        """POST the exchange payload, allowing per-test overrides."""
        payload = {"token": self.TOKEN, "code_verifier": self.VERIFIER, **overrides}
        return client.post(
            reverse("mobile-auth-exchange"),
            {key: value for key, value in payload.items() if value is not None},
            format="json",
        )

    def test_exchange_success_sets_the_session_cookie(self):
        """A valid exchange returns the session cookie and a CSRF token."""
        user = factories.UserFactory()
        session = self._mint_token(user)
        client = APIClient()

        response = self._exchange(client)

        assert response.status_code == status.HTTP_200_OK
        assert response.data["csrf_token"]
        assert (
            response.cookies[settings.SESSION_COOKIE_NAME].value
            == session.session_key
        )
        assert settings.CSRF_COOKIE_NAME in response.cookies
        # The cookie carried over by the client now authenticates API calls.
        me_response = client.get("/api/v1.0/users/me/")
        assert me_response.status_code == status.HTTP_200_OK
        assert me_response.data["email"] == user.email

    def test_exchange_token_is_single_use(self):
        """Replaying a consumed token must be rejected."""
        self._mint_token(factories.UserFactory())
        client = APIClient()

        assert self._exchange(client).status_code == status.HTTP_200_OK
        assert self._exchange(client).status_code == status.HTTP_403_FORBIDDEN

    def test_exchange_wrong_verifier_consumes_the_token(self):
        """A wrong PKCE verifier is rejected and burns the token."""
        self._mint_token(factories.UserFactory())
        client = APIClient()

        response = self._exchange(client, code_verifier="wrong-verifier")
        assert response.status_code == status.HTTP_403_FORBIDDEN
        # The token was consumed by the failed attempt.
        assert self._exchange(client).status_code == status.HTTP_403_FORBIDDEN

    def test_exchange_missing_parameters(self):
        """Both the token and the verifier are required."""
        client = APIClient()
        assert (
            self._exchange(client, code_verifier=None).status_code
            == status.HTTP_400_BAD_REQUEST
        )
        assert (
            self._exchange(client, token=None).status_code
            == status.HTTP_400_BAD_REQUEST
        )

    def test_exchange_expired_session(self):
        """A token referencing a vanished session must be rejected."""
        cache.set(
            f"{MOBILE_AUTH_TOKEN_CACHE_PREFIX}:{self.TOKEN}",
            {
                "session_key": "vanished-session-key",
                "code_challenge": _s256(self.VERIFIER),
            },
            timeout=60,
        )
        response = self._exchange(APIClient())
        assert response.status_code == status.HTTP_403_FORBIDDEN
