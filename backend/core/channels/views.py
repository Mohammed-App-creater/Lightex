"""Board 38 endpoints C1–C14 and webhooks H1–H3 (docs/v2/38-telegram-sms-push.md §5)."""

from __future__ import annotations

import datetime as dt
import json

from django.conf import settings
from django.http import HttpResponse
from django.utils import timezone
from drf_spectacular.utils import OpenApiParameter, extend_schema, inline_serializer
from rest_framework import serializers, status
from rest_framework.parsers import FormParser, JSONParser
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.response import Response
from rest_framework.throttling import SimpleRateThrottle
from rest_framework.views import APIView

from core.common.params import body
from core.common.throttles import WebhookThrottle

from . import services, webhooks
from .providers import available

TAGS = ["notification-channels"]
HOOK_TAGS = ["webhooks"]


class _ScopedThrottle(SimpleRateThrottle):
    reason = ""

    def get_cache_key(self, request, view):
        return self.cache_format % {"scope": self.scope, "ident": request.user.pk}


class ChannelConnectThrottle(_ScopedThrottle):
    scope = "channel_connect"
    reason = "connect_limit"


class ChannelTestThrottle(_ScopedThrottle):
    scope = "channel_test"
    reason = "test_limit"


def check_throttle(request, view, cls: type[_ScopedThrottle]) -> None:
    """DRF scope throttles, answered in the board's 429 shape (`throttled`, `retryAt`, `reason`)."""
    throttle = cls()
    if not throttle.allow_request(request, view):
        wait = throttle.wait() or 1
        raise services.throttled(
            "Too many requests. Try again later.", timezone.now() + dt.timedelta(seconds=wait), cls.reason
        )


def _ip(request) -> str | None:
    return request.META.get("REMOTE_ADDR") or None


TelegramConnectionOut = inline_serializer(
    "TelegramConnection",
    {
        "id": serializers.UUIDField(),
        "username": serializers.CharField(allow_null=True),
        "firstName": serializers.CharField(),
        "status": serializers.ChoiceField(choices=["active", "blocked"]),
        "connectedAt": serializers.DateTimeField(),
        "lastError": serializers.CharField(allow_null=True),
    },
)
SmsConnectionOut = inline_serializer(
    "SmsConnection",
    {
        "id": serializers.UUIDField(),
        "phoneNumber": serializers.CharField(),
        "display": serializers.CharField(),
        "country": serializers.CharField(),
        "status": serializers.ChoiceField(choices=["active", "opted_out", "invalid"]),
        "verifiedAt": serializers.DateTimeField(),
        "lastError": serializers.CharField(allow_null=True),
    },
)
PushDeviceOut = inline_serializer(
    "PushDevice",
    {
        "id": serializers.UUIDField(),
        "label": serializers.CharField(),
        "endpointHash": serializers.CharField(),
        "status": serializers.ChoiceField(choices=["active", "expired"]),
        "createdAt": serializers.DateTimeField(),
        "lastSeenAt": serializers.DateTimeField(),
        "lastSuccessAt": serializers.DateTimeField(allow_null=True),
    },
)
SmsCountryOut = inline_serializer(
    "SmsCountry",
    {
        "code": serializers.CharField(),
        "dial": serializers.CharField(),
        "label": serializers.CharField(),
        "digits": serializers.IntegerField(),
        "pattern": serializers.CharField(),
    },
)
ChannelsOut = inline_serializer(
    "NotificationChannels",
    {
        "email": inline_serializer("EmailChannel", {"address": serializers.EmailField()}),
        "telegram": inline_serializer(
            "TelegramChannel",
            {
                "available": serializers.BooleanField(),
                "botUsername": serializers.CharField(allow_null=True),
                "connection": TelegramConnectionOut,
            },
        ),
        "sms": inline_serializer(
            "SmsChannel",
            {
                "available": serializers.BooleanField(),
                "countries": SmsCountryOut,
                "connection": SmsConnectionOut,
                "dailyCap": serializers.IntegerField(),
                "sentToday": serializers.IntegerField(),
            },
        ),
        "push": inline_serializer(
            "PushChannel",
            {
                "available": serializers.BooleanField(),
                "vapidPublicKey": serializers.CharField(allow_null=True),
                "devices": PushDeviceOut,
            },
        ),
    },
)
TelegramLinkOut = inline_serializer(
    "TelegramLink",
    {
        "id": serializers.UUIDField(),
        "status": serializers.ChoiceField(choices=["pending", "linked", "expired", "canceled"]),
        "code": serializers.CharField(required=False),
        "deepLink": serializers.URLField(required=False),
        "botUsername": serializers.CharField(),
        "expiresAt": serializers.DateTimeField(),
        "connection": TelegramConnectionOut,
    },
)
TimezoneIn = inline_serializer("ChannelConnectIn", {"timezone": serializers.CharField(required=False)})
SmsStartIn = inline_serializer(
    "SmsVerificationIn",
    {
        "country": serializers.CharField(),
        "nationalNumber": serializers.CharField(),
        "timezone": serializers.CharField(required=False),
    },
)
SmsVerificationOut = inline_serializer(
    "SmsVerification",
    {
        "id": serializers.UUIDField(),
        "phoneNumber": serializers.CharField(),
        "display": serializers.CharField(),
        "expiresAt": serializers.DateTimeField(),
        "resendAt": serializers.DateTimeField(),
        "attemptsLeft": serializers.IntegerField(),
    },
)
PushSubscriptionIn = inline_serializer(
    "PushSubscriptionInput",
    {
        "mode": serializers.ChoiceField(choices=["subscribe", "refresh"]),
        "subscription": serializers.JSONField(),
        "timezone": serializers.CharField(required=False),
    },
)
TestOut = inline_serializer(
    "ChannelTestResult",
    {
        "channel": serializers.ChoiceField(choices=["email", "telegram", "sms", "push"]),
        "status": serializers.ChoiceField(choices=["sent"]),
        "deliveryId": serializers.UUIDField(),
        "sentAt": serializers.DateTimeField(),
    },
)


