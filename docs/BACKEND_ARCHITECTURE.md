# Orange Clipboard — Backend Architecture

Complete module-level walkthrough of `orange-copy-paste-clipboard-backend/`.

---

## 1. Technology Stack

| Layer | Choice |
|---|---|
| Language | Python 3.14 |
| Web framework | FastAPI 0.115+ |
| ASGI server | Uvicorn (standard extras) |
| ORM | SQLAlchemy 2.0 async (`asyncpg` driver) |
| Database | PostgreSQL 16 |
| Cache / broker | Redis 7 |
| Background jobs | Celery 5.4 (Redis broker + result backend) |
| Object storage | S3-compatible (Cloudflare R2 in `.env.example`; any S3-compatible endpoint) via boto3 |
| JWT | RS256, signed with RSA private key via `python-jose` |
| Password hashing | bcrypt via `passlib` |
| Rate limiting | `slowapi` (wraps `limits` library) |
| HTTP client | `httpx` (used for Brevo email API) |
| Schema validation | Pydantic v2 + `pydantic-settings` |
| Migrations | Alembic 1.13 |
| Packaging / venv | `uv` |
| Container | Docker (Dockerfile + docker-compose.yml) |

The stack is entirely async on the request path (FastAPI + asyncpg + redis.asyncio). Celery workers run synchronously in separate processes using the same Redis instance.

---

## 2. Project Layout

```
src/
  main.py              — FastAPI app factory, lifespan, middleware, router mounts
  config.py            — Settings via pydantic-settings (.env / environment variables)
  database.py          — Async SQLAlchemy engine, session factory, Base
  dependencies.py      — Shared FastAPI dependencies (auth, Redis)
  middleware.py        — SecurityHeadersMiddleware
  limiter.py           — Global slowapi Limiter singleton
  redis_client.py      — Redis connection pool (singleton, lazy-init)
  well_known.py        — /.well-known/jwks.json

  auth/                — Registration, login, JWT, devices, E2E key management
  sync/                — Push/pull sync, conflict resolution, per-device cursors
  settings/            — Encrypted user settings blob
  blobs/               — S3 presigned upload/download, quota tracking
  groups/              — Pool groups and live-share groups
  sharing/             — Live Share invite/join/leave/scope
  realtime/            — WebSocket hub + Redis pub/sub bridge
  worker/              — Celery app + tasks (email, blob cleanup, presence)
  admin/               — Internal health, metrics, and user management endpoints

migrations/
  versions/
    0001_initial_auth.py
    0002_sync.py
    0003_blobs.py
    0004_groups.py
    0005_admin.py
```

---

## 3. Application Bootstrap (`src/main.py`)

`main.py` is the composition root. It:

1. Defines an async `lifespan` context manager:
   - **Startup**: calls `get_redis_pool()` to warm the singleton, then spawns `start_listener(redis_url)` as an asyncio background task (the Redis pub/sub bridge).
   - **Shutdown**: cancels the pubsub task, closes the Redis pool.

2. Creates the `FastAPI` app with:
   - `docs_url="/api/docs"`, `redoc_url="/api/redoc"`, `openapi_url="/api/openapi.json"`
   - `lifespan=lifespan`

3. Wires middleware (order matters — last added = outermost):
   - `SlowAPIMiddleware` (rate limiting)
   - `SecurityHeadersMiddleware` (defensive HTTP headers)
   - `CORSMiddleware` (origins from `settings.cors_origins`, credentials allowed)

4. Mounts routers:
   - `/api/v1/auth`, `/api/v1/sync`, `/api/v1/settings`, `/api/v1/blobs`, `/api/v1/groups`, `/api/v1/sharing`
   - `/ws` (WebSocket, no prefix)
   - `/.well-known/jwks.json` (no prefix)
   - `/internal` (admin)

---

## 4. Configuration (`src/config.py`)

`pydantic-settings` `Settings` class reads from `.env` with fallback defaults. Key knobs:

- **`database_url`** — asyncpg PostgreSQL DSN
- **`redis_url`** — Redis DSN (shared by API + Celery)
- **`jwt_private_key_path` / `jwt_public_key_path`** — RSA PEM files on disk; `jwt_private_key` / `jwt_public_key` properties read them lazily
- **`jwt_algorithm = "RS256"`**, access token TTL 15 min, refresh token TTL 7 days
- **`s3_endpoint_url`, `s3_bucket`, `aws_access_key_id`, `aws_secret_access_key`** — S3-compatible credentials; `.env.example` shows Cloudflare R2 (`https://your-account-id.r2.cloudflarestorage.com`)
- **`default_blob_quota_bytes = 524_288_000`** (500 MB per user)
- **`admin_api_key`** — empty disables all `/internal/admin/*` and metrics endpoints
- **`email_provider`** — `"brevo"` (default) or `"smtp"`
- **`email_verify_token_ttl = 86_400`** (24 h), **`password_reset_token_ttl = 3_600`** (1 h)

