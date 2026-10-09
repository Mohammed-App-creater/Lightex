# v2 · Board 38: Telegram, SMS and push notification channels (API contract)

Status: **contract, not implemented.** The backend (Django + DRF + Celery, `backend/`) and the frontend (Next.js 16,
`frontend/`) are built from this document in parallel. Where this document is silent, the v1 conventions in
`docs/backend-plan.md`, `docs/backend-final-report.md`, `frontend/docs/api-contract.md` and `frontend/src/lib/api/*.ts`
apply unchanged, and so do the other v2 contracts: board 39 (`39-fields-dependencies-time.md`), 32
(`32-timeline-calendar.md`), 40 (`40-import-wizard.md`, which adds the `import` notification type) and 33
(`33-dashboards-presence.md`, which adds the SSE stream).

Design source: `frontend/design/clean/38-Telegram-SMS-push.html`. Its frames are: Matrix with all channels, Telegram
connect, SMS verify, Push permission prompt, Push blocked, Quiet hours, Mobile (390), Send test notification, Loading
and Error (wrong code). Its fixtures are 6 events × 5 channels, the Telegram code `K7MQ2X` with a 10-minute expiry, the
SMS code `482913` with 3 tries and a 30 s resend, the countries US/UK/DE/IN, and quiet hours 22:00–08:00.

Precedence is unchanged: **docs and existing conventions win for behaviour, the design wins for appearance.** §10
lists every conflict and how it is resolved.

Contents: 0 Wire conventions · 1 Scope · 2 Providers and configuration · 3 Data model · 4 Permissions · 5 Endpoints ·
6 Dispatch · 7 Security and privacy · 8 Frontend · 9 Test plan · 10 Conflicts · 11 Open questions · 12 Delivery
checklist.

**Summary of the change.**

- **New backend app `apps/channels`.** It has six models: `TelegramLinkRequest`, `TelegramConnection`,
  `SmsVerification`, `SmsConnection`, `PushSubscription` and `ChannelDelivery`. The last is the delivery log, which
  also holds retries and the dead letter.
- **Three provider interfaces,** each with a real backend and a console/fake backend chosen in settings: Telegram Bot
  API through a **webhook**, Twilio Programmable Messaging, and Web Push with VAPID.
- **Endpoints:** 14 personal endpoints under `/me/…`, one public VAPID key endpoint and three webhooks.
- **Extended preferences:** `GET/PUT /notification-preferences` gains the `telegram`, `sms` and `push` keys and a
  `quietHours` object.
- **One workspace policy field,** `notificationPolicy.sms`, editable with `workspace.update`.
- **Fan-out:** the existing outbox handler (`notifications.handlers.deliver`) fans out to the new channels.
- **Delivery without Redis:** a per-process sender pool with an event-driven sweeper.
- **Two new Python dependencies,** `cryptography` and `http-ece`, instead of `pywebpush` (§2.4). **One new npm
  dependency**, `uqr`, which draws the QR code (§8.10).
- **Frontend:** `public/sw.js`, a header rule for it in `next.config.ts`, and the "Coming soon" columns removed.

---

## 0. Wire conventions (unchanged, restated so nobody guesses)

- Base `/api/v1`. JSON. camelCase fields. The only snake_case keys are `my_permissions` and, **as in v1**, the
  event and channel keys inside `NotificationPreferences.events` (`in_app`, `due_soon`, …). They are data keys, not
  field names.
- Timestamps are ISO-8601 UTC (`ISODateTime`). Wall-clock times are `HH:MM` 24 h strings. Time zones are IANA names
  (`America/New_York`). Phone numbers on the wire are E.164 (`+14155550132`).
- Errors: `{ "code": string, "message": string, "details": object }`. Validation is **422** `validation_failed`
  with `details.fields`; nested paths are dotted (`quietHours.from`). Throttling is **429** `throttled`, with a
  `Retry-After` header and `details.retryAt`.
- Create → **201**; update → **200**; delete → **204**; accepted for later → **202**.
- Every `/me/…` route requires authentication and only ever touches the caller's own rows. Another user's id gives
  **404** `not_found`, never 403. Webhooks are unauthenticated and verified by signature (§7.3).
- IDs are UUIDs on the backend and opaque strings in the mock (`tgl_4k2m`). Clients never parse ids.

---

## 1. Scope

### 1.1 What board 38 shows

The board 38 design replaces the v1 notification settings page (`/[ws]/settings/notifications`, settings nav
"Account → Notifications"). The page has three sections:

| Section | Content |
|---|---|
| **Channels** | One list row per channel: icon, name, a status line (✓ green / dashed dot / spinner / ⚠ red) and actions (Send test, Connect / Enable, Check again, × Disconnect). Admins also see a footer row: shield icon, "SMS for Platform team", the `admin` tag and a switch. |
| **Preferences** | Matrix of 6 events × 5 channels: In-app, Email, Telegram, SMS, Push (short labels at 390: App, Mail, TG, SMS, Push). A channel that isn't connected has a hatched column with dashed "off" toggles, and its header shows a **Connect** link, **Off by admin** or **Blocked**. |
| **Quiet hours** | A card with a moon icon, "Quiet hours", a summary in mono (`22:00–08:00 · Mon–Fri · New York`) and a switch. When on it opens From/To time inputs, a Timezone select, a 24 h bar with the window hatched (split in two when it runs overnight), day toggles Mo–Su and **Urgent still notifies** (with the 4-bar Urgent priority glyph). |

The connect flows are dialogs (modal on the page):

