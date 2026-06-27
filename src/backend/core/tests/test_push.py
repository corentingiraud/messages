"""Tests for the mobile/web push-notification workstream.

Push targets are modelled as user-scoped ``Channel`` rows of type ``push``
(one per device) — so the device token lives encrypted in
``encrypted_settings`` and users get device management (list / un-associate)
for free via ``/users/me/channels/``.

Covers: device registration (incl. reclaim on account switch), the thin
privacy-preserving payload, the ``enqueue_push_notifications`` on-commit
helper, the ``send_push_for_message`` task, each sender's happy path + its
stale-device removal, and the ``PUSH_ENABLED`` master switch.

Every external gateway (APNs / FCM / Web Push) is mocked — no network.
"""

import hashlib
from unittest import mock

from django.urls import reverse
from django.utils import timezone

import pytest
from rest_framework import status
from rest_framework.test import APIClient

from core import enums, factories, models
from core.enums import ChannelScopeLevel, ChannelTypes, PushPlatformChoices
from core.services import push

pytestmark = pytest.mark.django_db


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _user_with_message():
    """A user with access to a mailbox+thread, and a message in it."""
    user = factories.UserFactory()
    mailbox = factories.MailboxFactory()
    factories.MailboxAccessFactory(
        mailbox=mailbox, user=user, role=enums.MailboxRoleChoices.EDITOR
    )
    thread = factories.ThreadFactory(messaged_at=timezone.now())
    factories.ThreadAccessFactory(
        mailbox=mailbox, thread=thread, role=enums.ThreadAccessRoleChoices.EDITOR
    )
    message = factories.MessageFactory(thread=thread)
    return user, message


def _push_channel(user, platform=PushPlatformChoices.APNS, token="tok", keys=None):
    """Create a push channel for ``user`` via the real registration helper."""
    channel, _ = push.register_push_device(
        user=user, platform=platform, token=token, keys=keys
    )
    return channel


# ---------------------------------------------------------------------------
# Device registration (as user-scoped push channels)
# ---------------------------------------------------------------------------


