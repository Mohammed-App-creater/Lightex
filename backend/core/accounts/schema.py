"""OpenAPI: the access token is a bearer JWT (`Authorization: Bearer <access>`); the refresh token is an HttpOnly
cookie handled by the auth endpoints, so it is not a security scheme."""

from drf_spectacular.extensions import OpenApiAuthenticationExtension


class BearerJWTScheme(OpenApiAuthenticationExtension):
    target_class = "core.accounts.authentication.BearerJWTAuthentication"
    name = "bearerAuth"

    def get_security_definition(self, auto_schema):
        return {"type": "http", "scheme": "bearer", "bearerFormat": "JWT"}