`cors_origins` is a property that splits `app_cors_origins` on commas, so multiple origins can be set in a single env var: `tauri://localhost,http://localhost:1420`.

---

## 5. Database Layer (`src/database.py`)

```
engine = create_async_engine(
    settings.database_url,
    pool_size=5, max_overflow=10, pool_pre_ping=True,
    echo=(app_env == "development"),
)
AsyncSessionLocal = async_sessionmaker(bind=engine, expire_on_commit=False, autoflush=False)
```

`expire_on_commit=False` means ORM objects stay accessible after a commit — important because FastAPI handlers read attributes after `await db.commit()`.

`get_db()` is an async generator dependency that wraps a session in a context manager; FastAPI's DI system automatically closes it after the response.

`Base` (DeclarativeBase) is inherited by all models across all modules.

---

## 6. Auth Module (`src/auth/`)

### 6.1 Models

**`User`**:
- `id: UUID` (primary key, gen_random_uuid())
- `email: String(320)` — unique
- `password_hash: Text` — bcrypt
- `kdf_salt: String(64)` — base64-encoded 16-byte random salt for Argon2id key derivation (client-side, server never derives the key)
- `identity_pubkey: Text | None` — base64 X25519 public key for E2E key exchange
- `email_verified: Boolean`
- `suspended_at: BigInteger | None` — set to timestamp if suspended, null if active
- `blob_bytes_used / blob_bytes_quota: BigInteger` — storage quota tracking
- `devices: List[Device]` — cascade delete relationship

**`Device`** (one row per login session):
- `id: UUID`
- `user_id: UUID` (FK → users, cascade delete)
- `device_name / platform / app_version: String`
- `device_pubkey: Text | None` — base64 X25519 device public key
- `wrapped_umk: Text | None` — AES-GCM(shared_secret, User Master Key) — the UMK encrypted with the ECDH shared secret between identity key and device key
- `refresh_token_hash: Text | None` — bcrypt hash of the current refresh token
- `revoked: Boolean` — soft-revoke flag

### 6.2 JWT (`src/auth/jwt.py`)

- **`create_access_token(user_id, device_id)`** — RS256 JWT with claims: `sub=user_id`, `did=device_id`, `jti=uuid4()`, `iss="orange-clipboard-api"`, 15-minute expiry. Returns `(token, jti)`.
- **`decode_access_token(token)`** — verifies signature + issuer, raises `HTTP 401` on `JWTError`.
- **`create_refresh_token()`** — `secrets.token_hex(32)` (64 hex chars), not a JWT.
- **`get_jwks()`** — `@lru_cache(maxsize=1)`: loads the RSA public key, extracts `n` and `e`, computes `kid` as first 16 hex chars of SHA-256 of DER-encoded key. Returns JWKS dict. Served at `/.well-known/jwks.json`.

### 6.3 Service (`src/auth/service.py`)

- **`register_user(db, req)`** — checks for duplicate email (409 if exists), hashes password with bcrypt, generates `kdf_salt` (16 random bytes base64-encoded), creates `User`.
- **`login_user(db, req)`** — verifies password + suspension status, creates a new `Device` row (one device per login, not per physical machine). Returns `(user, device)`.
- **`store_refresh_token(db, device, raw_token)`** — bcrypt-hashes the raw token and stores it in `device.refresh_token_hash`.
- **`rotate_refresh_token(db, device_id, raw_token)`** — looks up device, verifies token hash. If invalid: sets `device.revoked = True` (refresh token reuse detection / token theft mitigation). Returns `(user, device)`.
- **`revoke_device(db, device_id, user_id)`** — clears `refresh_token_hash`, sets `revoked = True`.
- **`store_public_keys(db, user_id, device_id, ...)`** — stores `identity_pubkey` on User and `device_pubkey` on Device (called after registration when the client has generated its keypair).
- **`store_wrapped_umk(db, device_id, user_id, wrapped_umk)`** — stores the wrapped UMK on a target device (called by the key distribution flow when adding a new device).
- **Email verification** — token = `secrets.token_urlsafe(32)` stored in Redis at `email_verify:{token}` with 24h TTL. `verify_email()` reads and deletes the key, sets `user.email_verified = True`.
- **Password reset** — same pattern: `pwd_reset:{token}` → user_id in Redis with 1h TTL.

### 6.4 Router (`src/auth/router.py`)