class TestDeviceRegistration:
    """Device registration (POST type=push) + management via /users/me/channels/."""

    @pytest.fixture(autouse=True)
    def _enable_push(self, settings):
        settings.PUSH_ENABLED = True

    def _register(self, client, **body):
        # Push devices register through the generic user-channels create with
        # type=push (idempotent upsert), not a dedicated endpoint.
        return client.post(
            reverse("user-channels-list"),
            {"type": "push", **body},
            format="json",
        )

    def test_requires_authentication(self):
        resp = self._register(APIClient(), platform="apns", token="abc")
        assert resp.status_code in (
            status.HTTP_401_UNAUTHORIZED,
            status.HTTP_403_FORBIDDEN,
        )

    def test_register_creates_push_channel(self):
        user = factories.UserFactory()
        client = APIClient()
        client.force_authenticate(user=user)

        resp = self._register(
            client, platform="fcm", token="fcm-1", app_version="2.3.0"
        )
        assert resp.status_code == status.HTTP_201_CREATED

        ch = models.Channel.objects.get(type=ChannelTypes.PUSH, user=user)
        assert ch.scope_level == ChannelScopeLevel.USER
        assert ch.settings["platform"] == "fcm"
        assert ch.settings["app_version"] == "2.3.0"
        # Token is stored ENCRYPTED, not in queryable settings.
        assert ch.encrypted_settings["token"] == "fcm-1"
        assert "token" not in ch.settings
        # Dedup key is the indexed column, not buried in settings.
        assert ch.lookup_hash == hashlib.sha256(b"fcm-1").hexdigest()
        assert "token_hash" not in ch.settings

    def test_reregister_same_device_updates_in_place(self):
        user = factories.UserFactory()
        client = APIClient()
        client.force_authenticate(user=user)

        assert (
            self._register(
                client, platform="apns", token="apns-1", app_version="1.0.0"
            ).status_code
            == status.HTTP_201_CREATED
        )
        resp = self._register(
            client, platform="apns", token="apns-1", app_version="9.9.9"
        )
        assert resp.status_code == status.HTTP_200_OK  # refresh, not create
        assert (
            models.Channel.objects.filter(type=ChannelTypes.PUSH, user=user).count()
            == 1
        )
        ch = models.Channel.objects.get(type=ChannelTypes.PUSH, user=user)
        assert ch.settings["app_version"] == "9.9.9"

    def test_register_reclaims_device_from_other_user(self):
        """A token re-registered by a new user (device changed accounts) is a
        delete + fresh create: the old row is gone, and the new one does NOT
        inherit the previous owner's id or device label."""
        old = factories.UserFactory()
        old_channel, _ = push.register_push_device(
            user=old, platform="apns", token="shared-device", name="Old User iPhone"
        )

        new = factories.UserFactory()
        client = APIClient()
        client.force_authenticate(user=new)
        # New owner sends no name → must fall back to the platform default,
        # never the previous owner's label.
        resp = self._register(client, platform="apns", token="shared-device")
        assert resp.status_code == status.HTTP_201_CREATED  # fresh row, not refresh

        assert not models.Channel.objects.filter(
            user=old, type=ChannelTypes.PUSH
        ).exists()
        new_channels = models.Channel.objects.filter(user=new, type=ChannelTypes.PUSH)
        assert new_channels.count() == 1
        new_channel = new_channels.get()
        assert new_channel.id != old_channel.id  # fresh id, no cross-user reuse
        assert new_channel.name != "Old User iPhone"  # no label leak

    def test_registration_prunes_beyond_device_cap(self, settings):
        """A new device beyond PUSH_MAX_DEVICES_PER_USER evicts the LRU one."""
        settings.PUSH_MAX_DEVICES_PER_USER = 2
        user = factories.UserFactory()
        for i in range(4):
            push.register_push_device(user=user, platform="apns", token=f"d{i}")
        assert (
            models.Channel.objects.filter(type=ChannelTypes.PUSH, user=user).count()
            == 2
        )
        # The most recently registered device is always kept.
        assert models.Channel.objects.filter(
            lookup_hash=hashlib.sha256(b"d3").hexdigest()
        ).exists()

    def test_empty_token_rejected(self):
        user = factories.UserFactory()
        client = APIClient()
        client.force_authenticate(user=user)
        resp = self._register(client, platform="apns", token="   ")
        assert resp.status_code == status.HTTP_400_BAD_REQUEST

    def test_register_404_when_push_disabled(self, settings):
        """The endpoint is hidden (not just inert) while the feature is off."""
        settings.PUSH_ENABLED = False
        user = factories.UserFactory()
        client = APIClient()
        client.force_authenticate(user=user)
        resp = self._register(client, platform="apns", token="apns-1")
        assert resp.status_code == status.HTTP_404_NOT_FOUND
        assert not models.Channel.objects.filter(type=ChannelTypes.PUSH).exists()

    def test_web_platform_requires_keys(self):
        user = factories.UserFactory()
        client = APIClient()
        client.force_authenticate(user=user)
        # No keys at all → rejected.
        resp = self._register(client, platform="web", token="endpoint-url")
        assert resp.status_code == status.HTTP_400_BAD_REQUEST
        # Partial keys → still rejected.
        resp = self._register(
            client, platform="web", token="endpoint-url", keys={"p256dh": "x"}
        )
        assert resp.status_code == status.HTTP_400_BAD_REQUEST
        assert not models.Channel.objects.filter(type=ChannelTypes.PUSH).exists()

    def test_web_platform_with_keys_creates_channel(self):
        user = factories.UserFactory()
        client = APIClient()
        client.force_authenticate(user=user)
        resp = self._register(
            client,
            platform="web",
            token="endpoint-url",
            keys={"p256dh": "pub", "auth": "secret"},
        )
        assert resp.status_code == status.HTTP_201_CREATED
        ch = models.Channel.objects.get(type=ChannelTypes.PUSH, user=user)
        assert ch.settings["platform"] == "web"

    def test_push_channel_settings_not_patchable(self):
        """The generic channel update path must not let a client desync the
        queryable push metadata (platform) from the encrypted token."""
        user = factories.UserFactory()
        ch = _push_channel(user, token="immutable")
        client = APIClient()
        client.force_authenticate(user=user)

        resp = client.patch(
            reverse("user-channels-detail", kwargs={"pk": ch.id}),
            {"settings": {"platform": "fcm"}},
            format="json",
        )
        assert resp.status_code == status.HTTP_400_BAD_REQUEST

    def test_list_shows_devices_without_leaking_token(self):
        user = factories.UserFactory()
        _push_channel(user, token="secret-token")
        client = APIClient()
        client.force_authenticate(user=user)

        resp = client.get(reverse("user-channels-list"))
        assert resp.status_code == status.HTTP_200_OK
        blob = str(resp.json())
        assert "secret-token" not in blob  # encrypted_settings never serialized

    def test_unregister_via_channel_delete(self):
        user = factories.UserFactory()
        ch = _push_channel(user, token="to-remove")
        client = APIClient()
        client.force_authenticate(user=user)

        resp = client.delete(reverse("user-channels-detail", kwargs={"pk": ch.id}))
        assert resp.status_code == status.HTTP_204_NO_CONTENT
        assert not models.Channel.objects.filter(id=ch.id).exists()


# ---------------------------------------------------------------------------
# Thin payload & collapse key
# ---------------------------------------------------------------------------


