from django.db import transaction
from drf_spectacular.utils import extend_schema
from rest_framework import status
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.common.params import body
from apps.common.throttles import AuthThrottle, LoginEmailThrottle, PasswordResetThrottle

from . import services
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
