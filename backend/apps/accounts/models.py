from django.contrib.auth.models import AbstractBaseUser, BaseUserManager, PermissionsMixin
from django.db import models
from django.db.models.functions import Lower

from apps.common.models import BaseModel
from apps.common.utils import random_hue


class UserManager(BaseUserManager["User"]):
    use_in_migrations = True

    def create_user(self, email: str, password: str | None = None, **extra):
        if not email:
            raise ValueError("Email is required")
        user = self.model(email=self.normalize_email(email).strip().lower(), **extra)
        user.set_password(password)
        user.save(using=self._db)
        return user

    def create_superuser(self, email: str, password: str | None = None, **extra):
        extra.setdefault("is_staff", True)
        extra.setdefault("is_superuser", True)
        extra.setdefault("name", "Admin")
        return self.create_user(email, password, **extra)

    def get_by_natural_key(self, username):
        return self.get(email__iexact=username)


class User(BaseModel, AbstractBaseUser, PermissionsMixin):
    email = models.EmailField(max_length=254, unique=True)  # always stored lower-cased
    name = models.CharField(max_length=60)
    hue = models.PositiveSmallIntegerField(default=random_hue)
    avatar_url = models.TextField(null=True, blank=True)
    is_active = models.BooleanField(default=True)
    is_staff = models.BooleanField(default=False)

    objects = UserManager()

    USERNAME_FIELD = "email"
    EMAIL_FIELD = "email"
    REQUIRED_FIELDS = ["name"]

    class Meta:
        constraints = [models.UniqueConstraint(Lower("email"), name="user_email_ci_unique")]

    def __str__(self) -> str:
        return self.email


class PasswordResetToken(BaseModel):
    """Single-use reset token. Only the SHA-256 hash is stored."""

    user = models.ForeignKey(User, on_delete=models.CASCADE, related_name="reset_tokens")
    token_hash = models.CharField(max_length=64, unique=True)
    expires_at = models.DateTimeField()
    used_at = models.DateTimeField(null=True, blank=True)