| Method | Path | Notes |
|---|---|---|
| POST | `/auth/register` | Creates user, queues verification email via Celery |
| POST | `/auth/verify-email` | Validates Redis token |
| POST | `/auth/resend-verification` | Rate-limited 3/hour |
| POST | `/auth/login` | Rate-limited 10/min + 30/hr; returns access + refresh tokens, `kdf_salt`, device_id |
| POST | `/auth/refresh` | Rotates refresh token (old token invalidated immediately) |
| POST | `/auth/logout` | Revokes the specified device |
| DELETE | `/auth/devices/{device_id}` | Revoke another device |
| GET | `/auth/devices` | List active devices (marks `is_current`) |
| POST | `/auth/keys/register` | Store identity + device pubkeys |
| POST | `/auth/devices/{device_id}/key-wrap` | Store `wrapped_umk` on a device |
| POST | `/auth/password-reset/request` | Rate-limited 5/15min; timing-safe (always returns same message) |
| POST | `/auth/password-reset/confirm` | Validates token, updates password hash |

### 6.5 Auth Dependency (`src/dependencies.py`)

`get_current_user_id()`:
1. Extracts Bearer token from `Authorization` header.
2. Calls `decode_access_token()` — raises 401 on invalid/expired.
3. Checks `revoked:{jti}` key in Redis — raises 401 if present.
4. Returns `(user_id, device_id)` tuple.

This dependency is used on every authenticated endpoint. **Security gap**: the `revoked:{jti}` check is present in the code, but nothing in the codebase currently writes to `revoked:{jti}` in Redis. `revoke_device()` only sets `device.revoked = True` in PostgreSQL. In practice, a revoked device's access token remains valid until its 15-minute natural expiry. The DB revoke flag does prevent new refresh token rotations, but the existing access token is not instantly invalidated.

---

## 7. Sync Module (`src/sync/`)

This is the core of cloud sync. The server stores all content encrypted — it only sees ciphertext.

### 7.1 Models

**`SyncEntry`**:
- `id: UUID` — server-assigned primary key
- `client_id: String` — client-local ID (used for idempotent upserts)
- `user_id / device_id: UUID`
- `entry_type: String(16)` — `"clipboard"` or `"note"`
- `kind: String(16) | None` — `"text"`, `"image"`, `"html"`, `"file"` (server-visible for routing only)
- `encrypted_content: Text` — AES-GCM ciphertext (server never decrypts)
- `encrypted_metadata: Text | None` — AES-GCM encrypted metadata
- `created_at / updated_at: BigInteger` — client-provided timestamps (ms epoch)
- `server_ts: BigInteger` — server-assigned monotonic timestamp (used as sync cursor), indexed
- `deleted_at: BigInteger | None` — tombstone timestamp
- `pinned: Boolean`
- `group_ids: ARRAY(UUID)` — server-visible group IDs for routing
- `blob_key: Text | None` — S3 key for blob-backed entries
- `blob_size: BigInteger | None`

**`SyncCursor`**:
- `device_id: UUID` (primary key)
- `user_id: UUID`
- `last_server_ts: BigInteger` — the last `server_ts` this device has acknowledged

### 7.2 Service (`src/sync/service.py`)

**Push** (`push_entries`):
- Iterates the incoming `PushEntry` list.
- For each entry, calls `_upsert_entry()`:
  - Looks up existing by `(user_id, client_id, entry_type)`.
  - **New entry**: inserts with a server-generated `server_ts = now_ms()`.
  - **Existing entry**: LWW (last-write-wins):
    - Tombstone always wins: if incoming has `deleted_at` set and existing doesn't, the update proceeds regardless of timestamp.
    - Otherwise: if `entry.updated_at <= existing.updated_at`, returns `ConflictEntry(reason="stale_update")`.
    - Otherwise: updates all fields, bumps `server_ts`.
- Returns `(accepted, conflicts)`.

**Pull** (`pull_entries`):
- Selects `SyncEntry` rows for `user_id` where `server_ts > after_ts`, ordered by `server_ts ASC`, limit `N+1`.
- If `N+1` rows returned → pagination: truncate to `N`, set `next_cursor = rows[-1].server_ts`.
- Client calls pull repeatedly until `next_cursor` is None.

**Cursor** (`update_cursor`):
- PostgreSQL `INSERT ... ON CONFLICT DO UPDATE` (upsert) with a guard: `WHERE last_server_ts < incoming_ts`. This prevents cursor regression.

### 7.3 Router

| Method | Path | Notes |
|---|---|---|
| POST | `/sync/push` | Accepts batch; fans out accepted entries via Redis pubsub |
| GET | `/sync/pull` | Query params: `after_ts`, `limit` (1–500), `entry_type` |
| POST | `/sync/cursor` | Updates per-device acknowledged cursor |
| GET | `/sync/status` | Returns `device_id` + `last_server_ts` |

