from rest_framework_simplejwt.authentication import JWTAuthentication


class BearerJWTAuthentication(JWTAuthentication):
    """`Authorization: Bearer <access>`; inactive users are rejected by SimpleJWT's user lookup."""

    www_authenticate_realm = "api"
