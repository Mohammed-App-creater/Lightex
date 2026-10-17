from django.urls import path

from . import views

urlpatterns = [
    path("auth/register", views.RegisterView.as_view(), name="auth-register"),
    path("auth/login", views.LoginView.as_view(), name="auth-login"),
    path("auth/refresh", views.RefreshView.as_view(), name="auth-refresh"),
    path("auth/logout", views.LogoutView.as_view(), name="auth-logout"),
    path("auth/forgot-password", views.ForgotPasswordView.as_view(), name="auth-forgot-password"),
    path("auth/reset-password", views.ResetPasswordView.as_view(), name="auth-reset-password"),
    path("auth/google/start", views.GoogleStartView.as_view(), name="auth-google-start"),
    path("auth/google/callback", views.GoogleCallbackView.as_view(), name="auth-google-callback"),
    path("auth/me", views.MeView.as_view(), name="auth-me"),
    path("auth/me/password", views.ChangePasswordView.as_view(), name="auth-change-password"),
]