class TestThinPayload:
    def test_payload_is_thin_and_content_free(self):
        _, message = _user_with_message()
        message.subject = "Secret subject that must not leak"

        payload = push.build_thin_payload(message, unread_count=7, mailbox_id="mb-123")
        assert payload == {
            "type": push.PUSH_TYPE_NEW_MESSAGE,
            "thread_id": str(message.thread_id),
            "message_id": str(message.id),
            "mailbox_id": "mb-123",
            "unread_count": 7,
        }
        # Routing ids only — no message content of any kind.
        assert "Secret subject" not in str(payload)
        assert "subject" not in payload and "body" not in payload

    def test_collapse_key_is_per_thread(self):
        _, message = _user_with_message()
        assert push.collapse_key_for_message(message) == f"thread-{message.thread_id}"

    def test_web_push_topic_within_rfc_limit(self):
        """RFC 8030 caps the Web Push Topic at 32 url-safe-base64 chars; the raw
        thread-<uuid> collapse key is 43, so it must be hashed down."""
        _, message = _user_with_message()
        raw = push.collapse_key_for_message(message)
        assert len(raw) > 32  # the raw key would be rejected as-is
        topic = push.webpush._web_push_topic(raw)
        assert 0 < len(topic) <= 32
        assert all(c.isalnum() or c in "-_" for c in topic)
        # Stable for a given key (coalescing must keep working).
        assert topic == push.webpush._web_push_topic(raw)


# ---------------------------------------------------------------------------
# enqueue helper
# ---------------------------------------------------------------------------


class TestEnqueue:
    def test_noop_when_disabled(self, settings):
        settings.PUSH_ENABLED = False
        _, message = _user_with_message()
        with mock.patch.object(push.send_push_for_message, "delay") as delay:
            push.enqueue_push_notifications(message)
        delay.assert_not_called()

    def test_enqueues_on_commit_when_enabled(
        self, settings, django_capture_on_commit_callbacks
    ):
        settings.PUSH_ENABLED = True
        _, message = _user_with_message()
        with mock.patch.object(push.send_push_for_message, "delay") as delay:
            with django_capture_on_commit_callbacks(execute=True):
                push.enqueue_push_notifications(message)
        delay.assert_called_once_with(str(message.id))


# ---------------------------------------------------------------------------
# send_push_for_message task
# ---------------------------------------------------------------------------


class TestSendPushTask:
    def test_skips_when_disabled(self, settings):
        settings.PUSH_ENABLED = False
        _, message = _user_with_message()
        result = push.send_push_for_message(str(message.id))
        assert result["skipped"] == "push_disabled"

    def test_dispatches_one_task_per_device(self, settings):
        settings.PUSH_ENABLED = True
        user, message = _user_with_message()
        _push_channel(user, platform=PushPlatformChoices.APNS, token="a")
        _push_channel(user, platform=PushPlatformChoices.FCM, token="b")

        with (
            mock.patch.object(
                push, "send_apns", return_value=push.PushResult(1, 0)
            ) as apns,
            mock.patch.object(
                push, "send_fcm", return_value=push.PushResult(1, 0)
            ) as fcm,
        ):
            # Celery is eager in tests, so the dispatched per-device tasks run
            # inline and each call the (mocked) sender for its platform.
            result = push.send_push_for_message(str(message.id))

        assert result["dispatched"] == 2  # one task per device
        apns.assert_called_once()
        fcm.assert_called_once()
        # Each task hands its sender a single (channel, payload) pair.
        items, _collapse = apns.call_args.args
        assert len(items) == 1
        channel, payload = items[0]
        assert channel.type == ChannelTypes.PUSH
        assert payload["type"] == push.PUSH_TYPE_NEW_MESSAGE

    def test_sender_exception_is_swallowed(self, settings):
        settings.PUSH_ENABLED = True
        user, message = _user_with_message()
        _push_channel(user, token="a")
        with mock.patch.object(push, "send_apns", side_effect=RuntimeError("boom")):
            result = push.send_push_for_message(str(message.id))
        assert result["success"] is True


# ---------------------------------------------------------------------------
# send_push_notification task (one per device, retryable on transient failures)
# ---------------------------------------------------------------------------