class ChannelsView(APIView):
    """C1."""

    permission_classes = [IsAuthenticated]

    @extend_schema(tags=TAGS, responses={200: ChannelsOut})
    def get(self, request):
        return Response(services.overview(request.user))


class TelegramLinkView(APIView):
    """C2."""

    permission_classes = [IsAuthenticated]

    @extend_schema(tags=TAGS, request=TimezoneIn, responses={201: TelegramLinkOut})
    def post(self, request):
        if not available("telegram"):
            raise services.unavailable("telegram")
        check_throttle(request, self, ChannelConnectThrottle)
        return Response(services.create_link(request.user, body(request).get("timezone")), status=201)


class TelegramLinkDetailView(APIView):
    """C3, C4."""

    permission_classes = [IsAuthenticated]

    @extend_schema(tags=TAGS, responses={200: TelegramLinkOut})
    def get(self, request, link_id):
        return Response(services.link_data(services.my_link(request.user, link_id)))

    @extend_schema(tags=TAGS, responses={204: None})
    def delete(self, request, link_id):
        services.cancel_link(request.user, link_id)
        return Response(status=status.HTTP_204_NO_CONTENT)


class TelegramDisconnectView(APIView):
    """C5."""

    permission_classes = [IsAuthenticated]

    @extend_schema(tags=TAGS, responses={204: None})
    def delete(self, request):
        services.disconnect_telegram(request.user)
        return Response(status=status.HTTP_204_NO_CONTENT)


class SmsVerificationsView(APIView):
    """C6."""

    permission_classes = [IsAuthenticated]

    @extend_schema(tags=TAGS, request=SmsStartIn, responses={201: SmsVerificationOut})
    def post(self, request):
        if not available("sms"):
            raise services.unavailable("sms")
        check_throttle(request, self, ChannelConnectThrottle)
        return Response(services.start_verification(request.user, body(request), _ip(request)), status=201)


class SmsResendView(APIView):
    """C7."""

    permission_classes = [IsAuthenticated]

    @extend_schema(tags=TAGS, request=None, responses={200: SmsVerificationOut})
    def post(self, request, verification_id):
        return Response(services.resend(request.user, verification_id, _ip(request)))


class SmsVerifyView(APIView):
    """C8."""

    permission_classes = [IsAuthenticated]

    @extend_schema(
        tags=TAGS,
        request=inline_serializer("SmsVerifyIn", {"code": serializers.CharField()}),
        responses={200: inline_serializer("SmsVerifyOut", {"connection": SmsConnectionOut})},
    )
    def post(self, request, verification_id):
        return Response(services.verify(request.user, verification_id, body(request).get("code")))


class SmsDisconnectView(APIView):
    """C9."""

    permission_classes = [IsAuthenticated]

    @extend_schema(tags=TAGS, responses={204: None})
    def delete(self, request):
        services.remove_sms(request.user)
        return Response(status=status.HTTP_204_NO_CONTENT)