After each accepted push entry, the router publishes to `user:{user_id}` and to each `group:{group_id}` in `entry.group_ids`, excluding the origin device. This delivers real-time sync to all other connected devices instantly.

---

## 8. Settings Module (`src/settings/`)

**`UserSettings`**:
- `user_id: UUID` (primary key — one row per user)
- `encrypted_blob: Text` — the entire app settings serialized and AES-GCM encrypted client-side
- `updated_at: BigInteger`

**Service**:
- `get_settings(db, user_id)` — returns the row or `None`.
- `put_settings(db, user_id, req)` — LWW conflict resolution:
  - If `existing.updated_at > req.updated_at`: server blob is newer → return it with `winner="server"`.
  - Otherwise: upsert the new blob, return it with `winner="client"`.
  - The client applies whichever blob won.

**Router**: `GET /settings` + `PUT /settings`. After a PUT, `settings:updated` is published via Redis pubsub **only when `result.winner == "client"`** — i.e., the incoming blob was newer and was actually stored. When the server blob wins (existing `updated_at` is later), no event is published because no data changed.

---

## 9. Blobs Module (`src/blobs/`)

Blobs hold S3-backed binary content for clipboard images and note attachments (encrypted by the client before upload).

### 9.1 Model

**`Blob`**:
- `key: Text` (primary key) — `"{user_id}/{uuid4_hex}"`
- `user_id: UUID`
- `entry_id: UUID | None` — linked sync entry
- `mime_type: Text`
- `size_bytes: BigInteger`
- `checksum: Text` — SHA-256 hex (provided by client, not verified server-side)
- `confirmed: Boolean` — false until client calls confirm-upload
- `created_at: BigInteger`

### 9.2 S3 Layer (`src/blobs/s3.py`)

Uses `boto3` with `s3v4` signature. Creates a new client per call (stateless). Two operations:
- `generate_presigned_put(blob_key, mime_type)` — PUT URL valid for 5 minutes
- `generate_presigned_get(blob_key)` — GET URL valid for 1 hour
- `delete_object(blob_key)` — used by orphan cleanup task

### 9.3 Two-Phase Upload Flow

1. **`POST /blobs/request-upload`**:
   - Validates `size_bytes <= 5 MB`.
   - Checks user quota: `blob_bytes_used + size_bytes <= blob_bytes_quota` (402 if exceeded).
   - Generates `blob_key = "{user_id}/{uuid4_hex}"`.
   - Generates a presigned PUT URL via S3 (5-minute TTL).
   - Inserts a `Blob` row with `confirmed=False`.
   - Returns `{ blob_key, presigned_put_url, expires_in_seconds: 300 }`.

2. **Client uploads directly to S3** using the presigned URL (no bytes go through the API server).

3. **`POST /blobs/confirm-upload`**:
   - Looks up the `Blob` by `blob_key + user_id`.
   - Sets `confirmed = True`.
   - Increments `user.blob_bytes_used += blob.size_bytes`.
   - Idempotent if already confirmed.

4. **`GET /blobs/{blob_key}/download-url`**:
   - Verifies the blob belongs to the requesting user and is confirmed.
   - Returns a presigned GET URL (1-hour TTL).

5. **`GET /blobs/quota`** — returns `{ used_bytes, quota_bytes }`.

### 9.4 Orphan Cleanup

`cleanup_orphan_blobs` Celery task (runs daily via beat): deletes S3 objects and DB rows for `Blob` records where `confirmed=False` and `created_at < (now - 1h)`. These are blobs where the client initiated an upload but never confirmed (e.g., crash, network failure).

---

## 10. Groups Module (`src/groups/`)

Groups serve double duty: **pool groups** (personal clipboard/note grouping shared across devices) and the underlying mechanism for **live_share** sessions.

### 10.1 Models

**`Group`**:
- `id: UUID`
- `owner_id: UUID`
- `name: Text`
- `group_type: String(16)` — `"pool"` or `"live_share"`
- `invite_code: Text | None` — `secrets.token_urlsafe(24)`, unique
- `invite_expires_at: BigInteger | None`
- `max_members: Integer` — 0 = unlimited; `live_share` defaults to 5

**`GroupMembership`**:
- `(group_id, user_id): composite primary key`
- `role: String(16)` — `"owner"`, `"admin"`, `"member"`
- `wrapped_group_key: Text | None` — AES-GCM(ECDH_shared_secret, group_key) stored per-member so server never sees the plaintext group key
- `share_scope: String(16)` — `"clipboard"`, `"notes"`, `"all"` (used by live_share)
- `joined_at: BigInteger`

### 10.2 Service

