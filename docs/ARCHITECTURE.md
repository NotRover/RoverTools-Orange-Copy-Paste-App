# RoverTools — Smart Clipboard System Architecture

> **Scope:** Cross-system reference — the app ↔ backend integration contract and
> shared invariants. This is the *only* workspace-level architecture doc; the
> per-submodule deep dives are authoritative for internals:
> - Desktop app: `orange-copy-paste-clipboard-app-rust/docs/ARCHITECTURE.md`
> - Backend: `orange-copy-paste-clipboard-backend/docs/ARCHITECTURE.md`
>
> **Backend stack:** FastAPI + Supabase (Postgres + Auth) + Redis + S3-compatible
> blob storage. No Celery/worker. See the backend deep dive for module detail.

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [Component Map](#2-component-map)
3. [Data Domains & Ownership](#3-data-domains--ownership)
4. [Integration Contract](#4-integration-contract)
5. [Auth & Device Identity Flow](#5-auth--device-identity-flow)
6. [Sync Protocol](#6-sync-protocol)
7. [Realtime Sharing Flow](#7-realtime-sharing-flow)
8. [E2E Encryption Boundary](#8-e2e-encryption-boundary)
9. [Offline-First Guarantee](#9-offline-first-guarantee)
10. [Group Sharing Model](#10-group-sharing-model)
11. [Desktop App Changes for Cloud](#11-desktop-app-changes-for-cloud)
12. [Deployment Topology](#12-deployment-topology)
13. [Cross-Component Invariants](#13-cross-component-invariants)

---

## 1. System Overview

The system is composed of two independently deployable components that collaborate to provide cloud sync, realtime clipboard sharing, and group-based collaboration on top of an already-functional offline desktop app.

```
┌──────────────────────────────────────────────────────────────────────────┐
│  User's Machine A                         User's Machine B               │
│                                                                          │
│  ┌─────────────────────────┐              ┌─────────────────────────┐   │
│  │   Desktop App (Tauri)   │              │   Desktop App (Tauri)   │   │
│  │                         │              │                         │   │
│  │  React UI               │              │  React UI               │   │
│  │  Rust/Tauri backend     │              │  Rust/Tauri backend     │   │
│  │  Local store (MsgPack)  │              │  Local store (MsgPack)  │   │
│  │  ┌───────────────────┐  │              │  ┌───────────────────┐  │   │
│  │  │ SyncClient (Rust) │  │              │  │ SyncClient (Rust) │  │   │
│  │  └────────┬──────────┘  │              │  └────────┬──────────┘  │   │
│  └───────────┼─────────────┘              └───────────┼─────────────┘   │
│              │ HTTPS + WSS                            │ HTTPS + WSS      │
└──────────────┼────────────────────────────────────────┼─────────────────┘
               │                                        │
               ▼                                        ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                Backend (FastAPI + uvicorn) — stateless, ×N              │
│                                                                         │
│   /api/v1/sync   /api/v1/settings   /api/v1/groups   /api/v1/blobs     │
│   /api/v1/sharing (Live Share, ≤5)   /api/v1/auth (profile/devices/    │
│   keys)   /ws   /internal/healthz                                       │
│                                                                         │
│   Supabase             Redis 7            S3 / Cloudflare R2            │
│   (Postgres + Auth)    (pub/sub +         (encrypted blobs, ≤5 MB)     │
│                         presence)                                       │
└─────────────────────────────────────────────────────────────────────────┘
```

**Design principles:**
- The desktop app is always the source of truth for the local device. The backend is a relay and durable store for cross-device sync — not an authoritative source.
- All sensitive content is encrypted on the device before it reaches the network. The server stores and forwards ciphertext only.
- Cloud features are optional and additive. The app runs identically with sync disabled or the server unreachable.

---

## 2. Component Map

| Component | Technology | Role |
|---|---|---|
| Desktop App UI | React 19 + TypeScript + Vite | Clipboard history, notes, settings, sync status, sharing UI |
| Desktop App Backend | Rust + Tauri 2 | OS integrations, clipboard capture, local persistence, IPC |
| Desktop Sync Module | Rust (`src-tauri/src/sync/`) | HTTP client, WebSocket listener, encryption, offline queue |
| Web Backend | Python 3.14 + FastAPI (stateless, ×N) | Sync relay, settings, group/Live Share management, blob URL brokering, realtime |
| Identity / Auth | Supabase Auth (GoTrue) | Signup, email verify, password reset, sessions, JWT issuance |
| Primary Store | Supabase Postgres 16 | Profiles, devices, sync entries (encrypted), groups, Live Share sessions |
| Pub/Sub + Presence | Redis 7 | Realtime fan-out + device presence |
| Background jobs | In-process (Postgres advisory lock) | Presence sweep + orphan-blob cleanup; email via `BackgroundTasks` |
| Blob Store | Cloudflare R2 (S3 API) | Image, binary, file, and video clipboard content (≤ 5 MB per entry) |

---

## 3. Data Domains & Ownership

### 3.1 Desktop App owns (local)
- Raw clipboard history (`history.bin`, `notes.bin`) — plaintext, MessagePack
- Externalized image files (`{app_data}/images/`)
- Settings and window state
- Pending sync queue (`sync_pending.json`) when offline
- Client-side ID mapping (`id_map.json`): local `client_id → server_id`
- Encryption keys: User Master Key (in memory), Device private key (OS keychain)

### 3.2 Backend owns (cloud)
- Profiles (linked to Supabase Auth users) and the device registry — accounts, passwords, and verification are owned by **Supabase Auth**
- Encrypted sync entries (server sees ciphertext + metadata shell)
- Sync cursors (per-device high-water marks)
- Group definitions and membership (team pool groups + Live Share groups, up to 5 members)
- Blob metadata and pre-signed URL generation
- Per-member wrapped group keys (for E2E group sharing)
- Live Share session definitions: per-member scope (`clipboard` | `notes` | `both`)
- Encrypted user settings blob (`user_settings` table — one row per user, server never decrypts)

### 3.3 Shared domain objects

The same logical entities exist in both systems with different representations:

| Entity | Desktop (Rust) | Backend (PostgreSQL) |
|---|---|---|
| Clipboard entry | `ClipboardEntry { id, kind, content, timestamp, pinned, groups, label }` | `sync_entries { client_id, user_id, device_id, entry_type="clipboard", kind, encrypted_content, encrypted_metadata, server_ts, ... }` |
| Note | `Note { id, title, content, created_at, updated_at, pinned, groups }` | `sync_entries { client_id, entry_type="note", encrypted_content, encrypted_metadata, ... }` |
| Group tag | `Vec<String>` (flat list per entry) | `group_ids UUID[]` (server-side) + group names in `encrypted_metadata` |

**Key distinction:** The desktop app uses local sequential integer IDs. The backend assigns UUIDs (`server_id`). The sync module maintains the mapping between them.

---

## 4. Integration Contract

### 4.1 Transport
- All HTTP communication: HTTPS (TLS 1.2+)
- All WebSocket communication: WSS
- Content-Type: `application/json` for all REST endpoints
- Image/binary uploads: client → S3 directly via pre-signed PUT URL (backend never buffers blob bytes)

### 4.2 Authentication
- Access token: **Supabase-issued JWT** (HS256). Signup, login, refresh, email
  verification, and password reset all go to **Supabase Auth directly** — not the backend.
- The backend only **verifies** the JWT (project JWT secret, audience `authenticated`).
- Header: `Authorization: Bearer <supabase access token>`, plus
  `X-Device-Id: <device_id>` on device-scoped routes (sync, settings, key registration).
- Bootstrap: after Supabase login the client calls `POST /api/v1/auth/bootstrap`
  (returns `kdf_salt`) and `POST /api/v1/auth/devices` (returns `device_id`).
- WebSocket: `GET /ws?token=<supabase access token>&device_id=<device_id>`

### 4.3 Base API URL
```
Production:  https://api.orangeclipboard.app/api/v1
Development: http://localhost:8000/api/v1
Self-hosted: configurable via Settings → Cloud Sync → Server URL
```

### 4.4 Entry push payload (desktop → server)
```jsonc
{
  "entries": [{
    "client_id": "42",                   // Tauri local ID
    "entry_type": "clipboard",           // or "note"
    "kind": "text",                      // text | image | file | html
    "encrypted_content": "<base64>",     // AES-256-GCM ciphertext
    "encrypted_metadata": "<base64>",   // groups, label, pinned, note_title
    "created_at": 1713225600000,
    "updated_at": 1713225600000,
    "pinned": false,
    "deleted_at": null,                  // set for tombstones
    "blob_key": null,                    // S3 key for image/file/video entries (≤ 5 MB)
    "group_ids": []                      // server-side group UUIDs (team groups + Live Share group UUIDs)
  }]
}
```

### 4.5 Entry pull payload (server → desktop)
```jsonc
{
  "entries": [{
    "id": "<uuid>",                      // server_id
    "client_id": "42",
    "device_id": "<uuid>",
    "entry_type": "clipboard",
    "kind": "text",
    "encrypted_content": "<base64>",
    "encrypted_metadata": "<base64>",
    "created_at": 1713225600000,
    "updated_at": 1713225600000,
    "server_ts": 1713225601234,
    "deleted_at": null,
    "pinned": false,
    "blob_key": null,
    "group_ids": []
  }],
  "next_cursor": 1713225601234           // null when caught up
}
```

### 4.6 WebSocket event envelope (server → desktop)
```jsonc
{ "event": "<event_name>", "payload": { ... } }
```

| Event | Trigger | Payload |
|---|---|---|
| `sync:entry` | Another device pushed an entry | Full entry object (encrypted) |
| `sync:delete` | Another device tombstoned an entry | `{ server_id, deleted_at }` |
| `device:online` | A device in the user's account connected | `{ device_id }` |
| `device:offline` | A device disconnected or timed out | `{ device_id }` |
| `group:membership_changed` | User joined or left a group | `{ group_id, action, user_id }` |
| `group:rekey` | Group key was rotated (member removed) | `{ group_id, wrapped_group_key }` |
| `sharing:invite` | *(Reserved — not currently emitted; invites are delivered by email)* | `{ share_group_id, from_user, invite_code, expires_at }` |
| `sharing:accepted` | The invited user joined the share | `{ share_group_id, new_member, wrapped_group_key }` |
| `sharing:ended` | Either party ended the sharing session | `{ share_group_id, ended_by }` |
| `sharing:scope_changed` | A peer updated their contribution scope | `{ share_group_id, user_id, share_scope }` |
| `settings:updated` | Another device pushed new settings | `{ updated_at }` — pull and apply if newer than local |
| `ping` | Server heartbeat (every 25s) | `{ server_ts }` |

---

## 5. Auth & Device Identity Flow

Identity is owned by **Supabase Auth**; the backend layers profile + device + key
state on top. The password does double duty: it authenticates to Supabase **and**
derives the UMK locally.

```
First launch (no account):
  App works fully offline — no auth required.

Sign-up / login:
  User → Settings → Cloud Sync → Create Account / Log In
  App → Supabase Auth (GoTrue): sign up / verify email / log in
        → holds a Supabase access token (JWT, sub = user id) + refresh token
  App → POST /api/v1/auth/bootstrap { display_name? }   (Authorization: Bearer <JWT>)
        → returns kdf_salt (created on first call, stable thereafter)
  App derives UMK = Argon2id(password, kdf_salt)  [in memory only]
  App → POST /api/v1/auth/devices { device_name, platform, ... } → { device_id }
        (persist device_id; send as X-Device-Id on subsequent calls)
  App generates X25519 device keypair
  App → POST /api/v1/auth/keys/register { identity_pubkey, device_pubkey }
  Sync begins

Subsequent launch:
  App restores the Supabase session (refresh handled by the Supabase client)
  App prompts password re-entry to re-derive UMK (never persisted)
  Sync client connects to WebSocket (?token=<JWT>&device_id=<device_id>)

New device (same account):
  New device signs in via Supabase, bootstraps, registers a device_id + device_pubkey
  User approves on an existing device:
    Existing device computes shared_secret = X25519(my_privkey, new_device_pubkey)
    wrapped_umk = AES-256-GCM(shared_secret, UMK)
    → POST /api/v1/auth/devices/{new_device_id}/key-wrap { wrapped_umk }
  New device fetches its wrapped_umk, derives shared_secret, decrypts UMK
  New device can now decrypt all sync entries
```

---

## 6. Sync Protocol

### 6.1 Sync lifecycle

```
On app startup (sync enabled, network available):
  1. Ensure a valid Supabase access token (refresh via the Supabase client if needed)
  2. Pull delta: GET /sync/pull?after_ts={last_cursor}&limit=200
     Repeat until next_cursor = null
  3. Decrypt pulled entries, merge into local store
  4. Push any pending entries from sync_pending.json
  5. Connect WebSocket
  6. Normal operation: push on capture, receive on WS event

On new clipboard capture:
  1. Entry stored in local history.bin (plaintext)
  2. Sync module encrypts entry with UMK → encrypted_content
  3. Encrypts metadata (groups, label, pinned) → encrypted_metadata
  4. POST /sync/push [entry]
  5. Server assigns server_ts, publishes to Redis
  6. Other connected devices receive sync:entry via WebSocket

On WebSocket sync:entry received:
  1. Decrypt encrypted_content with UMK → plaintext
  2. Check client_id against local store (skip if already have it)
  3. Insert into local history / notes store
  4. Emit Tauri event → React UI updates
  5. POST /sync/cursor { last_server_ts }
```

### 6.2 Cursor tracking

Each device maintains `last_server_ts` (persisted in `id_map.json` or a dedicated `sync_state.json`). This is the `server_ts` of the last entry successfully pulled. Delta pulls are always `WHERE server_ts > last_cursor`.

### 6.3 Conflict resolution

| Scenario | Resolution |
|---|---|
| Two devices push same `client_id` | Last HTTP request wins; server assigns new `server_ts` |
| Entry deleted on one device, updated on another | Tombstone always wins |
| Pin state diverges | Last `server_ts` write wins |
| Note content diverges | Last write wins; no content merge |

### 6.4 Offline queue

When the network is unavailable, the sync module accumulates entries in `{app_data}/sync_pending.json`:
```jsonc
[
  { "type": "push", "entry": { ...encrypted_entry } },
  { "type": "delete", "client_id": "42" }
]
```
On reconnect, the queue is flushed in order before pulling delta, ensuring local actions take precedence in LWW ordering.

### 6.5 Settings Sync

User preferences are synced as a single encrypted blob, separate from the entry sync stream.

**What is synced (user preferences — follow the user across devices):**

| Setting | Storage source | Notes |
|---|---|---|
| Theme (dark/light) | `localStorage` | |
| Layout (tiles/list) | `localStorage` | |
| Sort order | `localStorage` | |
| Paste slot count | `localStorage` | |
| Group names | `localStorage` | |
| Group color assignments | `localStorage` | |
| Notifications master toggle | `settings.json` | |
| Copy notification | `settings.json` | |
| Paste notification | `settings.json` | |
| Persist history | `settings.json` | |
| Close to tray | `settings.json` | |
| Start minimized | `settings.json` | |
| Autosave | `settings.json` | |
| Sharing notify | `settings.json` | |

**What is NOT synced (device-specific — stay local):**

- `sync_enabled` — each device decides independently whether sync is on
- `sync_server_url` — device may point to a self-hosted instance
- `sharing_enabled` — device-level kill switch
- Window geometry (`window-state.json`)
- Autostart (OS-specific registry/startup entry)
- Recent searches

**Flow:**

```
On any synced setting change (debounced 2s):
  Client builds plaintext settings JSON from localStorage + settings.json
  Client encrypts with UMK → encrypted_blob
  Client → PUT /api/v1/settings { encrypted_blob, updated_at: now() }
  Server → LWW: if server updated_at > client updated_at, returns server blob + winner: 'server'
  If winner == 'server': client decrypts server blob and applies to local settings

On startup (after auth):
  Client → GET /api/v1/settings
  If 404: no settings pushed yet, use local defaults
  If server updated_at > local updated_at: decrypt and apply
  If local updated_at > server updated_at: push local settings to server

On receiving settings:updated WS event:
  Client → GET /api/v1/settings
  Decrypt and apply if server updated_at > local
```

**Applying to the frontend:**
The Rust sync module emits a `sync:settings` Tauri event with the decrypted settings JSON. React listens and applies `localStorage`-backed settings (theme, layout, sort, paste slots, group names, group colors). The Rust layer writes `settings.json`-backed settings directly.

---

## 7. Realtime Sharing Flow

```
Device A (clipboard capture)
  │
  ├── Store in local history.bin
  ├── Encrypt entry
  └── POST /api/v1/sync/push [entry]
         │
         ▼
      Backend (sync service)
         │
         ├── Upsert sync_entries (assign server_ts)
         └── redis.publish("user:{user_id}", sync:entry event)
                │
                ▼
            Redis pub/sub
                │
         ┌──────┴──────┐
         ▼             ▼
     (WebSocket    (WebSocket
      Hub WS A)    Hub WS B)
         │             │
         │ filtered:   │ delivered to
         │ skip orig.  │ Device B
         ▼             ▼
      (dropped)    Device B WebSocket
                       │
                   Decrypt entry
                   Insert local store
                   Tauri event → UI update
```

**Latency target:** < 500ms end-to-end for text entries on the same continent.

**Group sharing:** Same flow, but `redis.publish` fans out to `group:{group_id}` channels in addition to `user:{user_id}`. All group members with active WebSocket connections receive the entry.

**Live Share (multi-user real-time sharing):** Uses the same group fan-out path. The sync client automatically appends active Live Share group UUIDs to `entry.group_ids` for entries that match the user's configured `share_scope` (`clipboard`, `notes`, or `both`). All other members of the Live Share group receive these entries via the group channel and merge them into the appropriate local store. Up to 5 users per group. File and video entries are included if total size ≤ 5 MB; larger entries are skipped and flagged in the sync status UI.

---

## 8. E2E Encryption Boundary

```
                    Device                           Network / Server
┌──────────────────────────────────┐    ┌───────────────────────────────┐
│                                  │    │                               │
│  Raw content (plaintext)         │    │  encrypted_content (base64)   │
│  ─────────────────────           │    │  ─────────────────────────    │
│  "Hello from clipboard"          │    │  "aGVsbG8uLi4..."             │
│                                  │    │                               │
│  encrypt(UMK, content, aad)  ────┼───►│  stored in sync_entries       │
│                                  │    │  relayed to other devices     │
│  decrypt(UMK, ciphertext)    ◄───┼────│                               │
│                                  │    │                               │
│  UMK = Argon2id(password,        │    │  server sees: timestamps,     │
│          kdf_salt)               │    │  entry type, blob keys,       │
│  [memory only, never on disk]    │    │  group membership             │
│                                  │    │  NEVER: plaintext             │
└──────────────────────────────────┘    └───────────────────────────────┘
```

**Encryption scheme:**
- Algorithm: AES-256-GCM
- Key: User Master Key (UMK), 32 bytes, derived via Argon2id
- Nonce: 12 random bytes prepended to ciphertext, fresh per encryption
- AAD: `client_id` — binds ciphertext to its entry
- Wire format: `base64(nonce || ciphertext || auth_tag)`

**What is encrypted:**
- `encrypted_content`: full entry content (text, HTML, image data-URL, file paths)
- `encrypted_metadata`: `{ groups, label, pinned, note_title }` as JSON

**What is NOT encrypted (server-visible):**
- `entry_type` (clipboard | note)
- `kind` (text | image | file | html) — needed for blob routing
- Timestamps (`created_at`, `updated_at`, `server_ts`)
- `blob_key` — needed for pre-signed URL generation
- Group membership (user_id ↔ group UUID) — needed for fan-out
- Group name — needed for invite UX

**Group encryption:** Group entries use a Group Key (GK) instead of UMK. GK is distributed to members as per-member AES-wrapped copies (see §10).

---

## 9. Offline-First Guarantee

The desktop app's behavior must not change whether sync is enabled or not:

| Concern | Behavior |
|---|---|
| Clipboard capture | Always works; sync is a side-effect, not a requirement |
| Local search/filter | Always works against local store |
| Paste popup | Always works from local history |
| Notes CRUD | Always works locally |
| App startup | Does not block on network; sync runs in background |
| Network error | Logged + retry with exponential backoff (1s → 60s max) |
| Auth expiry | Sync pauses; UI shows "Re-login required"; app fully usable |
| Server unreachable | App works; pending queue accumulates; syncs on reconnect |

**Implementation rule:** The sync module runs in a dedicated Tokio background runtime. It must never hold a lock that blocks the main app runtime. All sync operations are fire-and-forget from the app's perspective.

---

## 10. Group Sharing Model

### 10.1 Group types
- **Personal group tag**: a string label on an entry/note, local only (e.g. "Work", "Saved"). Not a server-side group.
- **Shared group**: a server-side entity with members; entries pushed to a shared group are visible to all members.

### 10.2 Group key lifecycle
```
Owner creates group:
  1. Generates random 32-byte Group Key (GK)
  2. For each member: wraps GK using X25519(owner_privkey, member_identity_pubkey)
  3. POST /groups/{id}/keys { wrapped_keys: [{ user_id, wrapped_group_key }] }
  4. Server stores wrapped_group_key per member in group_memberships

Member joins:
  1. POST /groups/join { invite_code, wrapped_group_key=null }
  2. Server notifies owner via WS: group:membership_changed
  3. Owner fetches new member's identity_pubkey
  4. Owner wraps GK for new member: POST /groups/{id}/keys [{ user_id: new_member, ... }]
  5. New member receives wrapped_group_key in next pull or WS event

Member removed / group key rotation:
  1. Owner removes member: DELETE /groups/{id}/members/{user_id}
  2. Owner generates new GK
  3. Re-wraps for all remaining members
  4. POST /groups/{id}/keys (new wrapped keys for all)
  5. Server publishes group:rekey event to all connected members
  6. Each member replaces their cached GK

Entry pushed to group:
  encrypted_content = AES-256-GCM(key=GK, plaintext=content)
  encrypted_metadata includes group_ids=[group_uuid]
  Server fans out to group:{group_id} Redis channel
```

### 10.3 Personal tag vs shared group disambiguation (desktop app)
The desktop app uses string group names locally. When sync is enabled:
- If a group name matches a joined shared group name → entry is associated with that server group UUID
- Otherwise → group name stays in `encrypted_metadata` only (server-invisible personal tag)
- The sync module resolves this mapping on first sync using a local `groups_map.json`

### 10.4 Live Share (multi-user real-time clipboard/notes sharing)

A **Live Share** is a specialised group (`group_type: 'live_share'`, `max_members: 5`) of 2–5 different user accounts. It enables real-time cross-user clipboard and/or notes mirroring.

- **Scope** is per-member: each user independently chooses `clipboard` | `notes` | `both` — controlling what *they contribute* to the group, not what they receive.
- **Establishment:** Owner creates a Live Share session and invites up to 4 others by email. Each invited user accepts and receives the Group Key via X25519 key exchange (same mechanism as team group keys).
- **Live flow:** On each captured entry, the sync client checks active Live Share groups. If the `entry_type` matches the user's scope, the group UUID is included in `entry.group_ids`. The entry is encrypted with the Live Share Group Key. The server fans it out to all other members via the existing group channel.
- **File/video limit:** Files and videos are shared only if total entry size ≤ 5 MB. Entries exceeding the limit are skipped with a UI notification.
- **Termination:** Owner dissolves the group (all members removed). Non-owner members can leave individually. Existing shared entries remain in each user's local store.
- **Privacy:** The server sees that users share a Live Share group but cannot read the content — all entries are E2E encrypted with the Live Share Group Key, which the server cannot derive.

---

## 11. Desktop App Changes for Cloud

The following additions are needed in `orange-copy-paste-clipboard-app-rust` to support cloud sync. **All changes are additive** — no existing capture, storage, or popup logic changes.

### 11.1 New Tauri module: `src-tauri/src/sync/`

```
src-tauri/src/sync/
  mod.rs              -- SyncClient init, background runtime
  client.rs           -- reqwest HTTP client, token refresh middleware
  ws_listener.rs      -- WebSocket connection, event dispatch to Tauri event system
  pending_queue.rs    -- sync_pending.json read/write
  crypto.rs           -- UMK derivation (Argon2id), AES-256-GCM, X25519
  commands.rs         -- Tauri commands exposed to React UI
  config.rs           -- server URL, sync enabled flag, persisted in settings.json
```

### 11.2 New Cargo dependencies
```toml
reqwest        = { version = "0.12", features = ["json", "rustls-tls"] }
tokio-tungstenite = { version = "0.23", features = ["rustls-tls-webpki-roots"] }
argon2         = "0.5"
aes-gcm        = "0.10"
x25519-dalek   = "2"
keyring        = "2"      # OS credential store (refresh token, device private key)
```

### 11.3 New Tauri commands (frontend-accessible)
```
sync_login(email, password, device_name) → Result<SyncUser>
sync_logout()
sync_get_user()                          → Option<SyncUser>
sync_get_status()                        → SyncStatus
  // { connected: bool, last_synced_at: Option<u64>, pending_count: u32 }
sync_now()
sync_set_enabled(enabled: bool)
sync_set_server_url(url: String)
sync_get_groups()                        → Vec<SyncGroup>
sync_create_group(name: String)          → SyncGroup
sync_join_group(invite_code: String)
sync_leave_group(group_id: String)
sync_push_settings()                     // encrypt settings blob → PUT /settings; debounced 2s
sync_pull_settings()                     // GET /settings; decrypt; emit sync:settings if server wins
sync_receive_local_settings(json: String) // React → Rust bridge: pass localStorage values for next push
sharing_invite(email: String, scope: String)    → SharingInvite
sharing_accept(invite_code: String, scope: String)
sharing_get_sessions()                          → Vec<SharingSession>
sharing_update_scope(share_group_id: String, scope: String)
sharing_end_session(share_group_id: String)     // owner dissolves group
sharing_leave_session(share_group_id: String)   // non-owner leaves group
```

### 11.4 Integration points (existing files touched minimally)

| File | Change |
|---|---|
| `src-tauri/src/lib.rs` | Register sync commands; initialize SyncClient in `setup()` |
| `src-tauri/src/clipboard/history.rs` | Add `server_id: Option<String>` field (not persisted to `history.bin`); add `load_remote_entry()` method |
| `src-tauri/src/notes/store.rs` | Same: `server_id` field + `load_remote_note()` |
| `src-tauri/src/state/app_state.rs` | Add `sync_client: Option<Arc<SyncClient>>` |
| `src/components/app/App.tsx` | Listen for `sync:entry` and `sync:note` Tauri events to refresh history/notes |

### 11.5 New React UI (settings screen additions)
- Cloud Sync toggle (enable/disable)
- Server URL input (self-hosted support)
- Login / logout form
- Connected devices list
- Sync status indicator: Synced / Syncing / Offline / Re-login required
- Per-entry cloud icon (synced ✓ / pending ○ / local-only —)
- Shared Groups panel: list, create, invite, leave
- Live Share panel: active sessions (member list, individual scopes, online status), create new Live Share, invite member, accept invite, change own scope, leave session, end session (owner only)
- File sync skip notification: when a file/video entry is too large to sync (> 5 MB), a dismissible notice in sync status

---

## 12. Deployment Topology

### Development
```
localhost:5173   Vite dev server (React hot reload)
localhost:1420   Tauri webview (app window)
localhost:8000   FastAPI (uvicorn --reload)
localhost:5432   PostgreSQL (Docker)
localhost:6379   Redis (Docker)
localhost:9000   MinIO (Docker, S3 API)
localhost:9001   MinIO Console
```

### Production
```
                  DNS: api.orangeclipboard.app
                         │
                     ┌───▼───┐
                     │ LB /  │  TLS termination
                     │ nginx │  /ws → WS upgrade (long read timeout)
                     └───┬───┘
                         │
              ┌──────────┼──────────┐
              ▼          ▼          ▼
         FastAPI(1)  FastAPI(2)  FastAPI(3)     ← stateless replicas, scale freely
              └──────────┬──────────┘
             ┌───────────┼───────────────┐
             ▼           ▼               ▼
        Supabase      Redis           Cloudflare R2
        (Postgres     (managed,       (encrypted blobs,
         + Auth)       pub/sub +       zero egress)
                       presence)
```

- **Supabase** (managed) owns Postgres + Auth. Point `DATABASE_URL` at the Supabase
  connection string and set `SUPABASE_URL` / `SUPABASE_JWT_SECRET`.
- **FastAPI** is stateless — realtime fan-out + presence are coordinated through
  Redis, so any replica can serve any client (no sticky sessions).
- **Background jobs** (presence sweep, orphan-blob cleanup) run in-process under a
  Postgres advisory lock so exactly one replica runs them; email via `BackgroundTasks`.
  There is **no Celery/worker process**.

### Scale-out
- API tier: add stateless FastAPI replicas behind the load balancer (no code changes).
- Database + Auth: already managed (Supabase).
- Cache: managed Redis (e.g. Upstash).
- Blob: R2 already external.
- WebSocket fan-out: Redis pub/sub is already multi-process safe.

---

## 13. Cross-Component Invariants

These constraints must be preserved across any change to either submodule:

| # | Invariant |
|---|---|
| 1 | **Local store is always plaintext.** `history.bin` and `notes.bin` are never encrypted. The encryption boundary is the network. |
| 2 | **Sync is always optional.** The app works fully without a network connection or server. Sync may be disabled at any time. |
| 3 | **Server never sees plaintext content.** `encrypted_content` and `encrypted_metadata` must be encrypted on-device before any network call. |
| 4 | **UMK never leaves the device.** It lives in memory only, derived from the user's password + `kdf_salt` at login. Cleared on lock or exit. |
| 5 | **Tombstones always propagate.** A `deleted_at` value on a sync entry must be honoured by the receiving device. Deletion wins over concurrent update. |
| 6 | **Capture pipeline is untouched.** The clipboard watcher and suppress-flag flow must not be modified by sync logic. Sync is a post-capture side-effect. |
| 7 | **Pin/group operations sync bidirectionally.** A pin or group change on any device must propagate to all other devices for that entry. |
| 8 | **Group key rotation on member removal.** Removing a group member must trigger a new Group Key and re-distribution to remaining members before new entries are pushed. |
| 9 | **Cursor advances only on confirmed receipt.** `POST /sync/cursor` is only called after entries are successfully decrypted and merged into local store. |
| 10 | **ID mapping is maintained.** The `client_id → server_id` mapping must be preserved across restarts. Losing it causes duplicate entries on the next push. |
| 11 | **Sharing is always opt-in.** No entry is tagged with a Live Share group UUID unless the user has an active Live Share session and the entry type matches their configured `share_scope`. |
| 12 | **File/video sync is size-gated.** Entries of `kind: 'file'` are never pushed to the server if their total payload exceeds 5 MB. This is enforced on both client and server (HTTP 413 from `request-upload`). |
| 13 | **Sharing ends cleanly.** When a Live Share session is terminated or a member leaves, the Live Share group UUID must be removed from `id_map.json` so no future entries are tagged with it. Existing entries in all users' local stores are not affected. |
| 14 | **Settings sync is encrypted.** The settings blob is encrypted with UMK on-device before `PUT /settings`. The server never sees plaintext preferences. |
| 15 | **Device-specific settings are never synced.** `sync_enabled`, `sync_server_url`, `sharing_enabled`, autostart, and window geometry must never be included in the settings blob. |
| 16 | **Settings sync is debounced.** Changes are batched and pushed at most once every 2 seconds. Never push on every keystroke. |