class TestSendPushNotification:
    def test_skips_when_disabled(self, settings):
        settings.PUSH_ENABLED = False
        out = push.send_push_notification("any-id", {"type": "new_message"}, "k")
        assert out["skipped"] == "push_disabled"

    def test_missing_channel_is_skipped(self, settings):
        settings.PUSH_ENABLED = True
        out = push.send_push_notification(
            "00000000-0000-0000-0000-000000000000", {"type": "new_message"}, "k"
        )
        assert out["skipped"] == "channel_gone"

    def test_transient_failure_triggers_retry(self, settings):
        """A transient sender result makes the task retry just this device; the
        collapse key makes the re-send idempotent. Succeeds on the 2nd attempt."""
        settings.PUSH_ENABLED = True
        ch = _push_channel(
            factories.UserFactory(), platform=PushPlatformChoices.FCM, token="b"
        )
        calls = []

        def sender(_items, _collapse):
            calls.append(1)
            return push.PushResult(0, 1) if len(calls) == 1 else push.PushResult(1, 0)

        with (
            mock.patch.object(push, "send_fcm", side_effect=sender),
            mock.patch("time.sleep"),  # neutralize any eager retry backoff
        ):
            result = push.send_push_notification.apply(
                args=(str(ch.id), {"type": "new_message"}, "k")
            )

        assert len(calls) == 2  # retried once after the transient failure
        assert result.result["success"] is True

    def test_sender_bug_does_not_loop_forever(self, settings):
        """A sender that raises (a bug, not a transient signal) ends the task
        rather than retrying — autoretry only fires on PushTransientError."""
        settings.PUSH_ENABLED = True
        ch = _push_channel(
            factories.UserFactory(), platform=PushPlatformChoices.FCM, token="b"
        )
        with mock.patch.object(push, "send_fcm", side_effect=RuntimeError("boom")):
            out = push.send_push_notification(str(ch.id), {"type": "new_message"}, "k")
        assert out["error"] == "sender_raised"


# ---------------------------------------------------------------------------
# APNs sender  (httpx HTTP/2 mocked; _apns_auth_token mocked — no signing key)
# ---------------------------------------------------------------------------


def _configure_apns(settings):
    settings.PUSH_ENABLED = True
    settings.PUSH_APNS_KEY = "-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----"
    settings.PUSH_APNS_KEY_ID = "KEYID123"
    settings.PUSH_APNS_TEAM_ID = "TEAM123"
    settings.PUSH_APNS_BUNDLE_ID = "com.example.app"
    settings.PUSH_APNS_USE_SANDBOX = False


def _client_returning(response):
    """A mock HTTP client (the process-global one senders reuse) whose .post
    returns ``response``."""
    client = mock.MagicMock()
    client.post.return_value = response
    return client


def _items(*channels, payload=None):
    """Build the (channel, payload) list senders now take."""
    payload = payload if payload is not None else {"type": "new_message"}
    return [(ch, payload) for ch in channels]