- **`create_group`** — creates `Group` + owner `GroupMembership` in one transaction. Generates invite_code with 72h TTL.
- **`join_group(db, user_id, req)`** — looks up group by `invite_code`. Validates expiry + member cap. Idempotent (existing member is a no-op). Returns `(JoinResponse, Group)` — the `Group` object is passed back to the router to decide which WebSocket event to emit.
- **`refresh_invite`** — owner-only. Rotates to a new `secrets.token_urlsafe(24)` with fresh 72h TTL.
- **`remove_member`** — owner can remove any member; members can remove themselves.
- **`distribute_keys(db, group_id, user_id, req)`** — owner-only. Writes `wrapped_group_key` for each specified member. The corresponding `group:rekey` WebSocket event is published by the router after this call.

### 10.3 Router

| Method | Path | Notes |
|---|---|---|
| POST | `/groups` | Create pool group |
| GET | `/groups` | List groups user belongs to (pool type only) |
| GET | `/groups/{id}` | Get group detail (must be member) |
| POST | `/groups/{id}/invite` | Rotate invite code (owner only) |
| POST | `/groups/join` | Join via invite code; publishes `sharing:accepted` (live_share) or `group:membership_changed` (pool) |
| DELETE | `/groups/{id}/members/{uid}` | Remove member |
| DELETE | `/groups/{id}` | Delete group (owner only) |
| POST | `/groups/{id}/keys` | Distribute wrapped group keys; publishes `group:rekey` per recipient |

---

## 11. Sharing Module (`src/sharing/`)

Handles Live Share sessions — real-time clipboard/note sharing between users. Live Share reuses the `Group` model with `group_type = "live_share"`.

### 11.1 Service

- **`create_invite(db, user_id, email, share_scope)`**:
  - Creates a `live_share` Group owned by the inviting user.
  - Creates the owner's `GroupMembership` with `share_scope`.
  - Invite TTL: 24 hours (shorter than pool groups).
  - Looks up invitee by email — if found (registered user), the router will push a real-time `sharing:invite` WebSocket event and queue an invite email.
  - If invitee not found (email unknown), the invite is created but no WS event fires — they'll receive the code via email and join when they register.

