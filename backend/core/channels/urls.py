from django.urls import path

from . import views

urlpatterns = [
    path("me/notification-channels", views.ChannelsView.as_view(), name="me-channels"),
    path("me/notification-channels/telegram/link", views.TelegramLinkView.as_view(), name="me-telegram-link"),
    path(
        "me/notification-channels/telegram/link/<uuid:link_id>",
        views.TelegramLinkDetailView.as_view(),
        name="me-telegram-link-detail",
    ),
    path("me/notification-channels/telegram", views.TelegramDisconnectView.as_view(), name="me-telegram"),
    path(
        "me/notification-channels/sms/verifications",
        views.SmsVerificationsView.as_view(),
        name="me-sms-verifications",
    ),
    path(
        "me/notification-channels/sms/verifications/<uuid:verification_id>/resend",
        views.SmsResendView.as_view(),
        name="me-sms-resend",
    ),
    path(
        "me/notification-channels/sms/verifications/<uuid:verification_id>/verify",
        views.SmsVerifyView.as_view(),
        name="me-sms-verify",
    ),
    path("me/notification-channels/sms", views.SmsDisconnectView.as_view(), name="me-sms"),
    path("me/notification-channels/<str:channel>/test", views.ChannelTestView.as_view(), name="me-channel-test"),
    path("push/vapid-public-key", views.VapidKeyView.as_view(), name="push-vapid-key"),
    path("me/push-subscriptions", views.PushSubscriptionsView.as_view(), name="me-push-subscriptions"),
    path("me/push-subscriptions/remove", views.PushRemoveView.as_view(), name="me-push-remove"),
    path("me/push-subscriptions/<uuid:device_id>", views.PushDeviceView.as_view(), name="me-push-device"),
    path("webhooks/telegram", views.TelegramWebhookView.as_view(), name="webhook-telegram"),
    path("webhooks/twilio/sms", views.TwilioInboundView.as_view(), name="webhook-twilio-sms"),
    path("webhooks/twilio/status", views.TwilioStatusView.as_view(), name="webhook-twilio-status"),
]