class TestApnsSender:
    def test_noop_when_not_configured(self, settings):
        settings.PUSH_ENABLED = True
        settings.PUSH_APNS_KEY = None
        ch = _push_channel(factories.UserFactory(), platform=PushPlatformChoices.APNS)
        assert push.send_apns(_items(ch), "thread-x").delivered == 0

    def test_success(self, settings):
        _configure_apns(settings)
        ch = _push_channel(
            factories.UserFactory(), platform=PushPlatformChoices.APNS, token="apns-ok"
        )
        cm = _client_returning(mock.Mock(status_code=200))
        with (
            mock.patch.object(push.apns, "_apns_auth_token", return_value="tok"),
            mock.patch.object(push.apns, "_apns_client", return_value=cm),
        ):
            result = push.send_apns(_items(ch), "thread-x")

        assert result.delivered == 1
        assert models.Channel.objects.filter(id=ch.id).exists()
        post = cm.post
        post.assert_called_once()
        assert post.call_args.kwargs["json"]["aps"]["alert"] == {
            "loc-key": push.APNS_ALERT_LOC_KEY
        }

    def test_unregistered_410_removes_channel(self, settings):
        _configure_apns(settings)
        ch = _push_channel(
            factories.UserFactory(), platform=PushPlatformChoices.APNS, token="dead"
        )
        resp = mock.Mock(status_code=410)
        resp.json.return_value = {"reason": "Unregistered"}
        with (
            mock.patch.object(push.apns, "_apns_auth_token", return_value="tok"),
            mock.patch.object(
                push.apns, "_apns_client", return_value=_client_returning(resp)
            ),
        ):
            push.send_apns(_items(ch), "thread-x")

        assert not models.Channel.objects.filter(id=ch.id).exists()

    def test_config_error_keeps_channel(self, settings):
        _configure_apns(settings)
        ch = _push_channel(
            factories.UserFactory(), platform=PushPlatformChoices.APNS, token="cfg"
        )
        resp = mock.Mock(status_code=400)
        resp.json.return_value = {"reason": "DeviceTokenNotForTopic"}
        with (
            mock.patch.object(push.apns, "_apns_auth_token", return_value="tok"),
            mock.patch.object(
                push.apns, "_apns_client", return_value=_client_returning(resp)
            ),
        ):
            push.send_apns(_items(ch), "thread-x")

        assert models.Channel.objects.filter(id=ch.id).exists()

    def test_bad_device_token_keeps_channel(self, settings):
        """``BadDeviceToken`` is NOT treated as a dead device: it's most often a
        wrong-environment (sandbox/prod) config error, so deleting on it would
        purge live devices on a mis-set flag. The row is kept (logged only)."""
        _configure_apns(settings)
        ch = _push_channel(
            factories.UserFactory(), platform=PushPlatformChoices.APNS, token="badenv"
        )
        resp = mock.Mock(status_code=400)
        resp.json.return_value = {"reason": "BadDeviceToken"}
        with (
            mock.patch.object(push.apns, "_apns_auth_token", return_value="tok"),
            mock.patch.object(
                push.apns, "_apns_client", return_value=_client_returning(resp)
            ),
        ):
            result = push.send_apns(_items(ch), "thread-x")

        assert models.Channel.objects.filter(id=ch.id).exists()
        assert result.transient == 0  # permanent rejection, not retried

    def test_transient_5xx_is_counted_and_keeps_channel(self, settings):
        """A 5xx is transient: keep the device and count it so the batch retries."""
        _configure_apns(settings)
        ch = _push_channel(
            factories.UserFactory(), platform=PushPlatformChoices.APNS, token="t5xx"
        )
        resp = mock.Mock(status_code=503)
        resp.json.return_value = {}
        with (
            mock.patch.object(push.apns, "_apns_auth_token", return_value="tok"),
            mock.patch.object(
                push.apns, "_apns_client", return_value=_client_returning(resp)
            ),
        ):
            result = push.send_apns(_items(ch), "thread-x")

        assert result.delivered == 0
        assert result.transient == 1
        assert models.Channel.objects.filter(id=ch.id).exists()

    def test_provider_token_is_cached_across_calls(self, settings):
        """The ES256 provider token is minted once and reused (Apple throttles
        re-minting), so a second call within the TTL is served from cache."""
        from django.core.cache import cache

        cache.clear()
        _configure_apns(settings)
        with mock.patch("jwt.encode", return_value="signed-jwt") as enc:
            first = push.apns._apns_auth_token()
            second = push.apns._apns_auth_token()

        assert first == second == "signed-jwt"
        enc.assert_called_once()

    def test_alert_is_visible_high_priority_and_content_free(self, settings):
        """The APNs push is a visible, high-priority alert that survives app
        termination — but still carries only a localization key + badge, never
        the message content."""
        _configure_apns(settings)
        ch = _push_channel(
            factories.UserFactory(), platform=PushPlatformChoices.APNS, token="alert"
        )
        cm = _client_returning(mock.Mock(status_code=200))
        with (
            mock.patch.object(push.apns, "_apns_auth_token", return_value="tok"),
            mock.patch.object(push.apns, "_apns_client", return_value=cm),
        ):
            push.send_apns(
                _items(ch, payload={"type": "new_message", "unread_count": 5}),
                "thread-x",
            )

        post = cm.post
        headers = post.call_args.kwargs["headers"]
        assert headers["apns-push-type"] == "alert"
        assert headers["apns-priority"] == "10"
        aps = post.call_args.kwargs["json"]["aps"]
        assert aps["alert"] == {"loc-key": push.APNS_ALERT_LOC_KEY}
        assert aps["badge"] == 5
        assert "content-available" not in aps


# ---------------------------------------------------------------------------
# FCM sender  (httpx mocked)
# ---------------------------------------------------------------------------


def _configure_fcm(settings):
    settings.PUSH_ENABLED = True
    settings.PUSH_FCM_CREDENTIALS = '{"type": "service_account"}'
    settings.PUSH_FCM_PROJECT_ID = "my-project"


