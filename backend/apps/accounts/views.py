import secrets
from urllib.parse import urlencode

from django.conf import settings
from django.db import transaction
from django.http import HttpResponseRedirect
from drf_spectacular.utils import extend_schema
from rest_framework import status
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.common.params import body
from apps.common.throttles import AuthThrottle, LoginEmailThrottle, PasswordResetThrottle

from . import google, services
from .cookies import check_origin, clear_refresh_cookie, read_refresh_cookie, set_refresh_cookie
from .serializers import (
    AccessOut,
    AuthOut,
    ChangePasswordIn,
    EmailIn,
    LoginIn,
    ProfileIn,
    RegisterIn,
    ResetIn,
    UserSerializer,
)


def session_response(user, *, status_code: int = 200, extra: dict | None = None) -> Response:
    access, refresh = services.issue_tokens(user)
    response = Response({"accessToken": access, "user": UserSerializer(user).data, **(extra or {})}, status=status_code)
    set_refresh_cookie(response, refresh)
    return response


class AnonymousView(APIView):
    authentication_classes: list = []
    permission_classes = [AllowAny]


@extend_schema(tags=["auth"], request=RegisterIn, responses={201: AuthOut})
class RegisterView(AnonymousView):
    throttle_classes = [AuthThrottle]

    def post(self, request):
        data = body(request)
        user = services.register(
            name=data.get("name", ""), email=data.get("email", ""), password=data.get("password", "")
        )
        return session_response(user, status_code=status.HTTP_201_CREATED)


@extend_schema(tags=["auth"], request=LoginIn, responses={200: AuthOut})
class LoginView(AnonymousView):
    throttle_classes = [AuthThrottle, LoginEmailThrottle]

    def post(self, request):
        data = body(request)
        user = services.authenticate(str(data.get("email", "")), str(data.get("password", "")))
        return session_response(user)


@extend_schema(tags=["auth"], request=None, responses={200: AccessOut})
class RefreshView(AnonymousView):
    def post(self, request):
        check_origin(request)
        access, _user = services.access_from_refresh(read_refresh_cookie(request))
        return Response({"accessToken": access})


@extend_schema(tags=["auth"], request=None, responses={204: None})
class LogoutView(AnonymousView):
    def post(self, request):
        check_origin(request)
        services.revoke_refresh(read_refresh_cookie(request))
        response = Response(status=status.HTTP_204_NO_CONTENT)
        clear_refresh_cookie(response)
        return response


@extend_schema(tags=["auth"], request=EmailIn, responses={204: None})
class ForgotPasswordView(AnonymousView):
    throttle_classes = [PasswordResetThrottle]

    def post(self, request):
        services.request_password_reset(str(body(request).get("email", "")))
        return Response(status=status.HTTP_204_NO_CONTENT)


@extend_schema(tags=["auth"], request=ResetIn, responses={204: None})
class ResetPasswordView(AnonymousView):
    throttle_classes = [PasswordResetThrottle]

    def post(self, request):
        data = body(request)
        services.reset_password(str(data.get("token", "")), str(data.get("password", "")))
        response = Response(status=status.HTTP_204_NO_CONTENT)
        clear_refresh_cookie(response)
        return response


def _to_client(path: str) -> HttpResponseRedirect:
    return HttpResponseRedirect(f"{settings.FRONTEND_URL}{path}")


def _google_failed(reason: str, next_path: str = "/") -> HttpResponseRedirect:
    query = {"error": reason} | ({"next": next_path} if next_path != "/" else {})
    response = _to_client(f"/login?{urlencode(query)}")
    response.delete_cookie(google.STATE_COOKIE, path=google.STATE_COOKIE_PATH, samesite="Lax")
    return response


@extend_schema(tags=["auth"], request=None, responses={302: None})
class GoogleStartView(AnonymousView):
    """Browser navigation (not fetch): redirects to Google's consent screen."""

    throttle_classes = [AuthThrottle]

    def get(self, request):
        next_path = google.safe_next(request.query_params.get("next"))
        if not google.configured():
            return _google_failed("google_unavailable", next_path)
        url, state = google.start(next_path)
        response = HttpResponseRedirect(url)
        # Lax is enough: Google returns with a top-level GET navigation.
        response.set_cookie(
            google.STATE_COOKIE,
            state,
            max_age=google.STATE_MAX_AGE,
            path=google.STATE_COOKIE_PATH,
            secure=settings.REFRESH_COOKIE_SECURE,
            httponly=True,
            samesite="Lax",
        )
        return response


@extend_schema(tags=["auth"], request=None, responses={302: None})
class GoogleCallbackView(AnonymousView):
    """Google redirects here. Sets the refresh cookie and returns to the client, which restores the session."""

    throttle_classes = [AuthThrottle]

    def get(self, request):
        saved = google.read_state(request.COOKIES.get(google.STATE_COOKIE))
        state = request.query_params.get("state", "")
        if saved is None or not state or not secrets.compare_digest(state, saved["s"]):
            return _google_failed("google")
        next_path = google.safe_next(saved.get("n"))
        code = request.query_params.get("code")
        if not code:  # the person cancelled on Google's screen, or Google reported an error
            return _google_failed("google_cancelled" if request.query_params.get("error") else "google", next_path)
        try:
            user = google.user_for_profile(google.fetch_profile(code))
        except google.GoogleSignInError:
            return _google_failed("google", next_path)
        _access, refresh = services.issue_tokens(user)
        response = _to_client(next_path)
        set_refresh_cookie(response, refresh)
        response.delete_cookie(google.STATE_COOKIE, path=google.STATE_COOKIE_PATH, samesite="Lax")
        return response


class MeView(APIView):
    permission_classes = [IsAuthenticated]

    @extend_schema(tags=["auth"], responses={200: UserSerializer})
    def get(self, request):
        return Response(UserSerializer(request.user).data)

    @extend_schema(tags=["auth"], request=ProfileIn, responses={200: UserSerializer})
    def patch(self, request):
        user = services.update_profile(request.user, body(request))
        return Response(UserSerializer(user).data)


@extend_schema(tags=["auth"], request=ChangePasswordIn, responses={204: None})
class ChangePasswordView(APIView):
    permission_classes = [IsAuthenticated]
    throttle_classes = [AuthThrottle]

    def put(self, request):
        data = body(request)
        with transaction.atomic():
            services.change_password(
                request.user, str(data.get("currentPassword", "")), str(data.get("newPassword", ""))
            )
        # Every other session was revoked; keep this one signed in with a fresh refresh token.
        _access, refresh = services.issue_tokens(request.user)
        response = Response(status=status.HTTP_204_NO_CONTENT)
        set_refresh_cookie(response, refresh)
        return response
