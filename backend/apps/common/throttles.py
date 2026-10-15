"""Scoped throttles for sensitive endpoints. Rates live in REST_FRAMEWORK["DEFAULT_THROTTLE_RATES"]."""

from rest_framework.throttling import SimpleRateThrottle


class _IdentThrottle(SimpleRateThrottle):
    def get_cache_key(self, request, view):
        ident = request.user.pk if request.user and request.user.is_authenticated else self.get_ident(request)
        return self.cache_format % {"scope": self.scope, "ident": ident}


class AuthThrottle(_IdentThrottle):
    scope = "auth"


class LoginEmailThrottle(SimpleRateThrottle):
    """Per-account limit on login attempts, independent of the client IP."""

    scope = "auth"

    def get_cache_key(self, request, view):
        email = str(request.data.get("email", "")).strip().lower() if hasattr(request, "data") else ""
        if not email:
            return None
        return self.cache_format % {"scope": "auth_email", "ident": email}


class PasswordResetThrottle(_IdentThrottle):
    scope = "password_reset"


class InvitationThrottle(_IdentThrottle):
    scope = "invitations"


class InviteTokenThrottle(_IdentThrottle):
    scope = "invite_token"


class UploadThrottle(_IdentThrottle):
    scope = "uploads"


class ImportThrottle(_IdentThrottle):
    """Board 40: import job creation per user (THROTTLE_IMPORTS, 20/hour)."""

    scope = "imports"


class StreamThrottle(_IdentThrottle):
    """Board 33: realtime stream connects per user (THROTTLE_STREAM, 30/min)."""

    scope = "stream"


class PresenceThrottle(_IdentThrottle):
    """Board 33: presence heartbeats per user (THROTTLE_PRESENCE, 240/min)."""

    scope = "presence"


class WebhookThrottle(SimpleRateThrottle):
    """Board 37: webhook receivers, per source IP (THROTTLE_WEBHOOK, 1200/min). Never the `anon` throttle."""

    scope = "webhook"

    def get_cache_key(self, request, view):
        return self.cache_format % {"scope": self.scope, "ident": self.get_ident(request)}


class IntegrationConnectThrottle(_IdentThrottle):
    """Board 37: connect / reconnect starts per user (THROTTLE_INTEGRATION_CONNECT, 10/hour)."""

    scope = "integration_connect"


class DevBranchThrottle(_IdentThrottle):
    """Board 37: branch creation per user (THROTTLE_DEV_BRANCH, 30/hour)."""

    scope = "dev_branch"


class DevLinkThrottle(_IdentThrottle):
    """Board 37: manual links per user (THROTTLE_DEV_LINK, 60/hour)."""

    scope = "dev_link"