class TestFcmSender:
    def test_noop_when_not_configured(self, settings):
        settings.PUSH_ENABLED = True
        settings.PUSH_FCM_CREDENTIALS = None
        ch = _push_channel(factories.UserFactory(), platform=PushPlatformChoices.FCM)
        assert push.send_fcm(_items(ch), "thread-x").delivered == 0

    def test_success(self, settings):
        _configure_fcm(settings)
        ch = _push_channel(
            factories.UserFactory(),
            platform=PushPlatformChoices.FCM,
            token="fcm-ok",
        )
        cm = _client_returning(mock.Mock(status_code=200))
        with (
            mock.patch.object(push.fcm, "_fcm_access_token", return_value="ya29"),
            mock.patch.object(push.fcm, "_fcm_client", return_value=cm),
        ):
            result = push.send_fcm(
                _items(ch, payload={"type": "new_message", "unread_count": 3}), "t-1"
            )

        assert result.delivered == 1
        assert models.Channel.objects.filter(id=ch.id).exists()
        body = cm.post.call_args.kwargs["json"]["message"]
        assert body["token"] == "fcm-ok"
        assert body["data"]["unread_count"] == "3"
        # Sent high-priority so a dozing device still wakes.
        assert body["android"]["priority"] == "high"

    def test_attaches_content_free_notification(self, settings):
        """The FCM message carries an OS-localized notification block so Android
        shows a banner when the app is killed — loc-keys + badge only, never
        the message content."""
        _configure_fcm(settings)
        ch = _push_channel(
            factories.UserFactory(), platform=PushPlatformChoices.FCM, token="fcm-a"
        )
        cm = _client_returning(mock.Mock(status_code=200))
        with (
            mock.patch.object(push.fcm, "_fcm_access_token", return_value="ya29"),
            mock.patch.object(push.fcm, "_fcm_client", return_value=cm),
        ):
            push.send_fcm(
                _items(
                    ch,
                    payload={
                        "type": "new_message",
                        "unread_count": 5,
                        "subject": "leak?",
                    },
                ),
                "t-1",
            )
        notif = cm.post.call_args.kwargs["json"]["message"]["android"]["notification"]
        assert notif["title_loc_key"] == push.FCM_TITLE_LOC_KEY
        assert notif["body_loc_key"] == push.FCM_BODY_LOC_KEY
        assert notif["notification_count"] == 5
        # No literal content anywhere in the notification block.
        assert "leak?" not in str(notif)

    def test_unregistered_removes_channel(self, settings):
        _configure_fcm(settings)
        ch = _push_channel(
            factories.UserFactory(), platform=PushPlatformChoices.FCM, token="dead"
        )
        response = mock.Mock(status_code=404)
        response.json.return_value = {"error": {"status": "UNREGISTERED"}}
        with (
            mock.patch.object(push.fcm, "_fcm_access_token", return_value="ya29"),
            mock.patch.object(
                push.fcm, "_fcm_client", return_value=_client_returning(response)
            ),
        ):
            push.send_fcm(_items(ch), "t-1")

        assert not models.Channel.objects.filter(id=ch.id).exists()

    def test_invalid_argument_keeps_channel(self, settings):
        """INVALID_ARGUMENT may mean a bad *request*, not a dead token — so the
        device must NOT be deleted (else one payload bug wipes the fleet)."""
        _configure_fcm(settings)
        ch = _push_channel(
            factories.UserFactory(), platform=PushPlatformChoices.FCM, token="ok"
        )
        response = mock.Mock(status_code=400, text="invalid argument")
        response.json.return_value = {
            "error": {
                "status": "INVALID_ARGUMENT",
                "details": [{"errorCode": "INVALID_ARGUMENT"}],
            }
        }
        with (
            mock.patch.object(push.fcm, "_fcm_access_token", return_value="ya29"),
            mock.patch.object(
                push.fcm, "_fcm_client", return_value=_client_returning(response)
            ),
        ):
            push.send_fcm(_items(ch), "t-1")

        assert models.Channel.objects.filter(id=ch.id).exists()

    def test_transient_5xx_is_counted(self, settings):
        _configure_fcm(settings)
        ch = _push_channel(
            factories.UserFactory(), platform=PushPlatformChoices.FCM, token="t5xx"
        )
        response = mock.Mock(status_code=503, text="unavailable")
        response.json.return_value = {}
        with (
            mock.patch.object(push.fcm, "_fcm_access_token", return_value="ya29"),
            mock.patch.object(
                push.fcm, "_fcm_client", return_value=_client_returning(response)
            ),
        ):
            result = push.send_fcm(_items(ch), "t-1")

        assert result.transient == 1
        assert models.Channel.objects.filter(id=ch.id).exists()

    def test_access_token_is_cached_across_calls(self, settings):
        from django.core.cache import cache

        cache.clear()
        _configure_fcm(settings)
        creds = mock.Mock(token="ya29-tok")
        with mock.patch(
            "core.services.push.fcm.service_account.Credentials.from_service_account_info",
            return_value=creds,
        ) as from_info:
            first = push.fcm._fcm_access_token()
            second = push.fcm._fcm_access_token()

        assert first == second == "ya29-tok"
        from_info.assert_called_once()


# ---------------------------------------------------------------------------
# Web Push sender  (py-vapid + http-ece mocked; delivery via SSRFSafeSession)
# ---------------------------------------------------------------------------


def _configure_webpush(settings):
    settings.PUSH_ENABLED = True
    settings.PUSH_VAPID_PRIVATE_KEY = "vapid-key"
    settings.PUSH_VAPID_SUBJECT = "mailto:ops@example.com"


def _b64url(raw: bytes) -> str:
    import base64

    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


# Valid base64url subscription keys (http_ece is mocked, so contents are inert,
# but the sender base64url-decodes them before encrypting).
_WEB_KEYS = {"p256dh": _b64url(b"x" * 65), "auth": _b64url(b"y" * 16)}


def _vapid_mock():
    vapid = mock.Mock()
    vapid.sign.return_value = {"Authorization": "vapid t=x,k=y"}
    return vapid


def _ssrf_session_returning(response):
    """A SSRFSafeSession mock whose .post returns ``response``."""
    session = mock.Mock()
    session.post.return_value = response
    return session