- **`leave_session(db, share_group_id, user_id)`**:
  - Non-owners only. Deletes the `GroupMembership`.
  - Returns `leaving_scope` (the departing member's scope string) — used by the router to publish `sharing:scope_changed` so all other members know this user left.

- **`end_session(db, share_group_id, user_id)`** — owner-only, hard-deletes the entire `Group` (cascade removes memberships).

- **`update_scope(db, share_group_id, user_id, req)`** — updates `GroupMembership.share_scope` for the requesting user.

### 11.2 Router

| Method | Path | Notes |
|---|---|---|
| POST | `/sharing/invite` | Creates live_share group, publishes `sharing:invite` WS, queues invite email |
| GET | `/sharing/sessions` | List live_share sessions user belongs to |
| PATCH | `/sharing/sessions/{id}/scope` | Update own share scope; publishes `sharing:scope_changed` |
| DELETE | `/sharing/sessions/{id}` | Owner ends session; publishes `sharing:ended` BEFORE deleting (group channel still has subscribers at publish time) |
| DELETE | `/sharing/sessions/{id}/leave` | Non-owner leaves; publishes `sharing:scope_changed` |

---

## 12. Realtime Module (`src/realtime/`)

Three-layer architecture: Redis pub/sub → in-memory hub → WebSocket connections.

### 12.1 Hub (`src/realtime/hub.py`)

In-memory process-global registry:
```
_channels: dict[channel_name → set[(WebSocket, device_id)]]
_ws_device: dict[WebSocket → device_id]
_ws_channels: dict[WebSocket → set[channel_name]]
```

All mutations under `asyncio.Lock()`.

- **`register(ws, device_id, channels)`** — adds ws to each channel set.
- **`unregister(ws)`** — removes ws from all channel sets, cleans up empty channels.
- **`broadcast(channel, raw, exclude_device)`** — sends `raw` JSON string to all WebSocket connections on the channel, skipping the origin device. Dead connections (send fails) are pruned inline. `connection_count()` returns len of `_ws_device` for metrics.

### 12.2 Pub/Sub Bridge (`src/realtime/pubsub.py`)

`start_listener(redis_url)` runs as a long-lived asyncio task (started in app lifespan). It uses `psubscribe("user:*", "group:*")` to receive all messages on both channel families.

For each incoming Redis message:
1. Parses the JSON payload.
2. Extracts and removes `_origin_device` (prevents echo to the sender).
3. Calls `hub.broadcast(channel, clean_json, exclude_device)`.

**Publish helpers** (called by service/router code after writes):
- `publish_sync_entry` — publishes to `user:{uid}` and each `group:{gid}`
- `publish_sync_delete` — `user:{uid}` only
- `publish_group_membership_changed` — `group:{gid}`
- `publish_group_rekey` — `user:{uid}` (targeted to specific user)
- `publish_sharing_invite` — `user:{invitee_uid}`
- `publish_sharing_accepted` — `user:{owner_uid}`
- `publish_sharing_ended` — `group:{gid}`
- `publish_sharing_scope_changed` — `group:{gid}`
- `publish_settings_updated` — `user:{uid}`

All publish helpers embed `_origin_device` in the Redis message, which the listener strips before forwarding to WebSocket clients.

### 12.3 WebSocket Endpoint (`src/realtime/router.py`)

`GET /ws?token=<access_token>`

Lifecycle:
1. **Authenticate** — decodes the JWT from query param, checks JTI revocation in Redis. Closes with code 4001 on failure.
2. **Build channels** — user's personal channel `user:{uid}` + `group:{gid}` for every `GroupMembership` row.
3. **Register** in hub.
4. **Presence** — `SADD user:{uid}:devices {did}` + `EXPIRE ... 300s`. Publishes `device:online` to `user:{uid}` channel.
5. **Main loop** — `asyncio.wait_for(receive_text, timeout=25s)`:
   - On `pong` event: refreshes the Redis presence TTL.
   - On `ack` event: no-op (reserved for future delivery confirmation).
   - On `TimeoutError` (25s with no client message): server sends `{"event":"ping","payload":{"server_ts":...}}`.
   - On disconnect / RuntimeError: breaks loop.
6. **Cleanup** — unregisters from hub, `SREM` from presence set, publishes `device:offline`.

---

## 13. Worker Module (`src/worker/`)

### 13.1 Celery App (`src/worker/app.py`)

```python
app = Celery(
    "orange_clipboard",
    broker=settings.redis_url,
    backend=settings.redis_url,
    include=["src.worker.tasks.email", "src.worker.tasks.blob_cleanup", "src.worker.tasks.notifications"],
)
```

Beat schedule:
- `blob-cleanup-daily` → `cleanup_orphan_blobs` every 86400s
- `detect-offline-devices` → `detect_offline_devices` every 60s

JSON serialization only (`task_serializer="json"`, `accept_content=["json"]`).

### 13.2 Email Tasks (`src/worker/tasks/email.py`)

Three tasks, all with `autoretry_for=(Exception,)`, `max_retries=3`, `retry_backoff=True`:
- `send_verification_email(user_email, display_name, verify_url)` — queued by auth router at registration
- `send_password_reset_email(user_email, display_name, reset_url)` — queued at password reset request
- `send_sharing_invite_email(invitee_email, invitee_name, from_name, invite_code)` — queued at sharing invite creation

Each task delegates to `get_provider().send(...)`.

### 13.3 Blob Cleanup (`src/worker/tasks/blob_cleanup.py`)

`cleanup_orphan_blobs` runs daily. Uses `asyncio.run(_cleanup())` to drive an async SQLAlchemy session within the synchronous Celery worker. Finds all `Blob` rows with `confirmed=False` and `created_at < (now - 1h)`, deletes S3 objects first, then DB rows.

### 13.4 Offline Device Detection (`src/worker/tasks/notifications.py`)

`detect_offline_devices` runs every 60 seconds.

**How presence works end-to-end**:
- WebSocket connect → `SADD user:{uid}:devices {did}` + `SET presence:{uid}:{did} 1 EX 300`
- Every pong → `EXPIRE presence:{uid}:{did} 300` (refreshes TTL)
- Clean disconnect → `SREM user:{uid}:devices {did}` + `DEL presence:{uid}:{did}`
- Crash / timeout (no pong) → presence key expires after 300s naturally

This task scans all `user:*:devices` Redis sets, checks whether `presence:{uid}:{did}` still exists for each device ID, and for missing keys: SREMs the stale device and publishes `device:offline` to `user:{uid}`. This handles the case where the WebSocket dropped without a clean close (network reset, process crash, etc.).

---

## 14. Email Module (`src/email/`)

**`EmailProvider` protocol** (`base.py`): `send(to_address, subject, html_body, text_body) -> None`. Runtime-checkable.

**`get_provider()`** (`factory.py`) — singleton factory. Reads `settings.email_provider`, instantiates once, returns the same instance on every call. `reset_provider()` for tests.

**`BrevoProvider`** (`brevo.py`) — sends via Brevo REST API (`https://api.brevo.com/v3/smtp/email`) with `httpx` (15s timeout). Parses `email_from` to extract sender name and address. No SDK dependency.

**`SmtpProvider`** (`smtp.py`) — stdlib `smtplib` with TLS (STARTTLS). Fallback for self-hosted deployments.

**`templates.py`** — plain string templates returning `(subject, html, text)` tuples:
- `verification_email(display_name, verify_url)`
- `sharing_invite_email(invitee_name, from_name, invite_code)` — includes a deep link `orange://join?code={invite_code}`
- `password_reset_email(display_name, reset_url)`

---

## 15. Admin Module (`src/admin/`)

All admin endpoints live under `/internal/*`. The `require_admin_key` dependency checks `X-Admin-Key: {settings.admin_api_key}` header. If `admin_api_key` is empty, all secured endpoints return 503.

### 15.1 Health Check (public)

`GET /internal/healthz` — no auth required. Runs `SELECT 1` against the DB and `PING` against Redis. Returns `{"status":"ok"|"degraded", "db":"ok"|"error", "redis":"ok"|"error"}`. Used by load balancers.

### 15.2 Prometheus Metrics

`GET /internal/metrics` — `text/plain` Prometheus format. Exposes 12 gauges:
- `orange_users_total`, `orange_users_verified_total`, `orange_users_suspended_total`
- `orange_devices_total`, `orange_devices_active_total`
- `orange_sync_entries_total`, `orange_sync_entries_deleted_total`
- `orange_blobs_total`, `orange_blobs_confirmed_total`
- `orange_storage_bytes_used`
- `orange_ws_connections_active` (from `hub.connection_count()` — in-process count)
- `orange_redis_memory_bytes` (from `redis.info("memory")`)

### 15.3 JSON Stats

`GET /internal/stats` — same data as metrics, returned as JSON (`StatsResponse`).

### 15.4 User Management

| Method | Path | Action |
|---|---|---|
| GET | `/internal/admin/users` | Paginated list (offset/limit), optional search by email/display_name |
| GET | `/internal/admin/users/{id}` | Full user detail including device_count, entry_count |
| PATCH | `/internal/admin/users/{id}/quota` | Update `blob_bytes_quota` |
| POST | `/internal/admin/users/{id}/suspend` | Set `suspended_at` to now (or null to unsuspend). Login blocks 403 for suspended users |
| DELETE | `/internal/admin/users/{id}` | Hard delete (cascade removes devices) |

---

## 16. Security Hardening

### Rate Limiting (`src/limiter.py` + `slowapi`)

Global `Limiter(key_func=get_remote_address)` instance attached to `app.state`. Applied per-route:
- `POST /auth/login` → 10/minute + 30/hour
- `POST /auth/resend-verification` → 3/hour
- `POST /auth/password-reset/request` → 5/15minutes

`SlowAPIMiddleware` intercepts `RateLimitExceeded` and returns HTTP 429.

### Security Headers (`src/middleware.py`)

`SecurityHeadersMiddleware` adds on every response:
- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY`
- `X-XSS-Protection: 1; mode=block`
- `Referrer-Policy: strict-origin-when-cross-origin`
- `Permissions-Policy: geolocation=(), camera=(), microphone=()`
- `Content-Security-Policy: default-src 'none'; connect-src 'self'; frame-ancestors 'none'`
- `Strict-Transport-Security: max-age=31536000; includeSubDomains` — only added when `request.url.scheme == "https"` (absent in local Tauri dev where requests are HTTP)

### Token Revocation

Access tokens are short-lived (15 min) and carry a `jti`. Both `get_current_user_id` (HTTP) and the WebSocket authenticator check for a `revoked:{jti}` key in Redis and return 401 if found. **However, nothing in the current codebase writes to `revoked:{jti}`** — `revoke_device()` only sets `device.revoked = True` in PostgreSQL. Effective token invalidation therefore relies solely on the 15-minute expiry; a revoked device retains API access until then. This is a known security gap: DB revocation blocks future refresh token rotations but does not instantly void live access tokens.

### Timing-Safe Responses

Both password reset request and resend-verification always return the same response body regardless of whether the email exists — prevents email enumeration.

### Refresh Token Rotation + Reuse Detection

`rotate_refresh_token` invalidates the old token immediately on first use. If a second use is detected (possible token theft), the device is immediately revoked and a 401 is returned.

### E2E Encryption Key Architecture

Server stores:
- `user.kdf_salt` — 16-byte random salt for Argon2id on the client
- `user.identity_pubkey` — client's X25519 identity public key
- `device.device_pubkey` — device-level X25519 public key
- `device.wrapped_umk` — `AES-GCM(ECDH(identity_key, device_key), user_master_key)` — the UMK wrapped per-device

The User Master Key (UMK) never leaves the client in plaintext. The server can store and redistribute the UMK to new devices via the wrap/unwrap flow using ECDH — but cannot decrypt it.

---

## 17. Database Migrations

5 Alembic migration files in `migrations/versions/`:

| File | Creates |
|---|---|
| `0001_initial_auth.py` | `users`, `devices` + index on `devices.user_id` |
| `0002_sync.py` | `sync_entries`, `sync_cursors`, `user_settings`; indexes: `idx_sync_entries_user_ts(user_id, server_ts)`, `idx_sync_entries_device(device_id)`, GIN `idx_sync_entries_groups(group_ids)`; unique constraint `uniq_client_entry(user_id, client_id, entry_type)` for idempotent upserts |
| `0003_blobs.py` | `blobs` |
| `0004_groups.py` | `groups`, `group_memberships`; indexes: `idx_groups_owner_id(owner_id)`, `idx_gm_user(group_memberships.user_id)` |
| `0005_admin.py` | Adds `suspended_at` column to `users` |

`migrations/env.py` imports all models from all modules to ensure Alembic's autogenerate detects schema changes.

---

## 18. Infrastructure / Deployment

### Docker Compose (`docker-compose.yml`)

Four services:
- **`api`** — `uvicorn src.main:app --host 0.0.0.0 --port 8000 --reload`. Depends on `db` (healthcheck) and `redis`.
- **`worker`** — `celery -A src.worker.app worker -c 4 -l info`. Same image, same dependencies. Concurrency: 4.
- **`db`** — `postgres:16-alpine`. Persistent volume `pg_data`. Healthcheck: `pg_isready`.
- **`redis`** — `redis:7-alpine` with `--appendonly yes` (AOF persistence). Volume `redis_data`.

Note: MinIO is not in the compose file; expected to be configured via `.env` pointing to an external S3-compatible endpoint.

### Dockerfile

```
FROM python:3.12-slim
RUN pip install uv
COPY pyproject.toml .
RUN uv pip install --system --no-cache -e .
COPY . .
EXPOSE 8000
CMD ["uvicorn", "src.main:app", "--host", "0.0.0.0", "--port", "8000"]
```

Uses `uv` for fast dependency resolution. Runs both API and Worker from the same image.

> **Version discrepancy**: `.python-version` specifies `3.14` and `pyproject.toml` requires `requires-python = ">=3.14"`, but the `Dockerfile` uses `python:3.12-slim`. The Docker image has not been updated to match the declared runtime version.

---

## 19. Test Suite (`tests/`)

`conftest.py` provides:
- **RSA keypair** generated at test startup (injected into `settings`)
- **`test_engine`** — real PostgreSQL (`postgresql+asyncpg://postgres:postgres@localhost:5432/clipboard_test`), using `join_transaction_mode="create_savepoint"` so each test rolls back via savepoint without dropping tables
- **`FakeRedis`** (via `fakeredis` package) — injected as the Redis dependency; Celery tasks monkeypatched to no-ops
- **`db_session` + `client` fixtures** — `httpx.AsyncClient` with dep overrides
- **`auth_headers`** fixture — performs a full register → verify-email → login flow to produce real tokens; does not forge JWTs
- **Celery mock** — replaces `.delay()` with a no-op

**`test_auth.py`**: register, duplicate email (409), verify email flow, login (returns kdf_salt), refresh token rotation, device list, password reset request + confirm, JWKS endpoint, healthz.

**`test_sync.py`**: single push, batch push, LWW reject (stale update), tombstone always wins, pull empty, pull with entries, cursor pagination, status endpoint, update cursor.

**`test_blobs.py`**: request-upload reachability, quota check.

---

## 20. Key Design Invariants

- **Server is blind** — `encrypted_content` and `encrypted_metadata` are opaque blobs to the server. The only plaintext fields are: entry type/kind, timestamps, pinned flag, group UUIDs.
- **`server_ts` is the single sync clock** — all pull queries and cursor tracking use server-assigned millisecond timestamps, not client-provided ones. Client timestamps are stored for display but never used for ordering.
- **Tombstone-wins** — a delete (non-null `deleted_at`) always overrides any conflicting update, regardless of timestamp. This prevents resurrections.
- **Refresh token rotation is one-shot** — using a refresh token immediately invalidates it. Second use → device revoked (stolen token mitigation).
- **Invite codes expire** — pool groups 72h, live_share 24h. Can be rotated by the owner.
- **Group keys never transit in plaintext** — `wrapped_group_key` per membership means the server stores encrypted keys that only the member's device can unwrap.
- **Redis pub/sub is ephemeral** — if no subscribers are listening when an event fires, it's lost. The pull endpoint is the reliable recovery path; WebSocket is the fast path for connected clients.
- **Two-phase blob upload** — the API server never handles raw blob bytes. The presigned URL approach means binary data goes directly client → S3 → client, keeping API latency low and server memory footprint small.
