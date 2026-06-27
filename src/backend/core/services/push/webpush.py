"""Web Push (VAPID + aes128gcm) sender and VAPID helpers.

The aes128gcm flow is built directly: VAPID JWT via ``py-vapid``, payload
encryption via ``http-ece``. Delivery goes through :class:`SSRFSafeSession`
because the subscription endpoint is client-supplied. A web channel stores the
endpoint in ``encrypted_settings.token`` and the ``keys`` (p256dh/auth) in
``encrypted_settings.keys``.
"""

# pylint: disable=broad-exception-caught

from __future__ import annotations

import base64
import hashlib
import json
import time
from logging import getLogger
from urllib.parse import urlparse

from django.conf import settings

import http_ece
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec
from py_vapid import Vapid02

from core import models
from core.services.push.common import (
    PUSH_HTTP_TIMEOUT,
    PushResult,
    _channel_keys,
    _channel_token,
    _deactivate_stale_channels,
    _is_transient_status,
)
from core.services.ssrf import SSRFSafeSession, SSRFValidationError

logger = getLogger(__name__)

# Web Push TTL: how long the push service holds an undelivered message for an
# offline device. The payload is only a refetch *trigger* (and a badge count),
# so a long retention isn't useful — a trigger surfacing days later just shows a
# misleading "new message". One day covers a phone offline overnight without
# resurrecting stale triggers.
WEBPUSH_TTL_SECONDS = 24 * 3600


def _web_push_topic(collapse_key: str) -> str:
    """A Web Push ``Topic`` header derived from ``collapse_key``.

    RFC 8030 §5.4 caps ``Topic`` at 32 chars from the URL-safe base64 alphabet;
    our ``thread-<uuid>`` collapse key is 43 chars, which push services reject
    with 400 (silently dropping the notification). Hash it to a stable 32-char
    url-safe token. APNs/FCM use the raw collapse key (their limits are larger),
    so only Web Push needs this.
    """
    digest = hashlib.sha256(collapse_key.encode("utf-8")).digest()
    return base64.urlsafe_b64encode(digest).decode("ascii").rstrip("=")[:32]


def _valid_vapid_subject(subject) -> bool:
    """RFC 8292 requires the VAPID ``sub`` to be a ``mailto:`` or ``https:`` URI.

    A bare email (a common mistake) makes browsers reject the signed JWT with a
    401, so we treat a malformed subject as "not configured" rather than sending
    requests doomed to fail.
    """
    return bool(subject) and (
        subject.startswith("mailto:") or subject.startswith("https://")
    )


def _webpush_configured() -> bool:
    """True when the VAPID private key + a well-formed subject are present."""
    if not (settings.PUSH_VAPID_PRIVATE_KEY and settings.PUSH_VAPID_SUBJECT):
        return False
    if not _valid_vapid_subject(settings.PUSH_VAPID_SUBJECT):
        logger.warning(
            "PUSH_VAPID_SUBJECT %r is not a mailto:/https: URI; "
            "Web Push is disabled until it is fixed.",
            settings.PUSH_VAPID_SUBJECT,
        )
        return False
    return True


def derive_vapid_public_key(private_pem: str) -> str | None:
    """Derive the base64url public key (P-256 point) from a VAPID private PEM.

    The public key is deterministic from the private key, so an operator never
    has to generate it separately — the ``derive_vapid_public_key`` management
    command runs this once to print the value they then pin in
    ``PUSH_VAPID_PUBLIC_KEY``. It is intentionally *not* called on the request
    path: ``/config`` reads the configured env var directly so the web worker
    never has to import this module (and its push/crypto dependency graph).
    """
    try:
        vapid = Vapid02.from_pem(private_pem.encode("utf-8"))
        raw = vapid.public_key.public_bytes(
            serialization.Encoding.X962,
            serialization.PublicFormat.UncompressedPoint,
        )
        return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")
    except Exception as exc:
        logger.warning("Failed to derive VAPID public key: %s", exc)
        return None


def _b64url_decode(value: str) -> bytes:
    """Decode a base64url value tolerating missing padding."""
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def send_webpush(
    items: list[tuple[models.Channel, dict]], collapse_key: str
) -> PushResult:
    """Send to web devices via the Web Push protocol (VAPID).

    ``items`` pairs each subscription channel with its own thin payload. A
    404/410 removes the subscription (via the circuit-breaker); transient
    failures (429 / 5xx / network) are counted for retry. Returns a
    :class:`PushResult`.

    Delivery goes through :class:`SSRFSafeSession` because the endpoint is
    client-supplied at registration: it pins the resolved IP and rejects
    loopback/private/metadata targets, so a malicious subscription can't turn
    this into an SSRF against internal services.
    """
    if not items or not _webpush_configured():
        return PushResult()

    try:
        vapid = Vapid02.from_pem(settings.PUSH_VAPID_PRIVATE_KEY.encode("utf-8"))
    except Exception as exc:
        logger.warning("Invalid VAPID key; skipping Web Push: %s", exc)
        return PushResult()

    delivered = 0
    transient = 0
    stale: list[models.Channel] = []
    for channel, payload in items:
        keys = _channel_keys(channel)
        endpoint = _channel_token(channel)
        if not keys or not endpoint:
            logger.warning(
                "Web Push channel %s missing endpoint/keys; skipping", channel.id
            )
            continue
        try:
            encrypted = http_ece.encrypt(
                json.dumps(payload).encode("utf-8"),
                private_key=ec.generate_private_key(ec.SECP256R1()),
                dh=_b64url_decode(keys["p256dh"]),
                auth_secret=_b64url_decode(keys["auth"]),
                version="aes128gcm",
            )
            origin = "{u.scheme}://{u.netloc}".format(u=urlparse(endpoint))
            headers = {
                "content-encoding": "aes128gcm",
                "ttl": str(WEBPUSH_TTL_SECONDS),
                "urgency": "high",
                **vapid.sign(
                    {
                        "aud": origin,
                        "sub": settings.PUSH_VAPID_SUBJECT,
                        "exp": int(time.time()) + 12 * 3600,
                    }
                ),
            }
            if collapse_key:
                headers["topic"] = _web_push_topic(collapse_key)
            resp = SSRFSafeSession().post(
                endpoint,
                timeout=int(PUSH_HTTP_TIMEOUT),
                data=encrypted,
                headers=headers,
            )
        except SSRFValidationError as exc:
            # Endpoint resolves to an internal/blocked address — never deliver,
            # but don't delete (could be transient DNS) and don't retry (the
            # endpoint is structurally unsafe); just log and skip.
            logger.warning(
                "Web Push endpoint for channel %s blocked by SSRF guard: %s",
                channel.id,
                exc,
            )
            continue
        except Exception as exc:
            # Network/encryption error — transient, retry the batch.
            logger.warning("Web Push failed for channel %s: %s", channel.id, exc)
            transient += 1
            continue

        if resp.status_code in (200, 201, 202):
            delivered += 1
            continue
        if resp.status_code in (404, 410):
            logger.info("Web Push reports channel %s gone", channel.id)
            stale.append(channel)
        elif _is_transient_status(resp.status_code):
            logger.warning(
                "Web Push transient failure for channel %s: status=%s",
                channel.id,
                resp.status_code,
            )
            transient += 1
        else:
            logger.warning(
                "Web Push rejected channel %s: status=%s",
                channel.id,
                resp.status_code,
            )

    _deactivate_stale_channels(stale, len(items), platform="web")
    return PushResult(delivered, transient)