class TestWebpushSender:
    """Web Push via py-vapid + http-ece, delivered through SSRFSafeSession."""

    def _web_channel(self):
        return _push_channel(
            factories.UserFactory(),
            platform=PushPlatformChoices.WEB,
            token="https://push.example/ep",
            keys=_WEB_KEYS,
        )

    def test_success(self, settings):
        _configure_webpush(settings)
        ch = self._web_channel()
        session = _ssrf_session_returning(mock.Mock(status_code=201))
        with (
            mock.patch("py_vapid.Vapid02.from_pem", return_value=_vapid_mock()),
            mock.patch("http_ece.encrypt", return_value=b"ciphertext"),
            mock.patch.object(push.webpush, "SSRFSafeSession", return_value=session),
        ):
            result = push.send_webpush(_items(ch), "t-1")

        assert result.delivered == 1
        assert models.Channel.objects.filter(id=ch.id).exists()
        session.post.assert_called_once()
        assert session.post.call_args.kwargs["data"] == b"ciphertext"
        assert session.post.call_args.kwargs["headers"]["content-encoding"] == (
            "aes128gcm"
        )

    def test_gone_removes_channel(self, settings):
        _configure_webpush(settings)
        ch = self._web_channel()
        session = _ssrf_session_returning(mock.Mock(status_code=410))
        with (
            mock.patch("py_vapid.Vapid02.from_pem", return_value=_vapid_mock()),
            mock.patch("http_ece.encrypt", return_value=b"ciphertext"),
            mock.patch.object(push.webpush, "SSRFSafeSession", return_value=session),
        ):
            push.send_webpush(_items(ch), "t-1")

        assert not models.Channel.objects.filter(id=ch.id).exists()

    def test_ssrf_blocked_endpoint_is_kept(self, settings):
        """An endpoint that resolves to an internal/blocked address is refused
        by the SSRF guard — nothing is delivered and the channel is NOT deleted."""
        _configure_webpush(settings)
        ch = self._web_channel()
        session = mock.Mock()
        session.post.side_effect = push.SSRFValidationError("blocked")
        with (
            mock.patch("py_vapid.Vapid02.from_pem", return_value=_vapid_mock()),
            mock.patch("http_ece.encrypt", return_value=b"ciphertext"),
            mock.patch.object(push.webpush, "SSRFSafeSession", return_value=session),
        ):
            result = push.send_webpush(_items(ch), "t-1")

        assert result.delivered == 0
        assert models.Channel.objects.filter(id=ch.id).exists()

    def test_transient_5xx_is_counted(self, settings):
        _configure_webpush(settings)
        ch = self._web_channel()
        session = _ssrf_session_returning(mock.Mock(status_code=503))
        with (
            mock.patch("py_vapid.Vapid02.from_pem", return_value=_vapid_mock()),
            mock.patch("http_ece.encrypt", return_value=b"ciphertext"),
            mock.patch.object(push.webpush, "SSRFSafeSession", return_value=session),
        ):
            result = push.send_webpush(_items(ch), "t-1")

        assert result.transient == 1
        assert models.Channel.objects.filter(id=ch.id).exists()

    def test_malformed_subject_disables_webpush(self, settings):
        """A VAPID subject that isn't a mailto:/https: URI would be rejected by
        the push service (401), so we treat it as not-configured and no-op."""
        _configure_webpush(settings)
        settings.PUSH_VAPID_SUBJECT = "ops@example.com"  # missing mailto:
        ch = self._web_channel()
        session = _ssrf_session_returning(mock.Mock(status_code=201))
        with (
            mock.patch("py_vapid.Vapid02.from_pem", return_value=_vapid_mock()),
            mock.patch("http_ece.encrypt", return_value=b"ciphertext"),
            mock.patch.object(push.webpush, "SSRFSafeSession", return_value=session),
        ):
            result = push.send_webpush(_items(ch), "t-1")

        assert result.delivered == 0
        session.post.assert_not_called()

    def test_ttl_header_is_one_day(self, settings):
        _configure_webpush(settings)
        ch = self._web_channel()
        session = _ssrf_session_returning(mock.Mock(status_code=201))
        with (
            mock.patch("py_vapid.Vapid02.from_pem", return_value=_vapid_mock()),
            mock.patch("http_ece.encrypt", return_value=b"ciphertext"),
            mock.patch.object(push.webpush, "SSRFSafeSession", return_value=session),
        ):
            push.send_webpush(_items(ch), "t-1")

        assert session.post.call_args.kwargs["headers"]["ttl"] == str(
            push.WEBPUSH_TTL_SECONDS
        )


# ---------------------------------------------------------------------------
# Stale-device deactivation circuit-breaker
# ---------------------------------------------------------------------------