class VapidKeyView(APIView):
    """C10 (public)."""

    authentication_classes: list = []
    permission_classes = [AllowAny]

    @extend_schema(tags=TAGS, responses={200: inline_serializer("VapidKey", {"publicKey": serializers.CharField()})})
    def get(self, request):
        if not available("push") or not settings.VAPID_PUBLIC_KEY:
            raise services.unavailable("push")
        response = Response({"publicKey": settings.VAPID_PUBLIC_KEY})
        response["Cache-Control"] = "public, max-age=3600"
        return response


class PushSubscriptionsView(APIView):
    """C11."""

    permission_classes = [IsAuthenticated]

    @extend_schema(tags=TAGS, request=PushSubscriptionIn, responses={200: PushDeviceOut, 201: PushDeviceOut})
    def put(self, request):
        device, created = services.subscribe(request.user, body(request), request.META.get("HTTP_USER_AGENT", ""))
        return Response(device, status=201 if created else 200)


class PushRemoveView(APIView):
    """C12."""

    permission_classes = [IsAuthenticated]

    @extend_schema(
        tags=TAGS,
        request=inline_serializer("PushRemoveIn", {"endpoint": serializers.CharField()}),
        responses={204: None},
    )
    def post(self, request):
        services.remove_push_endpoint(request.user, body(request).get("endpoint"))
        return Response(status=status.HTTP_204_NO_CONTENT)


class PushDeviceView(APIView):
    """C13."""

    permission_classes = [IsAuthenticated]

    @extend_schema(tags=TAGS, responses={204: None})
    def delete(self, request, device_id):
        services.remove_push_device(request.user, device_id)
        return Response(status=status.HTTP_204_NO_CONTENT)


class ChannelTestView(APIView):
    """C14."""

    permission_classes = [IsAuthenticated]

    @extend_schema(
        tags=TAGS,
        parameters=[OpenApiParameter("workspace", str)],
        request=inline_serializer("ChannelTestIn", {"deviceId": serializers.UUIDField(required=False)}),
        responses={200: TestOut},
    )
    def post(self, request, channel):
        if channel not in ("email", "telegram", "sms", "push"):
            raise services.not_found("Unknown channel.")
        check_throttle(request, self, ChannelTestThrottle)
        return Response(services.send_test(request.user, channel, body(request), request.query_params.get("workspace")))


# ───────────────────────── webhooks ─────────────────────────


class _WebhookView(APIView):
    authentication_classes: list = []
    permission_classes = [AllowAny]
    throttle_classes = [WebhookThrottle]


@extend_schema(tags=HOOK_TAGS, request=None, responses={200: None, 401: None})
class TelegramWebhookView(_WebhookView):
    """H1: X-Telegram-Bot-Api-Secret-Token; the reply rides in the response body."""

    def post(self, request):
        if not webhooks.telegram_secret_ok(request.headers.get("X-Telegram-Bot-Api-Secret-Token")):
            webhooks.logger.warning("telegram webhook secret failed ip=%s", _ip(request))
            return HttpResponse(status=401)
        raw = request.META.get("CONTENT_LENGTH") or "0"
        if not raw.isdigit() or int(raw) > 64 * 1024:
            return HttpResponse(status=413)
        try:
            update = json.loads(request.read(int(raw)) or b"{}")
        except ValueError:
            update = {}
        reply = webhooks.handle_update(update) if isinstance(update, dict) else {}
        return HttpResponse(json.dumps(reply), content_type="application/json")


class _TwilioView(_WebhookView):
    parser_classes = [FormParser, JSONParser]

    def verified(self, request) -> dict[str, str] | None:
        params = {k: request.POST.get(k, "") for k in request.POST}
        if not webhooks.twilio_signature_ok(request.path, params, request.headers.get("X-Twilio-Signature")):
            webhooks.logger.warning("twilio webhook signature failed ip=%s", _ip(request))
            return None
        return params


@extend_schema(tags=HOOK_TAGS, request=None, responses={200: None, 403: None})
class TwilioInboundView(_TwilioView):
    """H2: inbound SMS (STOP / START)."""

    def post(self, request):
        params = self.verified(request)
        if params is None:
            return HttpResponse(status=403)
        webhooks.twilio_inbound(params)
        return HttpResponse(webhooks.TWIML, content_type="text/xml")


@extend_schema(tags=HOOK_TAGS, request=None, responses={204: None, 403: None})
class TwilioStatusView(_TwilioView):
    """H3: delivery status callbacks."""

    def post(self, request):
        params = self.verified(request)
        if params is None:
            return HttpResponse(status=403)
        webhooks.twilio_status(params)
        return HttpResponse(status=204)