| Flow | States (design) |
|---|---|
| **Telegram** | QR code (`t.me` deep link) with "Scan with Telegram" · "or send to **@lightex_bot**" · a 6-character code `K7M Q2X`-style with a gap after 3, and a copy button · "Waiting for confirmation…" with a countdown (`9:42`, warn tone at ≤ 1:00) · **Code expired** (QR blurred with an "Expired" overlay, struck-through code, **New code**) · **Connected as @alexkim** with a spark check, then Send test / Done. |
| **SMS** | Country select (US +1, UK +44, DE +49, IN +91) + national number with an input mask, help text `10 digits` / `Valid number` / error `Enter 10 digits` · **Send code** · "Code sent to +1 (415) 555-0132 · Edit" · 6 OTP boxes (paste, auto-advance, ⌫ back, ← →, `autocomplete="one-time-code"` on the first) · "Verifying…" · `Wrong code · 2 tries left` (shake) · `Too many tries · resend a code` · "Resend in 0:24" → **Resend code** · **+1 (415) 555-0132 verified**, then Send test / Done. |
| **Push** | Card "Browser push" with a badge Off / On / Blocked · "Alerts on this device, even with the tab closed." · **Enable** → "Waiting for browser…" (the browser's own permission prompt) → On: "On in this browser · Chrome on macOS", Send test / Turn off · Blocked: "Unblock: lock icon in the address bar › Notifications › Allow." and **Check again**. |
| **Send test** | Toast "Test sent · Telegram" plus a device-style preview card at the top right (app name, sender, "now", title, body). |

Other states: a skeleton (channel rows plus matrix rows), "Saving" / "Saved" in the header, and an Escape key that
closes a dialog first.

### 1.2 Decisions on scope

| Item | Decision |
|---|---|
| Telegram, SMS, Web Push sending | **Real.** All three ship behind provider interfaces, each with a console/fake backend (§2). |
| Telegram "quick replies" (the design's "Alerts and quick replies", preview "· reply to comment") | **Not in this release.** The bot answers any free text with "Replies aren't supported yet. Open the task in Lightex." and a link. A Telegram account that could post comments as a Lightex user is an account-takeover risk that needs its own design (§11 #3). The dialog copy changes (§10 #1). |
| Digests for the new channels | **None as a setting** (the design has none). The only batching is the quiet-hours summary (§6.6). The v1 email "Email delivery: Instant / Hourly / Daily" control stays below the matrix (§10 #4). |
| Events | Exactly the 6 matrix rows: `assigned`, `mentioned`, `status_change`, `comment`, `due_soon`, `sprint_started`. `access` (v1), `import` (board 40) and the email-only `sprint_completed` **never** go to Telegram, SMS or Push in this release. |
| Workspace admin control | **Yes, for SMS only**: `notificationPolicy.sms` per workspace (the design's "SMS for Platform team" switch, §4.2). Everything else is personal. |
| SSE (board 33) | Optional. When board 33's stream exists, the server also publishes a user-targeted durable `channels.changed` event (§8.7). Polling is the baseline. |

### 1.3 Surfaces and who sees what

| Surface | Who | Notes |
|---|---|---|
| Channels list, matrix, quiet hours, connect dialogs, Send test | every signed-in user, for themselves | personal settings, not gated by any permission |
| SMS policy row ("SMS for {workspace}" + switch) | holders of `workspace.update` in the current workspace | Everyone else sees nothing, or "Off by admin" when it is off. A disabled switch is never shown: no permission means no row. |
| "Off by admin" (SMS row status, SMS column header) | everyone in a workspace whose policy is off | uses the workspace response field `notificationPolicy.sms` (§5.13) |

---

## 2. Providers and configuration

### 2.1 Provider interfaces

`apps/channels/providers/` holds one interface per channel. The backend is picked by a setting, and resolved once per
process (`get_telegram()`, `get_sms()`, `get_push()`):

```python
class TelegramProvider(Protocol):
    def send_message(self, chat_id: int, text_html: str, *, button: tuple[str, str] | None) -> SendResult: ...
    def set_webhook(self, url: str, secret: str) -> None: ...
    def get_me(self) -> dict: ...

class SmsProvider(Protocol):
    def send(self, to_e164: str, body: str, *, status_callback: str | None) -> SendResult: ...

class PushProvider(Protocol):
    def send(self, sub: PushTarget, payload: bytes, *, ttl: int, urgency: str, topic: str | None) -> SendResult: ...

@dataclass
class SendResult:
    ok: bool
    provider_id: str = ""          # Telegram message_id, Twilio MessageSid, push Location header
    retry_after: int | None = None # seconds, from 429 / Retry-After
    permanent: bool = False        # don't retry
    reason: str = ""               # normalised: blocked | opted_out | invalid_number | expired_subscription |
                                   # rate_limited | provider_error | config_error | timeout
    code: str = ""                 # raw provider code ("403", "21610", "410")
```

The real backends **never raise for HTTP outcomes.** They map every response to a `SendResult` (tables in §6.8). They
raise only for programming errors.

| Setting | Values | Default (base / dev / test / prod) |
|---|---|---|
| `TELEGRAM_BACKEND` | `bot` · `console` · `fake` · `disabled` | `disabled` / `console` / `fake` / `disabled` unless `TELEGRAM_BOT_TOKEN` is set, then `bot` |
| `SMS_BACKEND` | `twilio` · `console` · `fake` · `disabled` | `disabled` / `console` / `fake` / `disabled` unless `TWILIO_ACCOUNT_SID` is set, then `twilio` |
| `WEB_PUSH_BACKEND` | `webpush` · `console` · `fake` · `disabled` | `disabled` / `webpush` if VAPID keys are set, else `console` / `fake` / `webpush` if VAPID keys are set, else `disabled` |

- **`console`** writes the rendered message to the `lightex.channels` logger at INFO (`[telegram → chat 1234] …`) and
  returns `ok=True`. For SMS it also logs the OTP, because dev needs it. Settings refuse to start with
  `SMS_BACKEND=console` under `config.settings.prod` (an `ImproperlyConfigured` check), so production can never log a
  code.
- **`fake`** (tests) records every call in `fake.outbox` and can be scripted: `fake.fail_next(reason="blocked",
  permanent=True)` or `fake.fail_next(retry_after=5)`. Telegram's fake also simulates an incoming update for webhook
  tests (`fake_update(text="/start lx_…", chat_id=…)`).
- **`disabled`:** the channel reports `available: false` in `GET /me/notification-channels`, connect and test answer
  503 `channel_unavailable`, and the dispatcher skips the channel (`skip_reason = "unavailable"`). The frontend shows
  the row as "Not available on this server", with no actions (§8.3).

HTTP is the **standard library** (`urllib.request`, timeout `CHANNEL_HTTP_TIMEOUT` = 10 s), the same pattern as
`apps/accounts/google.py`. `requests` is not added.

### 2.2 Telegram Bot API: webhook, not long polling

- **Production uses the webhook.** The API runs on Render, where a long-polling loop would need a separate always-on
  worker, and the free plan has none. A webhook costs nothing while idle and also **wakes** a spun-down free instance.
  Telegram retries webhook deliveries that fail or time out, so a cold start delays an update; it doesn't lose it.
- **Setting the webhook up:** `python manage.py telegram_setup` (run once per deploy; it is idempotent) does three
  things:
  - `getMe` (checks the token and that `TELEGRAM_BOT_USERNAME` matches);
  - `setWebhook` with `url = {API_PUBLIC_URL}/api/v1/webhooks/telegram`, `secret_token = TELEGRAM_WEBHOOK_SECRET`,
    `allowed_updates = ["message", "my_chat_member"]` and `max_connections = 10`;
  - `setMyCommands` for `/start`, `/stop`, `/status` and `/help`.

  `--delete` removes the webhook. `--info` prints `getWebhookInfo` (pending count, last error).
- **Local development with a real bot:** `python manage.py telegram_poll` deletes the webhook and runs a `getUpdates`
  long-poll loop (timeout 30 s) that feeds the **same** update handler as the webhook. It is a dev tool only. Run
  `telegram_setup` again before going back to the webhook. Without a bot, dev uses `TELEGRAM_BACKEND=console` and the
  dev-only command `python manage.py telegram_fake_start <code>`, which simulates `/start <code>` from chat id
  `999000` (username `devbot_user`).
- **Messages** are `sendMessage` with `parse_mode: "HTML"`, `link_preview_options: {"is_disabled": true}`, and one
  inline URL button ("Open PRJ-42"). Telegram rejects button URLs that aren't public `https`. When `FRONTEND_URL` is
  not `https://` (local dev), the button is left out and the link goes into the text.
- **Replies to the webhook itself.** For the bot's answers to `/start`, `/stop`, `/status` and `/help`, the server
  puts the method call **in the webhook HTTP response** (`{"method": "sendMessage", "chat_id": …, "text": …}`), which
  Telegram supports. This means one fewer outbound call in the request path.

### 2.3 SMS: Twilio behind `SmsProvider`

- **Twilio Programmable Messaging** REST: `POST https://api.twilio.com/2010-04-01/Accounts/{SID}/Messages.json`
  (form-encoded; HTTP Basic `ACCOUNT_SID:AUTH_TOKEN`).
  - Fields: `To`, `MessagingServiceSid` (preferred) or `From`, `Body`, and `StatusCallback =
    {API_PUBLIC_URL}/api/v1/webhooks/twilio/status`.
  - The `twilio` SDK isn't used: the call is a single POST.
- **OTPs are ours,** not Twilio Verify. They are hashed, attempt-limited, and sent through the same provider (§7.2).
  Twilio Verify, with its fraud guard, is an alternative behind the same interface (§11 #1).
- **STOP handling** uses Twilio **Advanced Opt-Out** on the Messaging Service. It is on by default: Twilio replies to
  STOP/HELP/START itself and blocks later sends with error `21610`. Our inbound webhook records the opt-out so the UI
  can show it (§5.12).
- **Countries** come from an allow-list, `SMS_COUNTRIES` (default `US,GB,DE`), with a server-side table (§5.6) of the
  dial code, national digit count, display pattern and the design's label. **India (`IN`) is in the design but off by
  default:** Indian carriers require DLT entity and template registration before any SMS is delivered (§11 #2). The
  allow-list is also the main defence against SMS-pumping toll fraud (§7.5).

### 2.4 Web Push: VAPID, and why not `pywebpush`

- **Protocol.** RFC 8030 push, RFC 8291 message encryption (`aes128gcm`, RFC 8188) and RFC 8292 VAPID.
- **Push services.** Chrome/Edge use FCM and WNS, Firefox uses Mozilla autopush, Safari 16.4+ uses
  `web.push.apple.com`. None of them needs an account; the VAPID key pair identifies us.
- **Dependencies.** Add `cryptography` (pinned) and `http-ece` (pinned; a small RFC 8188 library that depends only on
  `cryptography`). The pieces fit together like this:
  - `http_ece.encrypt(payload, private_key=<ephemeral P-256 key>, dh=<subscription p256dh>,
    auth_secret=<subscription auth>, version="aes128gcm")` produces the body;
  - the VAPID JWT (ES256) is signed with **PyJWT, which is already installed** through `djangorestframework_simplejwt`
    (its ES256 needs `cryptography`);
  - the POST is `urllib.request`.

  That is about 80 lines in `apps/channels/providers/webpush.py`.
- **Why not `pywebpush`.** It does the same with the same two libraries underneath (`http-ece`, `py-vapid`), but its
  2.x line also pulls in `aiohttp`, `requests` and `six` (check this at pin time), and only one function of it would be
  used. Fewer transitive packages means less image size and less CVE surface. `cryptography` was needed anyway: for
  ES256, for `http-ece`, and for phone-number encryption (§7.1).
- **Request.**
  - `POST <endpoint>` with the headers `Content-Encoding: aes128gcm`, `TTL: <s>`, `Urgency: normal|high`, optionally
    `Topic: <≤32 url-safe chars>`, and `Authorization: vapid t=<jwt>, k=<base64url public key>`.
  - JWT claims: `aud` = scheme + host of the endpoint, `exp` = now + 12 h, `sub` = `VAPID_SUBJECT`. Tokens are cached
    per `aud` for 1 h.
- **Endpoint allow-list (SSRF guard).** A subscription endpoint must be `https` on a host matching
  `WEB_PUSH_ALLOWED_HOSTS`: `fcm.googleapis.com`, `updates.push.services.mozilla.com`, `web.push.apple.com`,
  `*.notify.windows.com`, `*.push.apple.com`. Anything else → 422 at subscribe time. It is checked again before every
  send.
- **Keys.** `python manage.py generate_vapid_keys` prints `VAPID_PUBLIC_KEY` (base64url uncompressed point, 65 bytes)
  and `VAPID_PRIVATE_KEY` (base64url raw 32-byte scalar). The browser gets the public key from the API (§5.9), so the
  frontend has **no** VAPID env var and can't drift from the backend.
- **Key rotation** invalidates every subscription (push services answer 403 to a JWT signed with the wrong key). The
  client compares `subscription.options.applicationServerKey` with the server key on each sync and re-subscribes when
  they differ (§8.6).

### 2.5 Environment variables and secrets

Backend (Render → Environment; mark the secrets `sync: false` in `render.yaml`):

| Variable | Secret | Required for | Default | Notes |
|---|---|---|---|---|
| `TELEGRAM_BOT_TOKEN` | **yes** | Telegram | — | From @BotFather `/newbot`. |
| `TELEGRAM_BOT_USERNAME` | no | Telegram | — | Without `@`, e.g. `lightex_bot`. Shown in the dialog and used in deep links. |
| `TELEGRAM_WEBHOOK_SECRET` | **yes** | Telegram | — | 32–256 chars of `[A-Za-z0-9_-]`. Generate with `python -c "import secrets;print(secrets.token_urlsafe(48))"`. |
| `TELEGRAM_LINK_TTL_SECONDS` | no | | `600` | The design's 10:00 countdown. |
| `TWILIO_ACCOUNT_SID` | no (an identifier) | SMS | — | `AC…` |
| `TWILIO_AUTH_TOKEN` | **yes** | SMS | — | Signs both webhooks too (§7.3). |
| `TWILIO_MESSAGING_SERVICE_SID` | no | SMS | — | `MG…`. Preferred over `TWILIO_FROM_NUMBER`. |
| `TWILIO_FROM_NUMBER` | no | SMS | — | E.164; used only when no Messaging Service is set (then STOP isn't automatic; not recommended). |
| `SMS_COUNTRIES` | no | | `US,GB,DE` | ISO codes from the server table (§5.6). |
| `SMS_USER_DAILY_CAP` | no | | `10` | Notification SMS per user per UTC day (tests and summaries count). |
| `SMS_GLOBAL_DAILY_CAP` | no | | `300` | Circuit breaker for all notification SMS per UTC day. |
| `SMS_OTP_GLOBAL_DAILY_CAP` | no | | `100` | Every OTP send, all users, per UTC day. |
| `VAPID_PUBLIC_KEY` | no | Push | — | Generated (§2.4). |
| `VAPID_PRIVATE_KEY` | **yes** | Push | — | Generated. |
| `VAPID_SUBJECT` | no | Push | — | `mailto:ops@your-domain` or an `https:` URL (required by Apple and Mozilla). |
| `CHANNELS_ENCRYPTION_KEY` | **yes** | SMS | — | Fernet key(s), comma-separated, newest first (rotation, §7.1). `python manage.py generate_channels_key`. Settings refuse to start in prod with `SMS_BACKEND=twilio` and no key. |
| `CHANNEL_DISPATCH` | no | | `auto` | `auto` (Celery when `REDIS_URL` is set, else `thread`), `thread`, `celery`, `inline` (tests). |
| `CHANNEL_SENDER_THREADS` | no | | `4` | Size of the per-process sender pool (§6.7). |
| `CHANNEL_MAX_ATTEMPTS` | no | | `5` | Then `dead` (§6.8). |
| `CHANNEL_HTTP_TIMEOUT` | no | | `10` | Seconds, for each provider call. |
| `WEB_PUSH_ALLOWED_HOSTS` | no | | the list in §2.4 | |
| `THROTTLE_CHANNEL_CONNECT` | no | | `20/hour` | DRF scope `channel_connect` (link creation, SMS start). Per process without Redis, so the SMS limits that matter are counted in the database (§7.5). |
| `THROTTLE_CHANNEL_TEST` | no | | `12/hour` | DRF scope `channel_test`. |
| `THROTTLE_WEBHOOK` | no | | `600/min` | Per IP, on the three webhooks. |
| (existing) `FRONTEND_URL`, `API_PUBLIC_URL` | | | | Deep links (§6.4) and webhook URLs. `API_PUBLIC_URL` must be the exact public origin Twilio calls, because signature checking uses the full URL. |

Frontend: **no new variables.** The VAPID key comes from the API, the bot username from `GET
/me/notification-channels`, and the countries from the same response.

### 2.6 Accounts and one-time setup (for the user)

| # | What | Steps |
|---|---|---|
| A1 | **Telegram bot** | Message @BotFather: `/newbot` → name "Lightex", username e.g. `lightex_bot` → copy the token. `/setjoingroups` → Disable (the bot only works in private chats). Optional: `/setdescription`, `/setuserpic` (the logo). Set `TELEGRAM_*` and deploy, then run `python manage.py telegram_setup` in a Render shell (or as part of the start command, §12). A dev bot is a **separate** bot (`lightex_dev_bot`), so the production webhook isn't overwritten. |
| A2 | **Twilio account** | Sign up and **upgrade from trial**: trial accounts only text verified numbers and prefix "Sent from your Twilio trial account". Buy a number: toll-free (US) or long code; for the UK/DE a long code or an alphanumeric sender ID (no replies, so no STOP; we use a number). Create a **Messaging Service**, add the number to its sender pool, and leave **Advanced Opt-Out** on. Integration → incoming messages → webhook `POST {API_PUBLIC_URL}/api/v1/webhooks/twilio/sms`. Messaging → Settings → **Geo permissions**: enable only the countries in `SMS_COUNTRIES`. |
| A3 | **US sender registration** | US traffic needs **A2P 10DLC** brand + campaign registration (long code) or **toll-free verification**. It takes days to weeks and costs a registration fee. Without it, US carriers filter messages (error `30007`/`30034`). Use case: "Account notifications / 2FA", sample messages from §6.5. |
| A4 | **India (only if enabled)** | DLT registration (entity + header + every template) through an Indian operator portal before adding `IN` to `SMS_COUNTRIES`. |
| A5 | **VAPID keys** | No account. `python manage.py generate_vapid_keys` → set the three `VAPID_*` vars. Keep the private key stable: rotating it drops every browser subscription. |
| A6 | **Channels encryption key** | No account. `python manage.py generate_channels_key` → `CHANNELS_ENCRYPTION_KEY`. Back it up: losing it makes the stored phone numbers unreadable (users would re-verify). |
| A7 | **Scheduler (recommended)** | A cron for `python manage.py send_channel_deliveries` every 5 min (Render Cron Job, a paid plan; or an existing scheduler). It is the safety net for retries and quiet-hours summaries when the web process was asleep (§6.7). |

---

## 3. Data model (backend)

### 3.1 App placement

`apps/channels` is a new app. It contains the models below plus `providers/`, `render.py` (templates), `dispatch.py`
(fan-out), `runner.py` (pool and sweeper), `quiet.py`, `phones.py`, `crypto.py`, `services.py`, `selectors.py`,
`serializers.py`, `views.py`, `webhooks.py`, `urls.py`, `tasks.py`, `management/commands/*`, and
`templates/channels/*`. `apps.notifications` keeps the outbox, `Notification` and `NotificationPreference`, and calls
`channels.dispatch.enqueue_for_notification(...)` from `deliver()` (§6.1).

All models use `BaseModel` (UUID pk, `created_at`, `updated_at`).

### 3.2 `channels.TelegramLinkRequest`

| Field | Type | Notes |
|---|---|---|
| `user` | FK User, CASCADE | |
| `code_hash` | char(64) | HMAC-SHA256 of the normalised 6-character code (§7.2) |
| `start_hash` | char(64), unique | SHA-256 of the deep-link payload token |
| `status` | char(10) | `pending` · `linked` · `expired` · `canceled` |
| `expires_at` | datetime | now + `TELEGRAM_LINK_TTL_SECONDS` |
| `linked_at` | datetime null | |
| `connection` | FK TelegramConnection null, SET_NULL | set on success |

Constraints:

- One `pending` request per user (partial unique on `user` where `status = 'pending'`). Creating a new request cancels
  the old one in the same transaction.
- Index on (`code_hash`, `status`).

Expired rows flip lazily when read, and are purged after 1 day (§6.10).

### 3.3 `channels.TelegramConnection`

| Field | Type | Notes |
|---|---|---|
| `user` | OneToOne User, CASCADE | one Telegram chat per user |
| `chat_id` | bigint | private chat id (equals the Telegram user id) |
| `username` | char(64) null | `@alexkim` without `@`; refreshed on every incoming message |
| `first_name` | char(64) | shown when there's no username |
| `status` | char(10) | `active` · `blocked` (the user blocked the bot, or Telegram says the chat is gone) |
| `connected_at` | datetime | |
| `last_error` / `last_error_at` | text / datetime null | last permanent failure, shown in the UI |

`chat_id` is **not** unique: one person may link the same Telegram account to two Lightex accounts. Index on
`chat_id` (for `/stop` and `my_chat_member`).

### 3.4 `channels.SmsVerification`

| Field | Type | Notes |
|---|---|---|
| `user` | FK User, CASCADE | |
| `phone_enc` | text | Fernet ciphertext of the E.164 number (§7.1) |
| `phone_hash` | char(64) | HMAC lookup hash of the E.164 number |
| `country` | char(2) | |
| `code_hash` | char(64) | HMAC-SHA256(`otp` key, `"{id}:{code}"`) |
| `attempts_left` | smallint | starts at 3 |
| `send_count` | smallint | 1 + resends |
| `status` | char(10) | `pending` · `verified` · `expired` · `canceled` |
| `expires_at` | datetime | last send + 600 s |
| `resend_at` | datetime | last send + 30 s |
| `verified_at` | datetime null | |

Constraints and indexes:

- One `pending` per user (partial unique).
- Indexes on (`user`, `created_at`) and (`phone_hash`, `created_at`); the OTP limits count these (§7.5).
- Every send also writes an `OtpSend` row: `user`, `phone_hash`, `ip` (inet null), `created_at`. That keeps the counts
  exact across resends, and it is cheap.

### 3.5 `channels.SmsConnection`

| Field | Type | Notes |
|---|---|---|
| `user` | OneToOne User, CASCADE | one verified phone per user |
| `phone_enc` / `phone_hash` | text / char(64) | as above; index on `phone_hash` (STOP and status callbacks look up by number) |
| `country` | char(2) | |
| `last4` | char(4) | for logs and masks without decrypting |
| `status` | char(12) | `active` · `opted_out` (STOP) · `invalid` (not a mobile, unreachable) |
| `verified_at` / `opted_out_at` | datetime / datetime null | |
| `last_error` / `last_error_at` | | |

`phone_hash` is not unique: the same number may be verified by two accounts. STOP applies to **every** connection with
that hash, because it is the number's owner speaking.

### 3.6 `channels.PushSubscription`

| Field | Type | Notes |
|---|---|---|
| `user` | FK User, CASCADE | |
| `endpoint` | text | validated against the allow-list (§2.4) |
| `endpoint_hash` | char(64), **unique** | SHA-256 hex of `endpoint`. A browser subscription belongs to one user at a time. |
| `p256dh` / `auth` | char(100) / char(32) | base64url, as the browser gives them |
| `expiration_time` | datetime null | from the browser (usually null) |
| `label` | char(60) | "Chrome on macOS" (derived from User-Agent, §5.10) |
| `user_agent` | char(256) | truncated |
| `status` | char(10) | `active` · `expired` (404/410, or a VAPID key mismatch) |
| `last_seen_at` / `last_success_at` | datetime / datetime null | |
| `failure_count` | smallint | consecutive transient failures; reset on success |

A user has at most **10** active subscriptions; the oldest by `last_seen_at` is expired when an 11th arrives. Expired
rows are deleted after 7 days.

### 3.7 `channels.ChannelDelivery` (delivery log, retry queue, dead letter)

| Field | Type | Notes |
|---|---|---|
| `user` | FK User, CASCADE | recipient |
| `workspace` | FK Workspace null, CASCADE | the event's workspace (SMS policy, inbox link); null for tests |
| `channel` | char(10) | `telegram` · `sms` · `push` · `email` (email: tests only) |
| `kind` | char(10) | `event` · `summary` · `test` |
| `notification` | FK Notification null, CASCADE | null for summaries and tests |
| `event` | char(20) | preference key (`assigned`, …), `summary` or `test` |
| `telegram` / `sms` / `push` | FK to the matching connection, null, SET_NULL | exactly one is set for `event`/`summary`/`test` rows (check constraint) |
| `template` | char(40) | `assigned`, `mentioned`, …, `summary`, `test` |
| `context` | JSON | snapshot of the merge tags at enqueue (like v1 `email_context`) |
| `urgent` | bool | task priority 4 at enqueue (§6.6) |
| `status` | char(10) | `queued` · `deferred` · `sending` · `retry` · `sent` · `failed` · `dead` · `skipped` · `coalesced` |
| `skip_reason` | char(20) | `unavailable` · `policy` · `cap` · `global_cap` · `opted_out` · `blocked` · `expired` · `stale` · `not_connected` |
| `attempts` | smallint | |
| `next_attempt_at` | datetime | also the release time of `deferred` rows (end of quiet hours) |
| `lease_until` | datetime null | set while `sending` (§6.7) |
| `provider_id` | char(64) | Telegram `message_id`, Twilio `MessageSid`, push `Location` |
| `error_code` / `error` | char(32) / text | last failure (truncated to 1,000 chars, with **no** phone numbers or message text) |
| `sent_at` | datetime null | |
| `summary` | FK self null, SET_NULL | for `coalesced` rows: the summary that replaced them |

Constraints and indexes:

- Unique (`notification`, `channel`, `telegram`, `sms`, `push`) where `notification IS NOT NULL`, so an event is never
  enqueued twice for the same target (`process_event` already runs exactly once; this is defence in depth).
- Index (`status`, `next_attempt_at`) for the sweeper.
- Index (`user`, `channel`, `created_at`) for the caps and the UI's "sent today".

Rendered text is **not stored**: it is rebuilt from `template` + `context` at send time. The log therefore holds no
more content than v1's `email_context`.

### 3.8 `notifications.NotificationPreference` (extended)

| Field | Change |
|---|---|
| `events` (JSON) | Each event gains `telegram`, `sms` and `push` booleans. Defaults come from the design's `DEF` table: |

| Event | in_app | email | telegram | sms | push |
|---|---|---|---|---|---|
| `assigned` | ✓ | ✓ | ✓ | · | ✓ |
| `mentioned` | ✓ | ✓ | ✓ | · | ✓ |
| `status_change` | ✓ | · | · | · | · |
| `comment` | ✓ | · | ✓ | · | ✓ |
| `due_soon` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `sprint_started` | ✓ | · | · | · | · |

The in_app and email defaults are v1's, unchanged. New columns:

| Column | Type | Default |
|---|---|---|
| `quiet_enabled` | bool | `true` (design) |
| `quiet_from` / `quiet_to` | time | `22:00` / `08:00` |
| `quiet_days` | smallint bitmask, Mon = bit 0 | `127` (every day; the design shows Mon–Fri, §10 #5) |
| `quiet_urgent_bypass` | bool | `true` |
| `timezone` | char(64) null | `null` until the client sends one. **Quiet hours are inactive while it is null** (§6.6). |

### 3.9 `workspaces.Workspace` (one column)

`sms_enabled` bool, default `true`. On the wire it is `notificationPolicy: { sms: boolean }` (§5.13).

### 3.10 Migrations

1. `channels` 0001: all the models above.
2. `notifications` 0003: the five quiet-hours/timezone columns, plus a **data migration** that merges the new channel
   keys into every existing `events` JSON with the defaults above, without touching the `in_app`/`email` values. The
   `default_events()` function gains the keys.
3. `workspaces` 000N: `sms_enabled`.
4. `access`: no new permission (§4).

---

## 4. Permissions

### 4.1 Personal settings

Every `/me/notification-channels…`, `/me/push-subscriptions…` and `/notification-preferences` route is
`IsAuthenticated`, with **no catalogue permission**. A user always controls their own channels, including viewers and
members who were deactivated in one workspace but are active in another. The permission-matrix test lists them as
"any authenticated user" (the same treatment as v1 `/notification-preferences` and `/auth/me`).

### 4.2 Workspace SMS policy (the only admin control)

- **Read:** `notificationPolicy.sms` is on every workspace response (members see it, because it explains "Off by
  admin").
- **Write:** `PATCH /workspaces/:slug { "notificationPolicy": { "sms": false } }` requires **`workspace.update`** (the
  existing permission behind the general settings). Without it → 403 `forbidden`, `details.permission:
  "workspace.update"`.
- **Effect:** SMS for events whose `DomainEvent.workspace` has the policy off is skipped (`skip_reason = "policy"`).
  The user's phone stays verified, and other workspaces are unaffected. Telegram and Push have no admin control (they
  cost nothing), and the design has none.
- **Audit:** a workspace audit row `workspace.updated` with `changes: { "smsNotifications": [true, false] }`.

### 4.3 Object rules (the server enforces them; the client mirrors them)

| Rule | Where |
|---|---|
| A link request, verification, connection, subscription or delivery is visible only to its `user` | selectors filter on `request.user`; others → 404 |
| At send time the recipient must still be active and a member of the event's project, and the task must not be deleted | dispatcher re-check → `skipped` / `stale` (§6.7) |
| A browser subscription moves to whoever subscribes it last (unique `endpoint_hash`) | `PUT /me/push-subscriptions` with `mode: "subscribe"` (§5.10) |

---

## 5. Endpoints

### 5.0 Summary

| # | Method | Path | Auth | Purpose |
|---|---|---|---|---|
| C1 | GET | `/me/notification-channels` | user | Every channel's availability and connection state |
| C2 | POST | `/me/notification-channels/telegram/link` | user | Start a Telegram link (code + deep link) |
| C3 | GET | `/me/notification-channels/telegram/link/:linkId` | user | Poll link status |
| C4 | DELETE | `/me/notification-channels/telegram/link/:linkId` | user | Cancel a pending link (dialog closed) |
| C5 | DELETE | `/me/notification-channels/telegram` | user | Disconnect Telegram |
| C6 | POST | `/me/notification-channels/sms/verifications` | user | Send a code to a phone number |
| C7 | POST | `/me/notification-channels/sms/verifications/:id/resend` | user | Send a new code |
| C8 | POST | `/me/notification-channels/sms/verifications/:id/verify` | user | Check a code → connection |
| C9 | DELETE | `/me/notification-channels/sms` | user | Remove the phone |
| C10 | GET | `/push/vapid-public-key` | **public** | VAPID application server key |
| C11 | PUT | `/me/push-subscriptions` | user | Subscribe or refresh this browser |
| C12 | POST | `/me/push-subscriptions/remove` | user | Unsubscribe by endpoint (this browser, logout) |
| C13 | DELETE | `/me/push-subscriptions/:id` | user | Remove a device from the list |
| C14 | POST | `/me/notification-channels/:channel/test` | user | Send a test (`email`, `telegram`, `sms`, `push`) |
| P1 | GET / PUT | `/notification-preferences` | user | Extended matrix + quiet hours (v1 route) |
| W1 | GET / PATCH | `/workspaces/:slug` | v1 rules | `notificationPolicy.sms` (additive field) |
| H1 | POST | `/webhooks/telegram` | secret header | Telegram updates |
| H2 | POST | `/webhooks/twilio/sms` | Twilio signature | Inbound SMS (STOP/START) |
| H3 | POST | `/webhooks/twilio/status` | Twilio signature | Delivery status callbacks |

Webhooks live under `/api/v1/webhooks/…`. They are excluded from the OpenAPI client section (tag `webhooks`), from the
CORS allow-list (not needed: server-to-server) and from the refresh-cookie Origin check.

### 5.1 Shapes

```ts
type ExternalChannel = "telegram" | "sms" | "push";
type NotificationChannel = "in_app" | "email" | ExternalChannel;

interface TelegramConnection {
  id: ID;
  username: string | null;      // "alexkim" (no @)
  firstName: string;            // "Alex"
  status: "active" | "blocked";
  connectedAt: ISODateTime;
  lastError: string | null;     // "You blocked the bot in Telegram."
}

interface SmsConnection {
  id: ID;
  phoneNumber: string;          // "+14155550132" (owner only)
  display: string;              // "+1 (415) 555-0132"
  country: string;              // "US"
  status: "active" | "opted_out" | "invalid";
  verifiedAt: ISODateTime;
  lastError: string | null;
}

interface PushDevice {
  id: ID;
  label: string;                // "Chrome on macOS"
  endpointHash: string;         // first 16 hex chars of sha256(endpoint); lets a browser find itself
  status: "active" | "expired";
  createdAt: ISODateTime;
  lastSeenAt: ISODateTime;
  lastSuccessAt: ISODateTime | null;
}

interface SmsCountry { code: string; dial: string; label: string; digits: number; pattern: string }
```

### 5.2 C1 `GET /me/notification-channels`

`200`:

```json
{
  "email": { "address": "alex@team.dev" },
  "telegram": {
    "available": true,
    "botUsername": "lightex_bot",
    "connection": {
      "id": "6b0c…", "username": "alexkim", "firstName": "Alex", "status": "active",
      "connectedAt": "2026-10-09T09:12:44Z", "lastError": null
    }
  },
  "sms": {
    "available": true,
    "countries": [
      { "code": "US", "dial": "+1",  "label": "US +1",  "digits": 10, "pattern": "(XXX) XXX-XXXX" },
      { "code": "GB", "dial": "+44", "label": "UK +44", "digits": 10, "pattern": "XXXX XXXXXX" },
      { "code": "DE", "dial": "+49", "label": "DE +49", "digits": 11, "pattern": "XXX XXXXXXXX" }
    ],
    "connection": null,
    "dailyCap": 10,
    "sentToday": 0
  },
  "push": {
    "available": true,
    "vapidPublicKey": "BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U",
    "devices": [
      { "id": "a2f1…", "label": "Chrome on macOS", "endpointHash": "9c1e5a77d0b2f3aa", "status": "active",
        "createdAt": "2026-10-08T15:01:00Z", "lastSeenAt": "2026-10-09T08:55:00Z", "lastSuccessAt": "2026-10-09T08:40:02Z" }
    ]
  }
}
```

- `available: false` (backend `disabled`): `botUsername`/`vapidPublicKey` are `null` and `countries` is `[]`.
- A pending link or verification is **not** listed. The dialogs hold their own ids.
- Only `active` devices are listed, plus `expired` ones from the last 7 days, so the client can explain "This browser's
  subscription expired".

### 5.3 C2 `POST /me/notification-channels/telegram/link`

Request (all optional):

```json
{ "timezone": "America/New_York" }
```

`timezone` fills `NotificationPreference.timezone` only if it is still null (§6.6). Every connect call carries it, so
quiet hours start working without a separate save.

`201`:

```json
{
  "id": "tgl_0f3c…",
  "status": "pending",
  "code": "K7MQ2X",
  "deepLink": "https://t.me/lightex_bot?start=lx_Qm9iX3Rva2VuX2V4YW1wbGVfNDhjaGFyc19sb25nX2Fh",
  "botUsername": "lightex_bot",
  "expiresAt": "2026-10-09T09:22:44Z",
  "connection": null
}
```

- **Code:** 6 characters from `ABCDEFGHJKMNPQRSTVWXYZ23456789` (no 0/O/1/I/L/U), `secrets.choice`. The design shows it
  as `K7M Q2X`-style groups of 3; the client formats it.
- **Deep link payload:** `lx_` + 43 url-safe chars (32 random bytes). It fits Telegram's 64-character `[A-Za-z0-9_-]`
  limit.
- **Side effect:** any previous pending request of the user becomes `canceled`.
- **Errors:**
  - 503 `channel_unavailable` `{ "channel": "telegram" }`;
  - 429 `throttled` (scope `channel_connect`);
  - 409 `already_connected` when an **active** connection exists. Re-linking requires disconnecting first, so a
    shoulder-surfed QR can't silently replace the chat. A `blocked` connection may be re-linked directly.

### 5.4 C3 `GET /me/notification-channels/telegram/link/:linkId`

`200`: the same shape as C2, with `code` and `deepLink` **omitted** once the status isn't `pending`.

- Polled every **2 s** while the dialog is open and the tab is visible; polling stops on `linked`, `expired` or
  `canceled`.
- `expired` is computed when read (`expires_at <= now`).
- On `linked`, `connection` holds the `TelegramConnection`:

```json
{ "id": "tgl_0f3c…", "status": "linked", "botUsername": "lightex_bot", "expiresAt": "2026-10-09T09:22:44Z",
  "connection": { "id": "6b0c…", "username": "alexkim", "firstName": "Alex", "status": "active",
                  "connectedAt": "2026-10-09T09:14:02Z", "lastError": null } }
```

404 if the link doesn't exist or isn't the caller's.

### 5.5 C4 / C5 cancel and disconnect

- **C4** `DELETE …/telegram/link/:linkId` → 204. A pending link becomes `canceled`; any other status is left alone
  (still 204). The client calls it when the dialog closes before linking, matching the design's `closeDlg`, which
  resets `tg` to off.
- **C5** `DELETE /me/notification-channels/telegram` → 204.
  - It deletes the connection, and queued/deferred/retry deliveries become `skipped` (`not_connected`).
  - Best effort, after commit: the bot sends "Disconnected from Lightex. Send /start with a new code to connect again."
  - It is idempotent (204 when there is nothing to delete).

### 5.6 C6 `POST /me/notification-channels/sms/verifications`

Request:

```json
{ "country": "US", "nationalNumber": "4155550132", "timezone": "America/New_York" }
```

Server table (the source of `countries` in C1; the mock copies it):

| code | dial | label | digits | pattern | national rule |
|---|---|---|---|---|---|
| US | +1 | US +1 | 10 | `(XXX) XXX-XXXX` | first digit 2–9; digit 4 is 2–9 (NANP) |
| GB | +44 | UK +44 | 10 | `XXXX XXXXXX` | must start with `7` (mobile); a leading `0` is stripped before counting |
| DE | +49 | DE +49 | 11 | `XXX XXXXXXXX` | must start with `15`, `16` or `17` (mobile); a leading `0` is stripped |
| IN | +91 | IN +91 | 10 | `XXXXX XXXXX` | first digit 6–9. **Off unless listed in `SMS_COUNTRIES`.** |

The number is normalised to digits only, any leading trunk `0` removed, validated against the rule, then E.164 =
dial + national.

`201`:

```json
{
  "id": "smv_7d21…",
  "phoneNumber": "+14155550132",
  "display": "+1 (415) 555-0132",
  "expiresAt": "2026-10-09T09:24:00Z",
  "resendAt": "2026-10-09T09:14:30Z",
  "attemptsLeft": 3
}
```

Errors:

| Status | Code | `details` | UI copy (design) |
|---|---|---|---|
| 422 | `validation_failed` | `fields.nationalNumber: "Enter 10 digits"` (digits from the table) | `Enter 10 digits` under the input (red) |
| 422 | `validation_failed` | `fields.nationalNumber: "Enter a mobile number"` | same slot |
| 422 | `validation_failed` | `fields.country: "SMS isn't available for this country"` | same slot |
| 409 | `already_connected` | `{}` | (client never offers it; it removes first) |
| 429 | `throttled` | `{ "retryAt": "…", "reason": "hourly_limit" \| "daily_limit" \| "phone_limit" \| "global_limit" }` | toast "Too many codes requested. Try again at 10:42." |
| 503 | `channel_unavailable` | `{ "channel": "sms" }` | row shows "Not available" |

Side effects: any previous pending verification of the user is canceled. One `OtpSend` row is written. The SMS
(§6.5 "otp") is sent **synchronously** (a single provider call with a 10 s timeout). If it fails, the verification is
canceled and the response is 502 `channel_send_failed` with `{ "channel": "sms", "reason": "invalid_number" |
"provider_error" }`; the UI shows "Couldn't send a code to this number" in the help slot.

### 5.7 C7 `POST /me/notification-channels/sms/verifications/:id/resend`

`200`: the same shape as C6, with a **new code**, `attemptsLeft: 3` (the design resets tries on resend), and new
`expiresAt` / `resendAt`.

| Status | Code | When |
|---|---|---|
| 429 | `throttled`, `reason: "resend_cooldown"`, `retryAt` = `resend_at` | before `resend_at` (30 s); the UI keeps "Resend in 0:xx" |
| 429 | `throttled`, `reason: "hourly_limit"` … | the §7.5 limits |
| 410 | `verification_closed` | already verified or canceled |
| 404 | `not_found` | not the caller's |

### 5.8 C8 `POST /me/notification-channels/sms/verifications/:id/verify`

Request:

```json
{ "code": "482913" }
```

`200` (an existing SMS connection of the user is replaced; the client only reaches here without one):

```json
{
  "connection": {
    "id": "8e44…", "phoneNumber": "+14155550132", "display": "+1 (415) 555-0132", "country": "US",
    "status": "active", "verifiedAt": "2026-10-09T09:14:41Z", "lastError": null
  }
}
```

Errors:

| Status | Code | `details` | UI copy (design) |
|---|---|---|---|
| 422 | `invalid_code` | `{ "attemptsLeft": 2 }` | `Wrong code · 2 tries left` (`1 try left`), boxes cleared, focus on box 1, shake |
| 422 | `too_many_attempts` | `{ "attemptsLeft": 0 }` | `Too many tries · resend a code`; boxes read-only until Resend |
| 410 | `code_expired` | `{}` | `Code expired · resend a code` |
| 422 | `validation_failed` | `fields.code: "Enter the 6-digit code"` | (the client only submits 6 digits) |

- A wrong code decrements `attempts_left` in a `SELECT … FOR UPDATE` transaction, so parallel guesses can't exceed 3.
- At 0 the code is dead even if the next guess would be right.
- The comparison is `hmac.compare_digest`.

### 5.9 C9 and C10

- **C9** `DELETE /me/notification-channels/sms` → 204. It deletes the connection; pending SMS deliveries become
  `skipped`. Idempotent.
- **C10** `GET /push/vapid-public-key` → `200 { "publicKey": "BEl62…" }`.
  - It is public, with `Cache-Control: public, max-age=3600`.
  - 503 `channel_unavailable` when push is disabled.
  - It is the same value as `push.vapidPublicKey` in C1. C10 exists for clients that need the key before they can call
    C1 (the logout clean-up and future SW code).

### 5.10 C11 `PUT /me/push-subscriptions`

Request: the browser's `PushSubscription.toJSON()` plus a mode:

```json
{
  "mode": "subscribe",
  "subscription": {
    "endpoint": "https://fcm.googleapis.com/fcm/send/dpH5lCsTSSM:APA91bH…",
    "expirationTime": null,
    "keys": { "p256dh": "BLc4xRzKlKORKWlbdgFaBrrPK3ydWAHo4M0gs0i1oEKgPpWC5cW8OCzVrOQRv-1npXRWk8udnW3oYhIO4475rds", "auth": "5I2Bu2oKdyy9CwL8QVF0NQ" }
  },
  "timezone": "America/New_York"
}
```

| `mode` | Behaviour |
|---|---|
| `subscribe` | Upsert by `endpoint_hash`. If the row belongs to **another** user, it moves to the caller (the browser's current user enabled push). → 201 when created, 200 when updated. |
| `refresh` | Only updates `last_seen_at`, keys and label **if the row already belongs to the caller and is active**. Otherwise 404 `not_found`, and the client then calls `subscription.unsubscribe()` locally (§8.6). → 200. |

`200`/`201`: a `PushDevice`. The `label` comes from the request's `User-Agent`: a small table matching Edge, Chrome,
Firefox and Safari × Windows, macOS, Android, iOS, Linux, falling back to "Browser on Unknown OS".

Errors:

- 422 `validation_failed`:
  - `fields["subscription.endpoint"]: "Unsupported push service"` (allow-list);
  - `"subscription.keys.p256dh": "Invalid key"` (must decode to a 65-byte uncompressed P-256 point, checked with
    `cryptography`);
  - `"subscription.keys.auth"` (must decode to 16 bytes).
- 503 `channel_unavailable`.

### 5.11 C12, C13, C14

**C12** `POST /me/push-subscriptions/remove` with `{ "endpoint": "https://fcm.googleapis.com/fcm/send/…" }` → 204.
It deletes the caller's row for that endpoint, if any. Idempotent. Used by "Turn off" and by logout (§8.6).

**C13** `DELETE /me/push-subscriptions/:id` → 204 (another user's id → 404). Used by the device list (§8.3).

**C14** `POST /me/notification-channels/:channel/test`, where `:channel` is `email`, `telegram`, `sms` or `push`.
In-app tests are client-only (§8.3).

Request (optional): `{ "deviceId": "a2f1…" }`, push only (default: every active device).

`200`:

```json
{ "channel": "telegram", "status": "sent", "deliveryId": "cd_51aa…", "sentAt": "2026-10-09T09:15:03Z" }
```

- A test is sent **synchronously**: one provider call (push: one call per targeted device; ok if any succeeds).
- It **ignores quiet hours** (an explicit user action), is logged as a `ChannelDelivery` with `kind = "test"`, and
  **counts toward the SMS daily cap**.
- The message is the "test" template (§6.5), never task data.
- `email` sends a plain-text email, subject "Lightex test notification", to the account address through
  `send_email_task` (inline). There is no designed template for it (§10 #7).

Errors:

| Status | Code | `details` | UI |
|---|---|---|---|
| 409 | `channel_not_connected` | `{ "channel": "sms" }` | (not offered) |
| 502 | `channel_send_failed` | `{ "channel": "telegram", "reason": "blocked" }` | error toast "Couldn't reach Telegram · You blocked the bot. Unblock it and send /start." |
| 502 | `channel_send_failed` | `{ "channel": "sms", "reason": "opted_out" }` | "You replied STOP. Text START to +1 … to resume." |
| 502 | `channel_send_failed` | `{ "channel": "push", "reason": "expired_subscription" }` | "This browser's subscription expired. Turn push off and on." |
| 429 | `throttled` | `{ "retryAt": "…", "reason": "test_limit" \| "daily_cap" }` | toast with the time |
| 503 | `channel_unavailable` | | |

A permanent failure also updates the connection (§6.8), so C1 reflects it after the client invalidates.

### 5.12 Webhooks

**H1 `POST /webhooks/telegram`**

- **Verification.** Header `X-Telegram-Bot-Api-Secret-Token` must equal `TELEGRAM_WEBHOOK_SECRET`
  (`hmac.compare_digest`). If it is missing or wrong → **401** with an empty body, logged at WARNING with the IP.
- **Content.** Body ≤ 64 KB, else 413. Only `message` and `my_chat_member` are handled; anything else → 200 `{}`.
- **Always 200** once verified, even for updates we ignore, so Telegram doesn't retry. Handlers are idempotent.
  `update_id` is also remembered for 10 min in the cache (best effort, per process), to skip retried updates cheaply.
- **Private chats only.** For `chat.type != "private"` the bot replies "I only work in a private chat. Open
  t.me/lightex_bot." and ignores the message.
- `username` and `first_name` on a matching `TelegramConnection` are refreshed from `message.from` on every message.

| Incoming | Handling | Reply (in the webhook response, §2.2) |
|---|---|---|
| `/start lx_<token>` | Look up a `pending`, unexpired request by `sha256(token)`, with `select_for_update`. Found: create or replace the user's `TelegramConnection` (chat id, username, first name, `active`), mark the request `linked`. | "Connected to Lightex. Notifications for your account will arrive here. Send /stop to disconnect." |
| `/start K7MQ2X`, or a bare `K7MQ2X` / `k7m-qx2` | Normalise (uppercase, strip spaces and dashes), then look up by `code_hash` among pending, unexpired requests. Same as above. | same |
| a code or token that doesn't match | Count a failure for this chat (cache key `tg_fail:<chat_id>`, and a DB row in `TelegramLinkFailure` when the cache is per process). After **5 failures in an hour** the chat is ignored for an hour (a reply once, then silence). | "That code didn't work. Codes expire after 10 minutes. Open Lightex → Settings → Notifications for a new one." |
| `/start` with nothing, or `/status` | Report whether this chat is linked to any account | "This chat is connected to Lightex." or "Not connected. In Lightex open Settings → Notifications → Telegram → Connect." |
| `/stop` | Delete every `TelegramConnection` with this `chat_id` (the owner speaking) | "Disconnected. You won't get Lightex notifications here." |
| `/help` | | Short help with the commands |
| other text (including replies to notifications) | none (quick replies are out of scope, §1.2) | "Replies aren't supported yet. Use the button to open the task in Lightex." |
| `my_chat_member` with `new_chat_member.status = "kicked"` (the user blocked the bot) | connection(s) with this chat → `blocked`, `last_error = "You blocked the bot in Telegram."` | none |
| `my_chat_member` with `status = "member"` (unblocked) | `blocked` → `active` | none |

**H2 `POST /webhooks/twilio/sms`** (form-encoded)

- **Verification.** `X-Twilio-Signature` must equal `base64(HMAC-SHA1(TWILIO_AUTH_TOKEN, url + Σ sorted(key + value)))`,
  where `url` = `API_PUBLIC_URL` + the request path. If not → **403**.
- **Handling.** `From` (E.164) → `phone_hash` → every `SmsConnection` with that hash:

| Input | Effect |
|---|---|
| `OptOutType=STOP`, or a body (trimmed, case-insensitive) in `STOP STOPALL UNSUBSCRIBE CANCEL END QUIT` | `status = opted_out`, `opted_out_at = now`. Pending SMS deliveries → `skipped` (`opted_out`). |
| `OptOutType=START`, or body `START` / `UNSTOP` / `YES` | `opted_out` → `active` |
| `HELP` / `INFO`, or anything else | nothing (Twilio Advanced Opt-Out answers HELP; we never auto-reply, so we can't loop) |

- **Response:** `200`, `Content-Type: text/xml`, body `<?xml version="1.0" encoding="UTF-8"?><Response/>`.

**H3 `POST /webhooks/twilio/status`** (form-encoded, signature as H2)

- Look up the delivery by `MessageSid` = `provider_id`.
- `MessageStatus = delivered` → nothing to change (it is already `sent`). The log keeps `sent`, because "delivered"
  isn't reported by every carrier.
- `undelivered` / `failed` with `ErrorCode`:
  - `30003` (unreachable), `30005` (unknown number), `30006` (landline) → connection `invalid` after **3** such
    results within 7 days (one alone could be transient);
  - `21610` → `opted_out`;
  - other codes → the delivery's `error_code` and `error` are set for diagnosis.
- Response: `204`.

### 5.13 P1 `GET / PUT /notification-preferences` (extended v1 route)

`200`:

```json
{
  "events": {
    "assigned":       { "in_app": true, "email": true,  "telegram": true,  "sms": false, "push": true },
    "mentioned":      { "in_app": true, "email": true,  "telegram": true,  "sms": false, "push": true },
    "status_change":  { "in_app": true, "email": false, "telegram": false, "sms": false, "push": false },
    "comment":        { "in_app": true, "email": false, "telegram": true,  "sms": false, "push": true },
    "due_soon":       { "in_app": true, "email": true,  "telegram": true,  "sms": true,  "push": true },
    "sprint_started": { "in_app": true, "email": false, "telegram": false, "sms": false, "push": false }
  },
  "emailDelivery": "instant",
  "quietHours": {
    "enabled": true,
    "from": "22:00",
    "to": "08:00",
    "timezone": "America/New_York",
    "days": [true, true, true, true, true, true, true],
    "urgentBypass": true
  }
}
```

**PUT** takes the same shape, and every part is optional apart from v1's required `events` and `emailDelivery`:

- **Old clients stay correct.** For each event, only the channel keys present in the request are changed. A v1 client
  sending `{in_app, email}` doesn't reset `telegram`/`sms`/`push`. (v1 rebuilt each event from `in_app` + `email`.)
- **`quietHours`** is optional. When present, it is replaced as a whole.
- **Validation (422 `validation_failed`):**
  - `quietHours.from` / `.to` must match `^([01]\d|2[0-3]):[0-5]\d$`;
  - `from == to` → `"quietHours.to": "End must differ from start"`;
  - `timezone` must be in `zoneinfo.available_timezones()` (or `null`) → `"Unknown time zone"`;
  - `days` must be exactly 7 booleans.
- Channel toggles may be stored **on** for a channel that isn't connected (the design keeps the values and greys the
  column). Delivery checks the connection (§6.2).
- No permission beyond authentication.

**W1** (workspace responses, additive): `Workspace.notificationPolicy: { sms: boolean }`. `PATCH /workspaces/:slug`
accepts `{ "notificationPolicy": { "sms": false } }` (§4.2) alongside the v1 fields.

---

## 6. Dispatch

### 6.1 Fan-out from the outbox

Nothing changes upstream. Services still `emit()` `DomainEvent`s, and `process_event` still runs each event exactly
once (Celery, or inline after commit). The handler that changes is `notifications.handlers.deliver()`:

```python
def deliver(event, recipient, *, kind, pref, task=None, payload=None, email_template="", email_context=None,
            channel_context=None):
    prefs = preferences_for(recipient)
    row = (prefs.events or {}).get(pref, {}) if pref else {"in_app": True, "email": True}
    in_app, email = ..., ...                                   # v1, unchanged
    external = channels.dispatch.wanted(recipient, prefs, pref, event)   # §6.2; [] when pref is None
    if not in_app and not email and not external:
        return None
    notification, created = Notification.objects.get_or_create(...)     # v1, unchanged (in_app may be False)
    ...                                                                  # v1 email bookkeeping, unchanged
    if created and external:
        channels.dispatch.enqueue(notification, recipient, prefs, external,
                                  template=pref, context=channel_context, urgent=_is_urgent(task))
    return notification
```

- Each handler passes `channel_context`: the email context plus the extra tags in §6.4.
- `pref=None` events (`access`), board 40's `import` and the email-only `sprint_completed` never fan out.
- `enqueue` writes `ChannelDelivery` rows **inside `process_event`'s transaction**, and hands them to the runner in
  `transaction.on_commit`. A rolled-back event therefore sends nothing, and a crash after commit leaves `queued` rows
  that the sweeper finds (§6.7).

### 6.2 Which targets an event reaches

For a recipient and an event with preference key `pref`, a channel is **wanted** when all of these hold:

| # | Condition | Otherwise |
|---|---|---|
| 1 | `prefs.events[pref][channel]` is true | not enqueued |
| 2 | the provider is available (backend not `disabled`) | `skipped` / `unavailable` (logged once per process, not per row) |
| 3 | a connection exists and is usable: Telegram `active`; SMS `active`; Push ≥ 1 `active` subscription (**one row per subscription**) | not enqueued (no connection), or `skipped` / `opted_out` / `blocked` (connection in a bad state) |
| 4 | SMS only: `event.workspace.sms_enabled` | `skipped` / `policy` |
| 5 | SMS only: user cap and global cap not reached (§7.5), checked at **send** time | `skipped` / `cap` or `global_cap` |

Then each row gets `status = queued, next_attempt_at = now`. During quiet hours (§6.6) it gets `status = deferred,
next_attempt_at = <end of the window>` instead.

The actor never receives their own event (v1's `_recipients` already drops them), and nor do non-members.

### 6.3 Templates

Templates are Django templates in `apps/channels/templates/channels/<template>.<channel>.txt`: for example
`assigned.telegram.txt`, `assigned.sms.txt` and `assigned.push.txt`. A push template renders two blocks, `{% block
title %}` and `{% block body %}`.

- Telegram templates render with **autoescape on**. Django's escapes (`&amp; &lt; &gt; &quot; &#x27;`) are all valid in
  Telegram HTML mode. The only markup used is `<b>` and `<i>`, written in the template, never from data.
- SMS and push render with **autoescape off** (plain text), and every value passes through `plain()`. That filter
  strips control characters and collapses whitespace.
- Rendering happens **at send time** from `template` + `context`, so a template fix applies to queued rows.
- **Limits:**
  - Telegram text ≤ 4,096 chars; `task_title` is truncated to 200 and `comment_excerpt` to 140 (v1 already cuts quotes
    to 140).
  - Push: title ≤ 60 and body ≤ 160 characters, and the payload JSON ≤ 3,000 bytes before encryption.
  - SMS: ≤ 160 GSM-7 characters (one segment). See §6.5.

### 6.4 Merge tags and deep links

The tags are the email merge tags of `frontend/emails/README.md`, with the same meaning and the same values:

`cta_url`, `workspace_name`, `preferences_url`, `task_key`, `task_title`, `project_name`, `priority`, `sprint_name`,
`due_date`, `due_relative`, `assigner_name`, `author_name`, `comment_excerpt`, `sprint_start`, `sprint_end`,
`task_count`, `points_total`, `your_task_count`.

Channel-only additions:

| Tag | Value |
|---|---|
| `actor_first` | First word of the actor's name, for SMS. ASCII-folded with NFKD; dropped (with its clause) if it still contains characters outside GSM-7. |
| `from_status` / `to_status` | `status_change` payload names (v1 already stores them) |
| `project_key` | `PRJ` |
| `inbox_url` | `{FRONTEND_URL}/{slug}/inbox`, for summaries |
| `count` / `items` | summaries: number of coalesced rows, and up to 3 `{task_key, line}` lines |

Deep links are always absolute `FRONTEND_URL` URLs into routes that exist today:

| Event | `cta_url` |
|---|---|
| `assigned`, `mentioned`, `status_change`, `comment`, `due_soon` | `{FRONTEND_URL}/{slug}/tasks/{task_key}` (v1 `_task_url`) |
| `sprint_started` | `{FRONTEND_URL}/{slug}/projects/{project_key}/board` (v1 `_sprint_context`) |
| `summary` | `inbox_url` of the newest coalesced row's workspace |
| `test` | `{FRONTEND_URL}/{slug}/settings/notifications` (the workspace the user tested from, sent as `?workspace=` on C14; else `FRONTEND_URL`) |

The app already handles these routes when signed out: it signs the user in and returns them to the page.

### 6.5 Copy per event per channel

`priority` is shown only when it is High or Urgent. Telegram has an inline button, "Open PRJ-42" (or "Open board"),
with `cta_url`.

| Template | Telegram (HTML) | SMS (≤ 160, GSM-7) | Push title / body |
|---|---|---|---|
| `assigned` | `<b>PRJ-42</b> assigned to you by Alex Kim`⏎`Fix flaky board reflow`⏎`<i>Platform Rebuild · Urgent · due Oct 14</i>` | `Lightex: PRJ-42 assigned to you by Alex. https://app.lightex.dev/platform/tasks/PRJ-42 Reply STOP to opt out` | `PRJ-42 assigned to you` / `Fix flaky board reflow · from Alex Kim` |
| `mentioned` | `<b>Alex Kim</b> mentioned you on <b>PRJ-42</b>`⏎`Fix flaky board reflow`⏎`“Can you check the reflow on Safari?”` | `Lightex: Alex mentioned you on PRJ-42. <url> Reply STOP to opt out` | `Alex Kim mentioned you on PRJ-42` / `“Can you check the reflow on Safari?”` |
| `status_change` | `<b>PRJ-42</b> moved to <b>In review</b> by Sam`⏎`Fix flaky board reflow` | `Lightex: PRJ-42 moved to In review. <url> Reply STOP to opt out` | `PRJ-42 → In review` / `Fix flaky board reflow · by Sam` |
| `comment` | `<b>Sam</b> commented on <b>PRJ-42</b>`⏎`Fix flaky board reflow`⏎`“Pushed a fix, please re-test.”` | `Lightex: New comment on PRJ-42 from Sam. <url> Reply STOP to opt out` | `Sam commented on PRJ-42` / `“Pushed a fix, please re-test.”` |
| `due_soon` | `<b>PRJ-42</b> is due tomorrow`⏎`Fix flaky board reflow`⏎`<i>Platform Rebuild · Oct 14</i>` | `Lightex: PRJ-42 is due tomorrow. <url> Reply STOP to opt out` | `PRJ-42 is due tomorrow` / `Fix flaky board reflow` |
| `sprint_started` | `<b>Sprint 14</b> has started in Platform Rebuild`⏎`12 tasks · 34 points · 3 assigned to you`⏎`<i>Oct 9 – Oct 23</i>` (button "Open board") | `Lightex: Sprint 14 started in PRJ. 3 tasks are yours. <url> Reply STOP to opt out` | `Sprint 14 has started` / `Platform Rebuild · 3 tasks assigned to you` |
| `summary` | `<b>While quiet hours were on</b> · 5 updates`⏎`• PRJ-42 assigned to you`⏎`• PRJ-7 is due today`⏎`• PRJ-19 · Sam commented`⏎`+2 more` (button "Open inbox") | `Lightex: 5 updates while quiet hours were on. <inbox_url> Reply STOP to opt out` | `5 updates while quiet hours were on` / `PRJ-42 assigned to you · PRJ-7 is due today · +3 more` |
| `test` | `<b>Test notification</b>`⏎`Lightex notifications will arrive in this chat.` | `Lightex: test message. SMS notifications are on. Reply STOP to opt out` | `Test notification` / `Lightex notifications will appear on this device.` |
| `otp` (SMS only) | — | `Lightex code: 482913. It expires in 10 minutes. Don't share it.`⏎⏎`@app.lightex.dev #482913` | — |

**SMS privacy rule (decided).** An SMS never contains the task **title**, comment text, project name or any field
value. It contains only the product name, the task key, the event, the actor's first name, sprint names and the link.
The task title is user content, and SMS crosses carriers in clear text and shows on locked screens. The design agrees:
its SMS preview is "PRJ-42 test: assigned to you. Reply STOP to mute", with no title. Telegram and Push carry the
title and the 140-character excerpt, like the v1 emails: Push is end-to-end encrypted to the browser, and Telegram is
the user's own chat.

**SMS length rule.** The rendered text is measured in GSM-7 septets. When it is over 160:

1. drop `by {actor_first}`;
2. if it is still too long, send it anyway as a 2-segment message;
3. never more than 2 segments (a long `FRONTEND_URL` is the only realistic cause, and is caught by a startup
   warning).

The OTP's last line is the WebOTP origin-bound format (`@<frontend host> #<code>`), so Chrome on Android can autofill.
iOS/Safari autofill uses `autocomplete="one-time-code"` (§8.4).

**Push payload** (JSON, encrypted):

```json
{ "v": 1, "title": "PRJ-42 assigned to you", "body": "Fix flaky board reflow · from Alex Kim",
  "url": "https://app.lightex.dev/platform/tasks/PRJ-42", "tag": "task:5f0e…", "kind": "assigned",
  "ts": "2026-10-09T09:15:03Z" }
```

- **Headers:**
  - `TTL`: 86,400 for events, 3,600 for tests;
  - `Urgency`: `high` for urgent tasks and mentions, `normal` otherwise;
  - `Topic`: the first 32 base64url characters of `sha256(tag)`, so a newer push replaces an older undelivered one
    about the same task.
- The service worker uses `tag` the same way for notifications already on screen.

### 6.6 Quiet hours

- **Scope.** Quiet hours hold **Telegram, SMS and Push** only. In-app rows are never held. Email keeps v1's own
  delivery setting. Tests ignore quiet hours.
- **Active only when** `quiet_enabled` is set, `timezone` is not null, `from != to`, and at least one day is selected.
- **The window, in the user's time zone** (`zoneinfo`), for instant `t`:
  - `local = t.astimezone(tz)`; `m = local.hour * 60 + local.minute`; `wd = local.weekday()` (Mon = 0).
  - **Same-day window** (`from < to`): quiet when `days[wd]` and `from ≤ m < to`.
  - **Overnight window** (`from > to`): quiet when `days[wd]` and `m ≥ from`, or when `days[(wd − 1) % 7]` and
    `m < to`. **A day toggle means "the window that starts on this day":** the design's Mon–Fri 22:00–08:00 covers Mon
    night → Tue morning … Fri night → Sat morning.
- **End of the window** (`next_attempt_at`): the next local `to` after `t` on the matching date, converted to UTC with
  `fold=0`.
  - A `to` that falls in a DST gap moves to the first valid minute after it.
  - In a DST overlap, the first occurrence is used.
  - The end gets 0–120 s of jitter (per user, from the user id), so not every summary leaves at 08:00:00.
- **Urgent bypass.** When `urgentBypass` is set and the event's task has priority 4 (Urgent) **at enqueue**, the row
  is `queued` immediately. Events without a task (`sprint_started`) are never urgent.
- **Release and summary.** When the sweeper picks up `deferred` rows that are due, it groups them by (user, channel,
  target):
  - **1 row:** send it as it is.
  - **2 or more:** create one `kind = "summary"` delivery (template `summary`, `context.count`, up to 3 lines from the
    newest rows, `inbox_url` from the newest row's workspace), and mark the originals `coalesced` with `summary` set.
    The summary counts as **one** SMS for the caps.
- **Changing quiet hours.** Saving new quiet hours (PUT P1) re-computes `next_attempt_at` for the user's `deferred`
  rows. Turning quiet hours off releases them now, which still produces a summary when there are several.
- **Too old to matter.** A `deferred` row older than 24 h when released is `skipped` (`stale`). It can't happen with
  windows under 24 h, but it guards against clock or time-zone edits.

### 6.7 Running without Redis (and with it)

| `CHANNEL_DISPATCH` | When | How rows are sent |
|---|---|---|
| `celery` | `REDIS_URL` set (`auto`) | `send_delivery.delay(id)` per row. A retry is `apply_async(countdown=…)`. A worker process runs the sends. |
| `thread` | no broker (`auto`; the Render free blueprint) | A **per-process `ThreadPoolExecutor(CHANNEL_SENDER_THREADS)`**, started lazily. `on_commit` submits the row ids. Request threads never wait on providers. Sends no longer happen inline, unlike v1's inline email sending. |
| `inline` | tests | synchronous on commit |

**Claiming a row (every mode).** Exactly one sender wins a row:

```sql
UPDATE channels_channeldelivery
   SET status = 'sending', lease_until = now() + interval '120 seconds', attempts = attempts + 1
 WHERE id = :id AND status IN ('queued','retry') AND next_attempt_at <= now()
```

- Zero rows means someone else has it, or it is done: exit.
- The send then runs **outside** any transaction, and the result is written in a short second transaction.
- A thread closes its DB connection when it finishes (`connection.close()`).

**Sweeper** (thread mode only; Celery deployments run `send_channel_deliveries` from cron or beat instead):

- **It is event-driven, so an idle app costs no queries.** One daemon thread per web process, started from
  `gunicorn.conf.py` `post_worker_init` (the file board 33 introduces; created here if 33 isn't built yet). It keeps
  `next_due` in memory: the earliest `next_attempt_at` it has scheduled or seen. It sleeps on a `Condition` until
  `next_due`, or until `enqueue` notifies it about an earlier time.
  - With nothing pending it issues **no queries**, so Neon's compute can still scale to zero.
  - It runs one sweep at process start, to pick up rows left by a previous process.
- **A sweep:** `SELECT id FROM … WHERE (status IN ('queued','retry','deferred') AND next_attempt_at <= now()) OR
  (status = 'sending' AND lease_until < now()) ORDER BY next_attempt_at LIMIT 100 FOR UPDATE SKIP LOCKED`. In the same
  transaction:
  - `deferred` rows → coalesce (§6.6) → `queued`;
  - expired `sending` leases → `retry`.

  It commits, submits the ids to the pool, then reads `min(next_attempt_at)` of the remaining rows for the next wake.
  Several processes can sweep at the same time safely (SKIP LOCKED plus the claim).
- **Safety net:** `python manage.py send_channel_deliveries` (cron every 5 min, §2.6 A7) runs one sweep and sends
  inline. Without it, rows scheduled by a process that has since died are sent at the next process start.
  - On the free plan, an instance asleep at 08:00 sends its quiet-hours summaries when the next request (or Telegram
    webhook) wakes it. This is documented as a known limit.

**Re-checks at send time.** Before calling the provider:

- the recipient is active;
- for events: the recipient is still a member of the notification's project, the project and task aren't deleted, and
  the workspace isn't deleted;
- the connection still exists and is usable;
- the SMS policy and caps (§7.5).

Any failure → `skipped` with the matching reason. This matters for rows deferred by quiet hours.

### 6.8 Results, retries and the dead letter

The backoff after attempt *n* is `[30 s, 2 min, 10 min, 1 h, 6 h][n-1]` × (0.8–1.2 jitter). A provider `retry_after`
wins when it is longer. After `CHANNEL_MAX_ATTEMPTS` (5) failed attempts the row becomes **`dead`**.

| Outcome | Delivery | Connection |
|---|---|---|
| ok | `sent`, `sent_at`, `provider_id` | Push: `last_success_at`, `failure_count = 0` |
| transient (timeout, 5xx, 429, network) | `retry` + backoff, or `dead` when attempts run out | Push: `failure_count += 1` |
| permanent, target-specific | `failed` (no retry) | see the table below |
| permanent, configuration (bad token, VAPID mismatch on every subscription, Twilio auth 20003) | `failed`, `error_code = "config_error"` | none. Logged at ERROR **once per process per 10 min**, so a bad key doesn't flood the log. |

Provider mapping:

| Provider response | `reason` | Permanent | Connection effect |
|---|---|---|---|
| Telegram 403 "bot was blocked by the user" / "user is deactivated" | `blocked` | yes | `status = blocked`, `last_error` |
| Telegram 400 "chat not found" | `blocked` | yes | same |
| Telegram 429 `parameters.retry_after` | `rate_limited` | no | — |
| Telegram 401 / 404 (bad token) | `config_error` | yes | — |
| Twilio `21610` (unsubscribed) | `opted_out` | yes | `status = opted_out` |
| Twilio `21211` / `21614` (invalid / not mobile) | `invalid_number` | yes | `status = invalid` |
| Twilio `21408` (region not enabled), `20003` (auth) | `config_error` | yes | — |
| Twilio 429 / `20429` / 5xx | `rate_limited` / `provider_error` | no | — |
| Push 201 / 202 | ok | | |
| Push 404 / 410 | `expired_subscription` | yes | subscription `expired` |
| Push 403 / 400 with a VAPID or JWT error | `config_error` (all subscriptions) or `expired_subscription` (created under an old key) | yes | subscription `expired` |
| Push 413 | `provider_error` (payload too large: a bug) | yes | — |
| Push 429 (with `Retry-After`) / 5xx | `rate_limited` / `provider_error` | no | `failure_count += 1`; at **10** consecutive the subscription becomes `expired` |

**Dead letter operations** (`python manage.py channel_deliveries`):

- `--dead [--since 7d]` lists dead rows: id, user id, channel, template, error code. **No message text, no phone.**
- `--retry <id>` or `--retry-dead --since 1d` puts rows back to `queued` with `attempts = 0`.
- Django admin (dev only, as in v1) has a read-only `ChannelDelivery` list.

No end-user UI shows the log. The UI shows the connection state (`lastError`, `status`), which is what users can act
on (§8.3).

### 6.9 Telegram and Twilio throughput

- Telegram allows about 30 messages/s per bot and 1/s per chat. The sender takes a per-process token bucket of 25/s
  per bot. A 429 for one chat doesn't block the others.
- Twilio queues messages itself (Messaging Service). Sends are plain POSTs; there is no bucket beyond the caps.

### 6.10 Retention (the `purge_trash` command gains these)

| Rows | Kept |
|---|---|
| `ChannelDelivery` `sent` / `skipped` / `coalesced` / `failed` | 30 days |
| `ChannelDelivery` `dead` | 30 days |
| `TelegramLinkRequest` that aren't pending; `SmsVerification` that aren't pending | 1 day |
| `OtpSend` | 2 days (the daily limit needs 24 h) |
| `PushSubscription` `expired` | 7 days |

---

## 7. Security and privacy

### 7.1 Phone numbers

- **Stored encrypted:** `phone_enc` = `MultiFernet(CHANNELS_ENCRYPTION_KEY…)`.encrypt(E.164).
- **Lookups** (STOP, status callbacks, the per-phone OTP limit) use `phone_hash` = HMAC-SHA256(key = HKDF(primary
  Fernet key, info = `"lightex.phone"`), E.164).
- **Rotation:** `python manage.py rotate_channels_key` re-encrypts and re-hashes every row after a new key is put first
  in the list.
- **Returned only to the owner,** in C1/C6/C8. Admins never see members' phones. No endpoint lists them, and audit and
  activity never mention them.
- **Logs and errors** use `mask(e164)` = `+1•••••0132`. A logging filter on `lightex.channels` rejects any record whose
  message matches `\+\d{8,15}` (defence in depth). The audit scrubber's `_SECRET` pattern is unchanged; channels write
  no audit rows apart from the workspace policy.
- **Deleting a user** cascades every channel row.

### 7.2 Codes and tokens

| Secret | Entropy | Stored as | Lifetime | Guessing limits |
|---|---|---|---|---|
| SMS OTP | 6 digits (`secrets.randbelow(10**6)`, zero-padded) | HMAC-SHA256(key = HKDF(`SECRET_KEY`, `"lightex.otp"`), `"{verification_id}:{code}"`) | 10 min, single use | 3 attempts per code; 5 sends per hour per user (§7.5) |
| Telegram code | 6 of 30 symbols ≈ 29 bits | HMAC-SHA256(key = HKDF(`SECRET_KEY`, `"lightex.tglink"`), code) | 10 min, single use | 5 wrong codes per chat per hour, then 1 h of silence; at most 1 pending per user |
| Telegram deep-link token | 256 bits | SHA-256 | 10 min, single use | — |
| Webhook secret | ≥ 256 bits | env | static | constant-time compare |

Codes, tokens and OTPs never appear in logs, in the outbox (`DomainEvent.payload`) or in `ChannelDelivery.context`.
The OTP and link messages are sent directly by the service, like v1's invitation and reset emails (§2.2 of the backend
final report). The only exception is the `console` backend in dev, which logs the OTP and refuses to run in prod.

**Telegram link hijack.** An attacker could link *their* chat to a victim's account and receive the victim's
notifications. Defences:

1. The code exists only while the victim's dialog is open (at most 10 min, one pending per user).
2. A brute-force attacker gets 5 guesses per hour per chat at a 1-in-~729 M code.
3. The dialog shows **"Connected as @username"**, so a wrong account is visible at once and Disconnect is one click.
4. C2 refuses to replace an `active` connection (409), so a stale QR can't swap chats silently.

### 7.3 Webhook verification

| Webhook | Check | On failure |
|---|---|---|
| Telegram | `X-Telegram-Bot-Api-Secret-Token` == `TELEGRAM_WEBHOOK_SECRET` (set via `setWebhook secret_token`) | 401, logged with IP; no body parsing |
| Twilio inbound and status | `X-Twilio-Signature` HMAC-SHA1 over `API_PUBLIC_URL` + path + sorted form params (Twilio's algorithm) | 403 |

All three run DRF `AllowAny` with **no authentication classes** (so no JWT parsing and no CSRF/Origin check), have
their own throttle (`THROTTLE_WEBHOOK`, per IP), and are exempt from the default `anon` throttle. Telegram's source
IPs aren't checked; the secret header is enough.

### 7.4 Unsubscribe and opt-out flows

| Channel | User action | Effect |
|---|---|---|
| SMS | Reply **STOP** (or STOPALL, UNSUBSCRIBE, CANCEL, END, QUIT) | Twilio blocks further sends at the carrier level. H2 marks the connection `opted_out`. The UI shows "You replied STOP · text START to resume" and Remove. Every notification SMS ends with "Reply STOP to opt out". |
| SMS | Reply **START** | Connection `active` again |
| SMS | Remove in settings (C9) | Number deleted |
| Telegram | `/stop` or block the bot | `/stop` deletes the connection; blocking marks it `blocked` |
| Telegram | Disconnect in settings (C5) | deleted; the bot says goodbye |
| Push | Turn off (C12 + `subscription.unsubscribe()`), browser site settings, or logout | row deleted, or `expired` at the next send (410) |
| Email | v1: the footer link opens preferences (no one-click token in v1) | unchanged |
| Any | Matrix toggles | per event, per channel |

### 7.5 Rate limits and SMS cost control

Limits that cost money are counted **in Postgres**, not in the DRF cache. The cache is per process without Redis
(backend final report §5).

| Limit | Default | Counted from | Error |
|---|---|---|---|
| OTP resend cooldown | 30 s | `SmsVerification.resend_at` | 429 `resend_cooldown` |
| OTP sends per user | 5 / hour, 10 / UTC day | `OtpSend` rows | 429 `hourly_limit` / `daily_limit` |
| OTP sends per phone number (across users) | 5 / hour | `OtpSend.phone_hash` | 429 `phone_limit` |
| OTP sends, all users | `SMS_OTP_GLOBAL_DAILY_CAP` = 100 / UTC day | `OtpSend` | 429 `global_limit`; ERROR log |
| OTP verify attempts | 3 per code | row lock | 422 `too_many_attempts` |
| Notification SMS per user | `SMS_USER_DAILY_CAP` = 10 / UTC day | `ChannelDelivery` (sms, `sending`/`sent`/`retry`, today) | delivery `skipped` / `cap` (at most one WARNING log per user per day) |
| Notification SMS, all users | `SMS_GLOBAL_DAILY_CAP` = 300 / UTC day | same, all users | `skipped` / `global_cap`; ERROR log once per day |
| Tests | 12 / hour per user (DRF `channel_test`) + the SMS user cap | | 429 |
| Connect calls | 20 / hour per user (DRF `channel_connect`) | | 429 |
| Telegram wrong codes | 5 / hour per chat | cache + `TelegramLinkFailure` rows | silence |

**SMS pumping.** Registration in v1 has no email verification, so a bot can create accounts and request OTPs to
premium numbers. The defences, in order:

1. the country allow-list, with mobile prefixes only (§5.6);
2. the global OTP cap;
3. the per-phone limit;
4. Twilio Geo permissions limited to the same countries (§2.6 A2).

§11 #1 covers Twilio Verify's fraud guard as an upgrade.

### 7.6 Other

- **Push privacy.** Payloads are encrypted end to end, so push services can't read them. Lock screens show title and
  body, the same as email previews.
- **Shared browsers.** Logout removes this browser's subscription (§8.6). After a session simply expires, the next
  user's sync of the same browser either takes the subscription over (if they enable push) or drops it (`refresh` →
  404 → local unsubscribe). Only notifications sent in between can reach the old user's browser.
- **The service worker** only opens same-origin URLs (it checks `new URL(url).origin === self.location.origin`).
  Anything else opens `/`, so a payload can't be turned into an open redirect.
- **No new CORS origins;** webhooks are server to server.

---

## 8. Frontend

### 8.1 Paper trail (rules from `frontend/CLAUDE.md`)

- In `frontend/CLAUDE.md`, move board 38 from "Planned next" to "In scope", built from
  `docs/v2/38-telegram-sms-push.md`.
- Under "Requested API additions" in `frontend/docs/final-report.md`, add C1–C14, the P1 extension and W1.
- Add `uqr` to §2 "Dependencies" (§8.10) and every §10 conflict to "Conflicts".

### 8.2 `src/lib/api/types.ts`

```ts
export type ExternalChannel = "telegram" | "sms" | "push";
export type NotificationChannel = "in_app" | "email" | ExternalChannel;   // widened from v1

export interface QuietHours {
  enabled: boolean;
  from: string;               // "22:00"
  to: string;                 // "08:00"
  timezone: string | null;    // IANA; null until first set
  days: [boolean, boolean, boolean, boolean, boolean, boolean, boolean];  // Mon..Sun
  urgentBypass: boolean;
}

export interface NotificationPreferences {
  events: Record<NotificationEvent, Record<NotificationChannel, boolean>>;
  emailDelivery: "instant" | "hourly" | "daily";
  quietHours: QuietHours;
}

export interface TelegramConnection { id: ID; username: string | null; firstName: string; status: "active" | "blocked"; connectedAt: ISODateTime; lastError: string | null }
export interface SmsConnection { id: ID; phoneNumber: string; display: string; country: string; status: "active" | "opted_out" | "invalid"; verifiedAt: ISODateTime; lastError: string | null }
export interface PushDevice { id: ID; label: string; endpointHash: string; status: "active" | "expired"; createdAt: ISODateTime; lastSeenAt: ISODateTime; lastSuccessAt: ISODateTime | null }
export interface SmsCountry { code: string; dial: string; label: string; digits: number; pattern: string }

export interface NotificationChannels {
  email: { address: string };
  telegram: { available: boolean; botUsername: string | null; connection: TelegramConnection | null };
  sms: { available: boolean; countries: SmsCountry[]; connection: SmsConnection | null; dailyCap: number; sentToday: number };
  push: { available: boolean; vapidPublicKey: string | null; devices: PushDevice[] };
}

export interface TelegramLink {
  id: ID;
  status: "pending" | "linked" | "expired" | "canceled";
  code?: string;              // only while pending
  deepLink?: string;          // only while pending
  botUsername: string;
  expiresAt: ISODateTime;
  connection: TelegramConnection | null;
}

export interface SmsVerification { id: ID; phoneNumber: string; display: string; expiresAt: ISODateTime; resendAt: ISODateTime; attemptsLeft: number }

export interface PushSubscriptionInput {
  mode: "subscribe" | "refresh";
  subscription: { endpoint: string; expirationTime: number | null; keys: { p256dh: string; auth: string } };
  timezone?: string;
}

export interface ChannelTestResult { channel: "email" | ExternalChannel; status: "sent"; deliveryId: ID; sentAt: ISODateTime }

// Workspace (additive, optional so older payloads still parse)
export interface Workspace { /* v1 fields … */ notificationPolicy?: { sms: boolean } }
```

### 8.3 `src/lib/api/endpoints.ts`

```ts
export const channels = {
  get: () => http.get<NotificationChannels>("/me/notification-channels"),
  startTelegram: (timezone?: string) => http.post<TelegramLink>("/me/notification-channels/telegram/link", { timezone }),
  telegramLink: (id: string) => http.get<TelegramLink>(`/me/notification-channels/telegram/link/${enc(id)}`),
  cancelTelegram: (id: string) => http.del(`/me/notification-channels/telegram/link/${enc(id)}`),
  disconnectTelegram: () => http.del("/me/notification-channels/telegram"),
  startSms: (body: { country: string; nationalNumber: string; timezone?: string }) =>
    http.post<SmsVerification>("/me/notification-channels/sms/verifications", body),
  resendSms: (id: string) => http.post<SmsVerification>(`/me/notification-channels/sms/verifications/${enc(id)}/resend`),
  verifySms: (id: string, code: string) =>
    http.post<{ connection: SmsConnection }>(`/me/notification-channels/sms/verifications/${enc(id)}/verify`, { code }),
  removeSms: () => http.del("/me/notification-channels/sms"),
  vapidKey: () => http.get<{ publicKey: string }>("/push/vapid-public-key", undefined, { anonymous: true }),
  savePush: (body: PushSubscriptionInput) => http.put<PushDevice>("/me/push-subscriptions", body),
  removePushByEndpoint: (endpoint: string) => http.post<void>("/me/push-subscriptions/remove", { endpoint }),
  removePushDevice: (id: string) => http.del(`/me/push-subscriptions/${enc(id)}`),
  test: (channel: "email" | ExternalChannel, body?: { deviceId?: string; workspace?: string }) =>
    http.post<ChannelTestResult>(`/me/notification-channels/${channel}/test`, body ?? {}),
};
// add `channels` to the exported `api` object; `workspaces.update` body gains `notificationPolicy?: { sms: boolean }`.
```

`api.notifications.preferences` / `savePreferences` are unchanged in signature; the type widens.

### 8.4 `src/lib/api/query-keys.ts`

```ts
channels: () => ["notification-channels"] as const,
telegramLink: (id: string) => ["notification-channels", "telegram-link", id] as const,
// existing: prefs: () => ["notification-prefs"]
```

| Event | Invalidate |
|---|---|
| connect, disconnect, verify, push change, test failure | `qk.channels()` |
| Telegram linked | `qk.channels()`; drop `qk.telegramLink(id)` |
| SMS policy switch | `qk.workspace(slug)` (optimistic) |

### 8.5 Screens and components (`src/features/notifications/`)

The existing `preferences.tsx` becomes the page shell. New folder `channels/`:

| File | Content |
|---|---|
| `channels-section.tsx` | The **Channels** list (design `.ch-list`) and the admin policy row. |
| `channel-row.tsx` | Icon, name, status glyph and text, actions. |
| `preferences-matrix.tsx` | `PreferencesMatrix` (moved). 5 live columns. A column whose channel isn't usable is hatched, with dashed `tg-off` cells (`role="img"`, `aria-label="Mentioned, Telegram: not connected"`). Header link **Connect** (opens the flow), **Off by admin**, or **Blocked** (push, permission `denied`). At ≤ 760 px: short labels App/Mail/TG/SMS/Push, no icons (design `.narrow`). |
| `quiet-hours.tsx` | The card, From/To `<input type="time">`, the time zone select, `QuietBar` (segments), day toggles (`aria-pressed`), urgent switch. |
| `quiet.ts` | Pure: `segments(from, to)`, `summary(q, tzLabel)` → `22:00–08:00 · Mon–Fri · New York` (design `daysLabel`: every day / no days / Mon–Fri / weekends / `Mo We Fr`), `tzLabel(iana)` via `Intl.DateTimeFormat(…, { timeZoneName: "shortOffset" })` → `New York · GMT−4`. |
| `telegram-dialog.tsx` | Lazily loaded (`lazyWithPreload`; it pulls `uqr`). |
| `qr.tsx` | `uqr.encode(deepLink, { ecc: "M", border: 1 })` → one `<path>` of `M x y h1v1h-1z` runs inside `<svg viewBox>` on a white tile (design `.ch-qr`). React elements only, no `innerHTML`. |
| `sms-dialog.tsx` | Phone step + OTP step + verified step. |
| `otp-input.tsx` | 6 boxes, the design's behaviour (below). |
| `phone.ts` | Pure: `formatNational(digits, pattern)`, `digitsOnly`, `isComplete(country, digits)`. |
| `push.ts` | `PushPlatform` interface + browser implementation + mock implementation (§8.6). |
| `push-card.tsx` | The design's "Browser push" card, used inside the Push row's expanded state at 390 px and in the "Enable" flow. |
| `test-preview.tsx` | The device-style preview card (design `.ch-pv`, top right, 4 s) + toast "Test sent · Telegram". |
| `devices-menu.tsx` | Push device list (Menu) from the status text "+2 devices" (§10 #8). |

**Channel rows** (status text and actions):

| Channel | State | Status (glyph) | Actions |
|---|---|---|---|
| In-app | always | ✓ "Always on" | Send test (client-only preview) |
| Email | always | ✓ `alex@team.dev` (mono) | Send test (C14 `email`) |
| Telegram | not connected | dashed "Not connected" | **Connect** |
| | dialog open | spinner "Waiting…" | — |
| | active | ✓ `@alexkim` (mono), or the first name | Send test · × "Disconnect Telegram" |
| | blocked | ⚠ "Bot blocked in Telegram" (red) | **Reconnect** · × |
| | unavailable | dashed "Not available on this server" | — |
| SMS | policy off (current workspace) | dashed "Off by admin" | × only if a number is connected |
| | not connected | dashed "Not connected" | **Connect** |
| | active | ✓ `+1 (415) 555-0132` (mono) | Send test · × "Disconnect SMS" |
| | opted_out | ⚠ "Replied STOP · text START to resume" | × |
| | invalid | ⚠ "Number can't receive SMS" | **Connect** (replace) · × |
| Push | unsupported | dashed "Not supported in this browser" (iOS: "Add Lightex to your Home Screen to enable push") | — |
| | off (this browser) | dashed "Off" (+ " · 2 other devices" when there are any) | **Enable** |
| | prompt | spinner "Waiting for browser…" | — |
| | on (this browser) | ✓ "This browser" (+ " · 2 more devices") | Send test · × "Turn off push in this browser" |
| | blocked (`Notification.permission === "denied"`) | ⚠ "Blocked in browser" | **Check again** |

The admin row ("SMS for {workspace.name}", `admin` tag, switch) renders only with `workspace.update` in
`my_permissions`. Toggling it is an optimistic workspace PATCH, with rollback and a toast.

**Telegram dialog** (Modal, 380 px; a bottom sheet at ≤ 760 px):

1. **Open:** C2 with the browser time zone → QR + code + "or send to @{botUsername}".
2. **On touch devices** (`(pointer: coarse)`): a primary **Open Telegram** button (`<a href={deepLink}
   target="_blank" rel="noopener noreferrer">`) above the QR (§10 #2).
3. **Copy:** the copy button writes the code; the check shows for 1.4 s.
4. **Waiting:** "Waiting for confirmation…" with a countdown from `expiresAt` (server time, client clock skew ignored),
   warn tone at ≤ 60 s.
5. **Polling:** C3 every 2 s while visible.
6. **Expired:** blurred QR, "Expired", struck-through code, "Code expired" (`role=alert`), **New code** → C2 again.
7. **Linked:** spark check, "Connected as @alexkim", **Send test**, **Done**.
8. **Close** (× or Escape) before linking → C4. Escape closes the dialog first (design `mainKey`).

**SMS dialog:**

1. **Phone step.** Country select (from C1 `countries`), and an input that formats as you type with the country
   pattern (placeholder = the pattern with 0s). Help text: `10 digits` → `Valid number` (green) → error. Enter or
   **Send code** → C6. Changing country clears the number.
2. **OTP step.** "Code sent to `+1 (415) 555-0132` · Edit" (Edit returns to step 1 with the number kept). Six boxes:
   - Box 1 has `autocomplete="one-time-code"`, the others `off`; all have `inputmode="numeric"`.
   - Typing a digit moves on.
   - Pasting or autofilling 3 or more digits spreads them from the box (6 digits start at box 1).
   - Backspace in an empty box clears and focuses the previous one; ← and → move.
   - All 6 filled → C8 automatically ("Verifying…", boxes dimmed and read-only).
   - Error → `role=alert` text, shake (transform only; none with reduced motion), boxes cleared, focus on box 1.
   - "Resend in 0:24" counts down from `resendAt`, then **Resend code** → C7 (tries reset, toast "Code resent").
3. **Verified.** Spark check, "`+1 (415) 555-0132` verified", Send test, Done.
4. **Close** before verifying: nothing to call. The pending verification expires on its own; the next C6 cancels it.

**Send test.** The button shows a spinner and calls C14. On 200: toast "Test sent · {Channel}" plus the preview card
for that channel (design `PV` table: app name, sender, "now", title, body, using the `test` copy of §6.5). On error:
error toast with the §5.11 copy. In-app shows only the preview (no request).

**Matrix saves.** These are v1's: optimistic `setQueryData`, a 400 ms debounce, "Saving / Saved" in the header, and
rollback with a toast. Quiet-hours changes go through the same `commit()`. The time inputs commit on `change` (blur or
picker), not on every keystroke.

**States.** Loading: the design's skeleton (5 channel rows and 4 matrix rows). C1 and P1 load in parallel, and the page
shows its error state if either fails. A C1 failure alone keeps the matrix usable, with external columns shown as
"Unavailable · Retry". The page works at 390 px (design Mobile frame: no settings nav, a top bar with back, 44 px
touch targets) and in all three themes, using token classes only.

### 8.6 Push in the browser: service worker, subscription lifecycle

**File location (Next 16).** The service worker is a plain static file, **`frontend/public/sw.js`**, served at
`/sw.js` with scope `/`.

- It is **not** bundled. The PWA guide's `new URL('../lib/service-worker.js', import.meta.url)` would give a hashed
  `/_next/static/…` URL, which can't control scope `/` without a `Service-Worker-Allowed` header, and which changes
  every build.
- It has no imports. It is ES2020, with a `const SW_VERSION = "38.1"` comment line that is bumped on change.
- It has **no `fetch` listener**: no caching and no offline behaviour, so it can't interfere with the app or the mock.

```js
// public/sw.js (complete listener set)
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { /* malformed: still must show something */ }
  const title = typeof d.title === "string" ? d.title.slice(0, 80) : "Lightex";
  e.waitUntil(self.registration.showNotification(title, {
    body: typeof d.body === "string" ? d.body.slice(0, 200) : "",
    icon: "/icon-512.png", badge: "/push-badge.png",
    tag: d.tag || undefined, renotify: Boolean(d.tag),
    timestamp: d.ts ? Date.parse(d.ts) : Date.now(),
    data: { url: safeUrl(d.url) },
  }));
});
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = e.notification.data && e.notification.data.url || "/";
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const same = wins.find((w) => new URL(w.url).origin === self.location.origin);
    if (same) { await same.focus(); same.postMessage({ type: "lightex:navigate", url }); return; }
    await self.clients.openWindow(url);
  })());
});
self.addEventListener("pushsubscriptionchange", (e) => {
  // No token here: ask an open tab to re-sync; otherwise the next app load does (§8.6 sync).
  e.waitUntil(self.clients.matchAll({ type: "window" }).then((ws) => ws.forEach((w) => w.postMessage({ type: "lightex:push-resync" }))));
});
function safeUrl(u) { try { const x = new URL(u, self.location.origin); return x.origin === self.location.origin ? x.href : "/"; } catch { return "/"; } }
```

- **Navigation from a click.** The app listens for `lightex:navigate` in `Providers` and calls `pushUrl` (a same-route
  query change) or `router.push` (a different route). This is the one place `router.push` is right, because it is a
  real route change.
- **New asset:** `public/push-badge.png`, a 96×96 monochrome logo glyph for Android's status bar.

**`next.config.ts` headers.** Add a rule **after** the `/:path*` rule (the later rule wins for the same key):

```ts
{
  source: "/sw.js",
  headers: [
    { key: "Content-Type", value: "application/javascript; charset=utf-8" },
    { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
    { key: "Content-Security-Policy", value: "default-src 'self'; script-src 'self'" },
  ],
}
```

The page CSP needs **no change**:

- `worker-src` falls back to `script-src` → `'self'`;
- push services are contacted by the browser, not by page JS, so `connect-src` is unaffected;
- the QR is inline SVG elements;
- `t.me` links are navigations.

`Permissions-Policy` is unchanged (notifications aren't a policy feature).

**`PushPlatform` (`push.ts`):**

```ts
interface PushPlatform {
  support(): "supported" | "unsupported" | "ios-needs-install";
  permission(): NotificationPermission;              // "default" | "granted" | "denied"
  current(): Promise<PushSubscriptionJSON | null>;   // this browser's subscription
  subscribe(vapidKey: string): Promise<PushSubscriptionJSON>;  // requests permission inside the click
  unsubscribe(): Promise<void>;
  showLocal(title: string, body: string): Promise<void>;       // mock tests
}
```

**Support detection.** `"serviceWorker" in navigator && "PushManager" in window && "Notification" in window`. On iOS
or iPadOS, when not running standalone (`!matchMedia("(display-mode: standalone)").matches`), the result is
`ios-needs-install`. The web manifest already has `display: "standalone"` (`src/app/manifest.ts`).

**Enable** (click, the user gesture):

1. `Notification.requestPermission()`. The row shows "Waiting for browser…".
2. `denied` → Blocked state. `default` (dismissed) → back to Off.
3. `granted`:
   - `navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" })`, then `ready`;
   - `pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8Array(vapidPublicKey) })`;
   - C11 `mode: "subscribe"` with the browser time zone;
   - toast "Push enabled", then invalidate `qk.channels()`.
4. If C11 fails: `subscription.unsubscribe()` and an error toast.

**Turn off:** C12 with the endpoint, then `subscription.unsubscribe()`. Unsubscribing locally happens even if C12
fails (the server row then expires at the next send).

**Check again:** re-read `Notification.permission`: `denied` → toast "Still blocked in browser" (design); `default` →
Off; `granted` → run Enable from the subscribe step.

**"This browser".** Compute `sha256(endpoint)` (SubtleCrypto) and compare its first 16 hex characters with
`devices[].endpointHash`.

**Sync on app load** (`usePushSync()`, mounted once in the workspace shell, at most once per tab session):

- if permission is `granted` and a subscription exists:
  - if its `applicationServerKey` differs from the server key → `unsubscribe()` + `subscribe()` + C11 `subscribe`
    (key rotation);
  - otherwise C11 `mode: "refresh"`; a 404 → `subscription.unsubscribe()` (this browser belongs to another account,
    or was turned off elsewhere).
- also runs on the SW message `lightex:push-resync`.

**Logout** (`features/auth/session.tsx`): **before** `api.auth.logout()` (which is anonymous), if a subscription
exists: C12 with the endpoint, then `unsubscribe()`. Errors are ignored, and logout never waits more than 1.5 s for
this.

### 8.7 Freshness

- Telegram link: C3 polling at 2 s (§8.5).
- C1 `staleTime` 30 s; refetch on window focus (v1 rule). That covers STOP and blocked-bot changes made outside the
  app.
- **Board 33 SSE (optional).** If the stream exists, the server also publishes a durable, user-targeted
  `channels.changed` `{ channel, op: "linked" | "disconnected" | "status" }` (protocol v1; additive, and clients ignore
  unknown types). The client invalidates `qk.channels()` and, if a link dialog is open, refetches C3 at once. Polling
  stays as the fallback.

### 8.8 Mock backend

`src/lib/mock/handlers/channels.ts` exports `registerChannels()`, called from `mock/transport.ts`. New **optional** DB
collections are added by `ensureExt38(db)`, following the `ensureExt39` pattern, with **no `SCHEMA` bump**:
`channelConnections`, `telegramLinks`, `smsVerifications`, `pushDevices`, and `workspaces[].smsEnabled`.

| Route | Mock behaviour |
|---|---|
| C1 | Built from the DB. `available` is always true. Countries: the server table with `IN` included (the design shows four). `vapidPublicKey`: a fixed real P-256 public key constant. |
| C2 | Code from the design's list (`K7MQ2X`, `R4TZ9P`, `B8WN3H`, `J2XC7V`, rotating), `deepLink` `https://t.me/lightex_bot?start=lx_mock…`, TTL 600 s. **Simulated scan:** the link becomes `linked` **5 s** after creation (`@alexkim`-style username from the user's name; `u_alex` → `alexkim`), unless mock control "Telegram: manual" is on. Then clicking the QR in mock mode (`data-mock-scan`) links it at once (design "click QR to simulate a scan"). |
| C3–C5 | As specified. |
| C6–C9 | Code is always **`482913`** (design). A dev-only toast "Mock SMS · code 482913" is shown via `mockBus`. Tries, cooldown and limits are enforced with the same numbers. `5550000` numbers return 502 `invalid_number` (for the error state). |
| C10–C13 | As specified; no real push. |
| C14 | Returns `sent` after the usual latency. For `push`, the mock calls `PushPlatform.showLocal()` so a real OS notification appears through the registered SW. Mock control "Channel failures" makes the next test return the 502 for that channel. |
| P1 | Accepts the new keys and `quietHours`, merges per channel key as the server does, and validates the same way. |
| W1 | `notificationPolicy` stored on the workspace; PATCH requires `workspace.update`. |

**Mock `PushPlatform`.** It uses the real `Notification.requestPermission()` and a real SW registration, but
**`subscribe()` returns a fake subscription** (`https://fcm.googleapis.com/fcm/send/mock-<uuid>`, random keys) instead
of calling `pushManager.subscribe`. The mock therefore never contacts a push service. In jsdom and e2e, a
`fakePushPlatform` is injected through `setPushPlatform()`, with a scripted permission.

**Seed:** `u_alex` has Telegram `@alexkim` and push on "Chrome on macOS" (the design's Matrix frame). The others have
nothing. Quiet hours are the defaults, with timezone `America/New_York` for `u_alex`.

### 8.9 Removing "Coming soon"

- In `preferences.tsx`, delete the `SOON` constant, the hatched "Coming soon" headers and the `data-soon` cells. They
  are replaced by the live columns, using "not connected" hatching for unusable channels.
- Replace the second test in `preferences.test.tsx` with the §9.2 matrix tests.
- `features/reports/controls.tsx` keeps its unrelated "Coming soon" (board 17 export).
- Update the CLAUDE.md v2 list (§8.1).

### 8.10 New dependency: `uqr`

`uqr` (unjs) is a zero-dependency, ESM, tree-shakeable QR encoder of about 12 KB min. It is loaded **only** with the
Telegram dialog (`lazyWithPreload`). It returns a boolean matrix that we draw as React SVG. The QR has to be generated
in the browser, because the mock must work without a backend. The alternative, server-rendered SVG through Python
`segno`, would still need a client encoder for the mock, and would put HTML into the page.

---

## 9. Test plan

### 9.1 Backend (pytest, PostgreSQL; gates unchanged: ruff, mypy, coverage ≥ 85 %, `apps/access` ≥ 95 %)

**Providers**

- Telegram `bot` backend against a stub HTTP server (`http.server` in a thread): `sendMessage` body (HTML, button
  left out for non-https `FRONTEND_URL`), and mapping of 403/400/429 (`retry_after`)/401 to `SendResult`.
- Twilio: form body, Basic auth, `MessagingServiceSid` versus `From`, `StatusCallback`, and error codes 21610, 21211,
  21408, 20003, 429 and 500.
- Web Push:
  - VAPID JWT: ES256 verifies with the public key; `aud` = endpoint origin; `exp` ≤ 24 h; `sub`;
  - **encryption round trip**: decrypt the body with a test UA key pair through `http_ece.decrypt` (RFC 8291 vector
    from the RFC appendix);
  - headers (`TTL`, `Urgency`, `Topic` ≤ 32);
  - 201/404/410/413/429/5xx mapping.
- `console` refuses prod settings; `fake` scripting works.

**Telegram linking (H1 + C2–C5)**

- Wrong or missing secret → 401, no DB writes.
- `/start lx_<token>`, `/start CODE`, bare `k7m-qx2` (normalised) → linked; the reply is in the webhook response body.
- Expired code → "didn't work"; a second use of the same code → "didn't work"; group chat → refused.
- 5 wrong codes → silence for 1 h.
- `/stop` deletes every connection for that chat. `my_chat_member` kicked → blocked; member → active.
- C2 with an `active` connection → 409; C2 cancels the previous pending request; C3 status transitions; C4 cancel;
  C5 disconnect skips queued rows.
- `username` is refreshed.

**SMS (C6–C9, H2, H3)**

- Phone table vectors, shared with the mock (`backend/apps/channels/tests/data/phone_vectors.json`; the frontend copies
  it): US NANP rules, a leading `0` stripped for GB/DE, mobile prefixes, digit counts, `IN` refused unless enabled.
- OTP:
  - the stored hash ≠ the code; `compare_digest` is used;
  - 3 wrong → `too_many_attempts`, and the right code is then refused;
  - expired → 410;
  - resend before 30 s → 429 `resend_cooldown` with `retryAt`; resend resets attempts and invalidates the old code.
- Limits counted in the DB: per user per hour and day, per phone across two users, global. **Run with
  `CACHES=locmem` and two simulated processes** to prove they don't depend on the cache.
- **Concurrency:** 5 parallel wrong verifies (threads) never allow more than 3 attempts.
- **Encryption:** `phone_enc` decrypts; rotation re-encrypts and re-hashes; no E.164 appears in captured logs (a
  caplog assertion over the whole SMS suite).
- **H2:** bad signature → 403. STOP/START by `OptOutType` and by body. Two users with the same number are both opted
  out. Pending deliveries are skipped.
- **H3:** status codes update the delivery; 3 × 30003 → `invalid`.

**Push (C10–C13)**

- Allow-list (rejects `http:`, `localhost`, `169.254.169.254`, unknown hosts); key length validation.
- `subscribe` moves an endpoint between users; `refresh` 404 for another user's or an expired endpoint.
- The 11th subscription expires the oldest. C12 is idempotent. C13 with another user's id → 404.

**Preferences (P1)**

- The v1-shaped PUT (`in_app`/`email` only) keeps the new keys.
- Defaults for new users and the data migration for existing rows (in_app/email untouched).
- `quietHours` validation; `timezone` filled once by C2/C6/C11 and never overwritten.

**Dispatch**

- **Table-driven matrix:** event × channel pref × connection state (none, active, blocked, opted_out, expired) × SMS
  policy × provider disabled. The expected result is enqueued/skipped with its reason. The actor and non-members never
  receive anything.
- `access`, `import` and `sprint_completed` never fan out.
- Deliveries are written in the event's transaction (rollback → none) and are unique per target.
- **Quiet hours** (`quiet_vectors.json`, backend only):
  - same-day and overnight windows; day semantics (Fri 22:00 → Sat 08:00 with only Fri selected);
  - DST spring-forward gap and fall-back overlap in `America/New_York` and `Europe/Berlin`;
  - `from == to` rejected; `timezone` null → inactive;
  - urgent bypass by priority 4; a task without priority 4, and no task, are deferred.
- Release: 1 row → original; 3 rows → one summary + 3 `coalesced`; the summary counts once toward the SMS cap; a quiet
  hours change re-times deferred rows.
- Templates:
  - every template × channel renders with the fixture context;
  - Telegram escaping (`<script>` in a title shows as text);
  - **SMS never contains `task_title` or `comment_excerpt`** (an assertion over every SMS template, with distinctive
    fixture strings);
  - GSM-7 length rule and actor-name folding;
  - push payload ≤ 3,000 bytes with a 200-character title.

**Runner**

- The claim is exclusive: two threads claiming the same id → one wins.
- Backoff schedule and `retry_after`; `dead` after 5 attempts; a lease expiry is recovered by the sweeper.
- The sweeper issues **zero queries** when nothing is pending (a `django_assert_num_queries(0)` window while idle).
- The startup sweep picks up orphaned rows. `send_channel_deliveries` sends inline. Send-time re-checks produce
  `stale` (member removed, task deleted).
- Permanent failures update connections (blocked, opted_out, invalid, expired). `config_error` is logged once per
  window.
- `channel_deliveries --dead` / `--retry`.

**Tests (C14)**

- Synchronous; ignores quiet hours; counts toward the SMS cap; each 502 reason; 409 when not connected; throttle.

**Permissions and safety nets**

- **Permission matrix:** every new route is listed (user routes = any authenticated user; W1 `notificationPolicy`
  needs `workspace.update`; webhooks are public with a signature).
- **IDOR:** another user's link, verification or device ids → 404.
- **OpenAPI:** regenerated and validated; webhooks are tagged.
- `purge_trash` retention for every table in §6.10.

### 9.2 Frontend (`npm run check`; Vitest with `--maxWorkers=2` on this machine)

**Unit**

- `quiet.ts`: segments (same-day, overnight split, `from == to` → none), the summary labels from the design (every day
  / no days / Mon–Fri / weekends / `Mo We Fr`), `tzLabel`.
- `phone.ts`: formatting per pattern, the shared `phone_vectors.json`.
- `push.ts` with `fakePushPlatform`: unsupported, `ios-needs-install`, default → granted → subscribe → C11; denied →
  blocked; key rotation re-subscribes; `refresh` 404 → local unsubscribe; logout clean-up order (C12 before logout).

**Components**

- `PreferencesMatrix`:
  - 30 cells; live switches only for usable channels;
  - not-connected cells are `role="img"` with "…: not connected" and no input;
  - the header shows Connect, "Off by admin" or Blocked as appropriate;
  - toggling calls `onToggle(event, channel, on)`;
  - short labels at narrow width.
- `ChannelsSection`: every row state in §8.5; the admin row only with `workspace.update` (rendered for `u_alex`, absent
  for `u_sam`).
- `TelegramDialog` (fake timers): pending → polling → linked; the countdown hits warn at 60 s; expired → New code
  calls C2; close before link calls C4; copy feedback; Open Telegram shown on coarse pointers.
- `SmsDialog` / `OtpInput`:
  - digit-count validation per country; Enter submits;
  - paste of 6 digits auto-verifies; partial paste spreads; Backspace and arrows;
  - wrong code → "Wrong code · 2 tries left" and focus box 1; 0 tries → read-only + "Too many tries · resend a code";
  - resend countdown → button → attempts reset;
  - 502 send failure copy.
- Send test: success toast + preview; each 502 reason's toast.
- Mock handlers (`channels.test.ts`):
  - C2 auto-links after 5 s (fake timers) unless manual mode;
  - SMS code `482913`; limits;
  - P1 merge keeps unknown keys;
  - W1 permission.

**e2e** (`e2e/smoke.spec.ts`, Playwright Chromium, context `permissions: ["notifications"]`)

- As `u_sam`: connect SMS with `482913` → the row shows the number → the matrix SMS column turns live → toggle Due soon
  · SMS → "Saved".
- Enable push (mock platform) → "This browser" → Send test.
- As `u_taylor` (viewer) at 390 px: the page renders with no admin row.
- No console errors.

**Visual sweep**

- 1440 and 390, navy/black/light, as `u_alex` (admin) and `u_taylor`.
- Frames: matrix, Telegram pending and expired, SMS OTP error, push blocked, quiet hours overnight, test preview,
  loading.

---

## 10. Conflicts (design vs conventions) and resolutions

| # | Design | Resolution | Why |
|---|---|---|---|
| 1 | Telegram dialog: "Alerts and quick replies in Telegram."; preview body "· reply to comment" | Copy becomes "Alerts in Telegram, with a link back to the task."; the preview drops "· reply to comment". Free-text replies get a polite bot answer. | Quick replies aren't built (§1.2, §11 #3). Behaviour wins over copy. |
| 2 | QR is the only primary action, including the 390 px frame | On touch/coarse pointers an **Open Telegram** button (deep link) sits above the QR; the QR stays for desktop. | You can't scan a QR on the phone that displays it. Appearance is otherwise unchanged. |
| 3 | SMS preview "Reply STOP to mute" | Messages say **"Reply STOP to opt out"**. | Carrier (CTIA) and Twilio guidance require clear opt-out language; "mute" suggests a temporary pause, and STOP is permanent until START. |
| 4 | The design shows no "Email delivery" control | v1's Instant / Hourly / Daily segmented control stays, under the matrix. | Docs and v1 behaviour win; removing it would silently change every digest user. |
| 5 | Quiet hours default Mon–Fri (fixture `days: [1,1,1,1,1,0,0]`) | Default **every day**; the UI is unchanged. | Fixture data isn't a behaviour spec. Mon–Fri would wake people at 3 a.m. on weekends by default. |
| 6 | Timezone select with 5 fixed zones | All IANA zones (`Intl.supportedValuesOf("timeZone")`), the browser's zone first, labelled `City · GMT±h` like the design. | Real users live elsewhere. |
| 7 | Email row "Send test" | Sends a plain-text email (no designed template). | No board-36 template exists for a test; inventing an HTML email is out of scope. |
| 8 | Push row status is just "This browser"; no device list | Status adds " · N more devices" when there are others, opening a small Menu of devices with per-device remove; × removes this browser only. | Subscriptions are per device (§3.6); the design shows only one browser. |
| 9 | Push only has Off / Waiting / On / Blocked | New "Not supported in this browser" and "Add Lightex to your Home Screen" (iOS) states, styled as the dashed Off state, with no actions. | Real browser support (§8.6). |
| 10 | Telegram has no error state | "Bot blocked in Telegram" (⚠, the design's `err` status style) + Reconnect. | Users block bots; we learn it from 403 or `my_chat_member`. |
| 11 | SMS row "Off by admin" hides every action | With a number already connected, × (remove) stays. | Otherwise users can't delete their own number while one workspace has SMS off. |
| 12 | The design's SMS countries include India | `IN` is in the table but **off** in `SMS_COUNTRIES` by default; the mock shows it. | DLT registration is a legal prerequisite (§2.6 A4). |
| 13 | Tests show sample task "PRJ-42 Fix flaky board reflow" | Real tests send the neutral `test` copy (§6.5); the in-page preview uses the same text. | A fake task in a real chat or SMS would confuse people. |
| 14 | Admin policy row placed inside the personal Channels card | Kept as designed, rendered only with `workspace.update`, labelled with the current workspace's name. | Design wins on appearance; the gate follows `my_permissions`. |
| 15 | OTP error copy "Too many tries · resend a code" applies at 0 tries | Kept. Codes also expire after 10 min: "Code expired · resend a code" (same slot). | The server adds expiry; the copy pattern is unchanged. |

---

## 11. Open questions

None blocks implementation; each has a default above that both sides build to. Confirm or change before release:

1. **Twilio Verify instead of our own OTP.** Default: our own OTP through Programmable Messaging (hashing, limits and
   copy under our control; one Twilio product). Option: a `TwilioVerifyOtp` implementation behind the same service,
   for Twilio's fraud guard against SMS pumping. It costs per verification, and the code is no longer stored by us.
2. **Countries.** Default `US,GB,DE`. Enable `IN` only after DLT registration (A4). Other countries are one table row
   each.
3. **Telegram quick replies.** Not built. A future design would let a reply to a mention or comment message post a
   comment as the linked user. It needs re-authentication rules, rate limits and an audit `source: "telegram"`.
4. **SMS content.** Default: no titles (§6.5). Option: a workspace policy "Include task titles in SMS" (more useful,
   less private).
5. **Phone encryption.** Default: Fernet at rest (one more secret to keep). Option: plaintext like emails, which is
   simpler but leaves the numbers exposed in database dumps.
6. **Caps.** Defaults are 10 SMS per user per day and 300 in total. Option: per-workspace monthly budgets with an
   admin-visible counter (needs UI).
7. **Quiet hours for email.** Default: email ignores quiet hours (it has its own digest). Option: also hold instant
   emails.
8. **Scheduler on Render.** The sweeper covers a running instance; a sleeping free instance delays summaries and
   retries. Option: a paid Render Cron Job for `send_channel_deliveries` (A7), or an always-on instance.
9. **`sprint_completed` and `import` on external channels.** Excluded now. They would need matrix rows (a design
   change).
10. **Per-workspace preferences.** Preferences stay **per user** (v1). The settings page lives under a workspace route,
    but toggles apply to every workspace except the SMS policy. Option: per-workspace overrides (a bigger data model).

---

## 12. Delivery checklist

**Backend:**

- `apps/channels` (models, migrations, `providers/{telegram,twilio,webpush,console,fake}.py`, `crypto.py`,
  `phones.py`, `quiet.py`, `render.py` + templates, `dispatch.py`, `runner.py`, services, selectors, serializers,
  views, `webhooks.py`, urls, Celery task).
- Management commands: `telegram_setup`, `telegram_poll`, `telegram_fake_start`, `generate_vapid_keys`,
  `generate_channels_key`, `rotate_channels_key`, `send_channel_deliveries`, `channel_deliveries`.
- `notifications`: `deliver()` fan-out, `default_events()` keys, preference columns + data migration, P1 merge and
  validation.
- `workspaces.sms_enabled` + W1 serializer/PATCH + audit.
- Settings and env (§2.5) with the prod safety checks; `requirements.txt` gains `cryptography` and `http-ece`
  (pinned).
- `gunicorn.conf.py` `post_worker_init` sweeper start (shared with board 33).
- Check that the Docker image has `/usr/share/zoneinfo` (otherwise add `tzdata`).
- `render.yaml` new `sync: false` vars and optional `telegram_setup` in the start command.
- `purge_trash` additions; README sections (providers, accounts A1–A7, the without-Redis note).
- Permission-matrix and IDOR entries; tests (§9.1) and vectors; `docs/openapi.yaml` regenerated.

**Frontend:**

- CLAUDE.md scope + final-report paper trail (§8.1).
- Types, endpoints, query keys; `features/notifications/channels/*`; matrix rewrite; quiet hours; Telegram, SMS and
  push flows.
- `public/sw.js`, `public/push-badge.png`, the `next.config.ts` `/sw.js` header rule.
- `usePushSync`, the logout hook, the SW navigate listener.
- `uqr` (lazy).
- Mock: `handlers/channels.ts`, `ensureExt38`, mock `PushPlatform`, controls "Telegram: manual" and "Channel
  failures", seed.
- "Coming soon" removal; tests (§9.2); visual sweep.

**Order:**

1. Backend first, with every provider `disabled` or `console`. An older frontend ignores the new preference keys, and
   the new frontend shows "Not available on this server" until a provider is configured, so both orders are safe.
2. Create the accounts (§2.6), set the secrets, deploy, run `telegram_setup`, then send a test from each channel.