class TestStaleDeactivation:
    def _android_channels(self, n):
        user = factories.UserFactory()
        return [
            _push_channel(user, platform=PushPlatformChoices.FCM, token=f"t{i}")
            for i in range(n)
        ]

    def test_single_device_is_deleted(self):
        (ch,) = self._android_channels(1)
        assert push.common._deactivate_stale_channels([ch], 1, platform="fcm") == 1
        assert not models.Channel.objects.filter(id=ch.id).exists()

    def test_minority_stale_is_deleted(self):
        chans = self._android_channels(5)
        # 1 of 5 stale → below the ratio → really deleted.
        assert push.common._deactivate_stale_channels(chans[:1], 5, platform="fcm") == 1
        assert models.Channel.objects.filter(type=ChannelTypes.PUSH).count() == 4

    def test_mass_stale_is_refused(self):
        chans = self._android_channels(5)
        # All 5 reported stale at once → looks systemic → refuse to delete any.
        assert push.common._deactivate_stale_channels(chans, 5, platform="fcm") == 0
        assert models.Channel.objects.filter(type=ChannelTypes.PUSH).count() == 5

    def test_rolling_window_caps_one_off_deletions(self, settings):
        """The per-notification path deletes one device at a time (no batch to
        ratio-check), so a rolling per-platform window stops a runaway fault from
        wiping a fleet one delete at a time."""
        from django.core.cache import cache

        cache.clear()
        deleted = 0
        with mock.patch.object(push.common, "STALE_DELETE_WINDOW_LIMIT", 3):
            # Each call passes the ratio guard (1 of 1) but counts toward the
            # rolling window; once the cap is hit, further deletes are refused.
            for _ in range(5):
                (ch,) = self._android_channels(1)
                deleted += push.common._deactivate_stale_channels(
                    [ch], 1, platform="fcm"
                )
        assert deleted == 3


# ---------------------------------------------------------------------------
# VAPID public-key derivation (offline, via the management command)
# ---------------------------------------------------------------------------


def _generate_vapid_keypair():
    """Return ``(private_pem, expected_public_b64url)`` for a fresh P-256 key."""
    import base64

    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import ec

    key = ec.generate_private_key(ec.SECP256R1())
    pem = key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    ).decode()
    raw = key.public_key().public_bytes(
        serialization.Encoding.X962,
        serialization.PublicFormat.UncompressedPoint,
    )
    expected = base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")
    return pem, expected


class TestDeriveVapidPublicKey:
    def test_derives_the_matching_public_key(self):
        pem, expected = _generate_vapid_keypair()
        assert push.derive_vapid_public_key(pem) == expected

    def test_returns_none_on_invalid_pem(self):
        assert push.derive_vapid_public_key("not-a-key") is None


class TestDeriveVapidPublicKeyCommand:
    def test_prints_key_from_settings(self, settings):
        from io import StringIO

        from django.core.management import call_command

        pem, expected = _generate_vapid_keypair()
        settings.PUSH_VAPID_PRIVATE_KEY = pem
        out = StringIO()
        call_command("derive_vapid_public_key", stdout=out, stderr=StringIO())
        assert out.getvalue().strip() == expected

    def test_private_key_argument_overrides_settings(self, settings):
        from io import StringIO

        from django.core.management import call_command

        pem, expected = _generate_vapid_keypair()
        settings.PUSH_VAPID_PRIVATE_KEY = None
        out = StringIO()
        call_command(
            "derive_vapid_public_key",
            "--private-key",
            pem,
            stdout=out,
            stderr=StringIO(),
        )
        assert out.getvalue().strip() == expected

    def test_errors_without_a_private_key(self, settings):
        from django.core.management import call_command
        from django.core.management.base import CommandError

        settings.PUSH_VAPID_PRIVATE_KEY = None
        with pytest.raises(CommandError):
            call_command("derive_vapid_public_key")

    def test_verify_passes_on_matching_pair(self, settings):
        from io import StringIO

        from django.core.management import call_command

        pem, expected = _generate_vapid_keypair()
        settings.PUSH_VAPID_PRIVATE_KEY = pem
        settings.PUSH_VAPID_PUBLIC_KEY = expected
        out = StringIO()
        call_command("derive_vapid_public_key", "--verify", stdout=out)
        assert "matches" in out.getvalue()

    def test_verify_fails_on_mismatch(self, settings):
        from django.core.management import call_command
        from django.core.management.base import CommandError

        pem, _expected = _generate_vapid_keypair()
        settings.PUSH_VAPID_PRIVATE_KEY = pem
        settings.PUSH_VAPID_PUBLIC_KEY = "wrong-key"
        with pytest.raises(CommandError, match="does NOT match"):
            call_command("derive_vapid_public_key", "--verify")

    def test_verify_fails_when_public_key_unset(self, settings):
        from django.core.management import call_command
        from django.core.management.base import CommandError

        pem, _expected = _generate_vapid_keypair()
        settings.PUSH_VAPID_PRIVATE_KEY = pem
        settings.PUSH_VAPID_PUBLIC_KEY = None
        with pytest.raises(CommandError, match="not set"):
            call_command("derive_vapid_public_key", "--verify")
