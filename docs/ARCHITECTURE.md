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
10. [Spaces Sharing Model](#10-spaces-sharing-model)
11. [Desktop App Cloud Integration](#11-desktop-app-cloud-integration)
12. [Deployment Topology](#12-deployment-topology)
13. [Cross-Component Invariants](#13-cross-component-invariants)

---

## 1. System Overview

The system is composed of two independently deployable components that collaborate to provide personal cloud sync and realtime sharing through **spaces**, on top of an already-functional offline desktop app.

Two features, deliberately separate:

- **Cloud sync** — the user's own entries, backed up and mirrored across their own devices. Nobody else is involved.
- **Spaces** — a named room other users join, where members see the entries each other sends in. A space is the *only* sharing primitive; there is no second mode, no session type, and no member cap.

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
│   /api/v1/sync   /api/v1/settings   /api/v1/spaces   /api/v1/blobs     │
│   /api/v1/invites   /api/v1/auth (profile/devices/keys)                 │
│   /ws   /internal/healthz                                               │
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
| Desktop App UI | React 19 + TypeScript + Vite | Clipboard history, notes, settings, sync status, spaces UI |
| Desktop App Backend | Rust + Tauri 2 | OS integrations, clipboard capture, local persistence, IPC |
| Desktop Sync Module | Rust (`src-tauri/src/sync/`) | HTTP client, WebSocket listener, encryption, offline queue |
| Web Backend | Python 3.14 + FastAPI (stateless, ×N) | Sync relay, settings, spaces + invites, blob URL brokering, realtime |
| Identity / Auth | Supabase Auth (GoTrue) | Signup, email verify, password reset, sessions, JWT issuance |
| Primary Store | Supabase Postgres 16 | Profiles, devices, sync entries (encrypted), spaces, memberships, invites |
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
- Space definitions and membership (no member cap; `role` is `owner` or `member`)
- Blob metadata and pre-signed URL generation
- Per-member wrapped Space Key *keyrings* — opaque blobs the server cannot open (§10)
- Addressed space invites (one row per space + invitee email, with status)
- Encrypted user settings blob (`user_settings` table — one row per user, server never decrypts)

The server does **not** own send filters or auto-copy. Which entries flow into a space is a client-side decision; the filters roam inside the encrypted settings blob, and auto-copy is device-local in `settings.json`.

### 3.3 Shared domain objects

The same logical entities exist in both systems with different representations:

| Entity | Desktop (Rust) | Backend (PostgreSQL) |
|---|---|---|
| Clipboard entry | `ClipboardEntry { id, kind, content, timestamp, pinned, groups, label }` | `sync_entries { client_id, user_id, device_id, entry_type="clipboard", kind, encrypted_content, encrypted_metadata, server_ts, ... }` |
| Note | `Note { id, title, content, created_at, updated_at, pinned, groups }` | `sync_entries { client_id, entry_type="note", encrypted_content, encrypted_metadata, ... }` |
| Local group tag | `Vec<String>` (flat list per entry) | Names live inside `encrypted_metadata`; server-invisible |
| Space share | `id_map.json` share record per entry (`space_ids`) | `sync_entries.space_ids UUID[]` — server-visible, the fan-out targets |

**Key distinction:** The desktop app generates a UUID v4 per entry, which travels to the server as the `client_id`. The backend assigns its own UUID (`server_id`) as the row's primary key, and deduplicates on `(user_id, client_id, entry_type)`. The sync module keeps a `client_id → server_id` map in `id_map.json`; losing that file is safe, because the server dedupes on `client_id` regardless.

---

## 4. Integration Contract

### 4.1 Transport
- All HTTP communication: HTTPS (TLS 1.2+)
- All WebSocket communication: WSS
- Content-Type: `application/json` for all REST endpoints
- Image/binary uploads: client → S3 directly via pre-signed PUT URL (backend never buffers blob bytes)

### 4.2 Authentication
- Access token: **Supabase-issued JWT** (ES256/RS256 for current projects, legacy HS256 still
  accepted). Signup, login, refresh, email verification, and password reset all go to
  **Supabase Auth directly** — not the backend.
- The backend only **verifies** the JWT (project JWKS, or the shared secret for HS256;
  audience `authenticated`).
- Header: `Authorization: Bearer <supabase access token>`, plus
  `X-Device-Id: <device_id>` on device-scoped routes (sync, settings, key registration,
  spaces). Listing, accepting, and declining invites need only the token — they match on
  its `email` claim.
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
    "client_id": "<uuid>",               // the app's own entry ID
    "entry_type": "clipboard",           // or "note"
    "kind": "text",                      // text | image | file | html
    "encrypted_content": "<base64>",     // AES-256-GCM under this entry's CEK
    "encrypted_metadata": "<base64>",   // same CEK: local groups, label, pinned, note title
    "created_at": 1713225600000,
    "updated_at": 1713225600000,
    "pinned": false,
    "deleted_at": null,                  // set for tombstones; keep space_ids on them
    "blob_key": null,                    // S3 key for image/file/video entries (≤ 5 MB)
    "space_ids": [],                      // spaces to fan this entry out to; [] = personal only
    "wrapped_keys": "{\"personal\":\"…\",\"<space_id>\":\"…\"}"   // CEK envelope (§8)
  }]
}
```

### 4.5 Entry pull payload (server → desktop)
```jsonc
{
  "entries": [{
    "id": "<uuid>",                      // server_id
    "client_id": "<uuid>",
    "user_id": "<uuid>",                 // the author; not always the caller (space entries)
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
    "space_ids": [],
    "wrapped_keys": "{…}"
  }],
  "next_cursor": 1713225601234           // null when caught up
}
```

A pull returns the caller's own entries **plus** anything shared into a space they belong to (bounded by that membership's history floor, set from the space's `share_history` at join time). This is why an offline member still receives entries pushed while they were away: the WebSocket is the only other delivery path.

### 4.6 WebSocket event envelope (server → desktop)
```jsonc
{ "event": "<event_name>", "payload": { ... } }
```

| Event | Trigger | Payload |
|---|---|---|
| `sync:entry` | Another device or space member pushed an entry, including tombstones | Full entry object (encrypted) |
| `device:online` | A device in the user's own account connected | `{ device_id }` |
| `device:offline` | A device disconnected or timed out | `{ device_id }` |
| `user:presence` | A space member connected, or their last device left | `{ user_id, online }` |
| `space:entry_removed` | An entry left a space - withdrawn by its author, or taken down by the owner | `{ space_id, client_id, entry_type, author_id, removed_by }` |
| `space:membership_changed` | Someone joined or left a space, or the space was deleted | `{ space_id, action: "joined"\|"left"\|"deleted", user_id }` |
| `space:rekey` | The owner distributed a wrapped keyring to this member | `{ space_id, wrapped_space_keys }` |
| `invite:received` | Someone addressed a space invite to this user | Full invite object |
| `invite:updated` | An invite this user sent or received changed state | `{ invite_id, status, space_id }` |
| `settings:updated` | Another device pushed new settings | `{ updated_at }` — pull and apply if newer than local |
| `ping` | Server heartbeat (every 25s) | `{ server_ts }` |

There is no `sync:delete`: a delete arrives as `sync:entry` with `deleted_at` set. There are no `sharing:*` events — every one of them is gone.

`sync:entry` is published to the author's `user:` channel and to the `space:` channel of each id in `space_ids`, so a socket can see the same entry twice; dedupe on `(client_id, entry_type)`. The origin device is always excluded, so a device never receives its own push back.

**Client → server:** `{"event":"pong"}` / `{"event":"ack"}` refresh the presence TTL, and `{"event":"resubscribe"}` re-resolves the socket's channel set after a membership change so space fan-out starts or stops without reconnecting.

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
        → returns kdf_salt + wrapped_umk (created on first call, stable thereafter)
  App derives KEK = Argon2id(password, kdf_salt); unwraps random UMK from wrapped_umk
        (or, if wrapped_umk is null, generates a UMK, wraps it, PUT /auth/umk)  [memory only]
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
  2. Sync module resolves the target spaces (explicit shares + matching send filters)
  3. Mints a random per-entry content key (CEK); encrypts content and metadata under it
  4. Builds wrapped_keys: the CEK wrapped under the UMK ("personal") + once per target space
  5. POST /sync/push [entry] with space_ids + wrapped_keys
  6. Server assigns server_ts, publishes to user:{author} and each space:{id}
  7. Other devices and space members receive sync:entry via WebSocket

On WebSocket sync:entry received:
  1. Unwrap the CEK — "personal" under the UMK, else the space wrap against that
     space's keyring (newest key first) — then decrypt the content
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
| Per-space send filters | `settings.json` (`space_send_filters`) | Reference plaintext local group names, so they only ever travel inside the encrypted blob |

**What is NOT synced (device-specific — stay local):**

- `sync_enabled` — each device decides independently whether sync is on
- `sync_server_url` — device may point to a self-hosted instance
- `sync_mode` (`realtime` | `passive`) — a per-device choice about personal entries
- `space_autocopy:{space_id}` — writing incoming entries to the clipboard is per-device
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

**Space sharing:** the same flow, with `redis.publish` also fanning out to `space:{space_id}` for every id in the entry's `space_ids`. Every member with a live WebSocket receives the entry, unwraps its CEK with that space's key, and merges it into the appropriate local store. Members who were offline pick the same rows up on their next pull.

**What goes into a space** is decided entirely on the client, per entry, from two inputs: explicit shares (the user picking spaces for one entry) and that space's **send filter** (off by default; when on it can restrict by entry kind, local group name, and clipboard/notes/both). The server never sees either. A receiving device may additionally have **auto-copy** on for a space, which writes incoming entries straight to the OS clipboard — device-local, never synced.

**Size gate:** file and image entries ride in a blob and are pushed only if ≤ 5 MB. Larger entries are skipped, and each skip records the entry and a reason the sync status UI shows verbatim.

**Personal sync mode** is independent of all this: `realtime` applies WebSocket-delivered personal entries as they arrive, `passive` skips live application and lets a periodic pull (or "Sync now") collect them. Pushes are immediate in both modes, and **spaces are always realtime** regardless of the setting.

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
│  encrypt(CEK, content, aad)  ────┼───►│  stored in sync_entries       │
│  wrap(UMK, CEK) → "personal"     │    │  relayed to other devices     │
│  wrap(SpaceKey, CEK) → per space │    │  and to space members         │
│  decrypt(CEK, ciphertext)    ◄───┼────│                               │
│                                  │    │  server sees: timestamps,     │
│  UMK = random; wrapped under     │    │  entry type, blob keys,       │
│    KEK=Argon2id(password,salt)   │    │  space_ids, space membership  │
│  [memory only, never on disk]    │    │  NEVER: plaintext, any key    │
└──────────────────────────────────┘    └───────────────────────────────┘
```

**Encryption scheme:**
- Algorithm: AES-256-GCM, nonce 12 random bytes prepended, fresh per operation.
  Wire format `base64(nonce || ciphertext || auth_tag)`.
- **Content key (CEK):** 32 random bytes, minted **per entry** and never reused. Content and
  metadata are encrypted once under it, with `aad = client_id` binding the ciphertext to its
  entry.
- **Envelope (`wrapped_keys`):** a JSON map of wrapped copies of that CEK — `"personal"`
  wrapped under the UMK, plus one entry per space id wrapped under that space's current Space
  Key. Wraps use `aad = "key-wrap"`, so a wrapped key can't be replayed as content.
- **User Master Key (UMK):** 32 random bytes, stored server-side wrapped under
  `KEK = Argon2id(password, kdf_salt)` and unwrapped in memory at login.

Sharing an entry into three spaces therefore adds three small wraps, not three copies of the ciphertext, and every reader decrypts byte-identical content.

**What is encrypted:**
- `encrypted_content`: full entry content (text, HTML, image data-URL, file paths)
- `encrypted_metadata`: local group names, label / note title, pinned

**What is NOT encrypted (server-visible):**
- `entry_type` (clipboard | note)
- `kind` (text | image | file | html) — needed for blob routing
- Timestamps (`created_at`, `updated_at`, `server_ts`) and `pinned`
- `blob_key` — needed for pre-signed URL generation
- `space_ids` — needed for fan-out and for the pull query
- Space membership (user_id ↔ space UUID) and the space **name** — needed for invite UX,
  since an invitee sees the name before holding any key

`wrapped_keys` and the per-member wrapped keyrings are stored and echoed verbatim. The server holds no private key that could open either, so it can neither read an entry nor tell one wrap from another.

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

## 10. Spaces Sharing Model

A **space** is a named room, owned by its creator, that any number of other user accounts can join. Entries a member sends in are visible to every other member, in real time, end-to-end encrypted. It replaces the earlier pool-group / Live Share split: there is no `group_type`, no member cap, and no server-side scope.

### 10.1 What is and isn't a space
- **Local group tag** — a string label on an entry or note ("Work", "Saved"). Purely local; it rides inside `encrypted_metadata` and the server never sees it. Not a space, and never resolved into one.
- **Space** — a server-side entity with members and its own key. An entry reaches it only when the client puts the space's id in `space_ids` and adds a matching wrap to `wrapped_keys`.

The two are unrelated, which is a change from the earlier model: local group names are no longer matched against server-side names to infer sharing. Send filters may *reference* local group names as a condition, but that evaluation happens on the client.

### 10.2 Joining
```
Owner  → POST /spaces { name, share_history }  → { space_id, invite_code }
Join, either path:
  a) POST /spaces/join { invite_code }         -- bearer secret; anyone holding it can join
  b) POST /spaces/{id}/invites { email }       -- owner addresses an invite
     → invite:received to the invitee (+ best-effort email carrying the code)
     → POST /invites/{id}/accept
Both → space:membership_changed to the space channel and to the joiner
```

`share_history` decides whether a later joiner may read entries pushed before they joined. It is resolved into that member's history floor **at join time**, so flipping it later does not retroactively widen what an existing member can pull.

### 10.3 Space Key lifecycle
```
Owner mints a random 32-byte Space Key, wraps it per member with
X25519(owner_identity_priv, member_identity_pubkey), and posts the wraps:
  POST /spaces/{id}/keys { wrapped_keyrings: [{ user_id, wrapped_space_keys }] }

wrapped_space_keys is a KEYRING: a JSON array of wrapped keys, newest first.
Older keys are kept so entries written under them stay readable after a rekey —
they exist nowhere else but in client memory and these wraps.

Member removed, or leaves:
  1. DELETE /spaces/{id}/members/{user_id}
  2. Server clears EVERY remaining member's wrapped_space_keys and publishes
     space:membership_changed. That is the whole server-side mechanism.
  3. The owner's client sees members without keys, mints a new Space Key,
     PREPENDS it to the keyring, and redistributes via POST /spaces/{id}/keys
  4. Each member receives space:rekey and caches the whole ring

Entries only ever encrypt content under their own CEK; the Space Key wraps that
CEK (§8). Nothing is re-encrypted on a rekey.
```

Space Keys live in client memory only. Restart recovery comes from `GET /spaces`, which returns the caller's own `my_wrapped_space_keys` — `space:rekey` is fire-and-forget and nothing retries it.

### 10.4 Revocation is best-effort
Worth stating plainly, because the edges are real and not bugs to be fixed server-side:

- A member who already pulled or received an entry keeps the plaintext locally. A rekey changes what they can read **next**, never what they already read.
- Between the removal and the owner's redistribution, remaining members show as holding no key but keep decrypting with the ring already in memory. The state is transient and nothing breaks.
- If the owner's app restarts in that window, the previous ring is gone, and entries written under the old keys become unreadable for everyone including the owner.
- A rekey needs the owner online. Until then no new key exists, so a removed member holding the old key could still read entries pushed under it.

### 10.5 Deleting a space
The owner can delete a space (`DELETE /spaces/{id}`); a non-owner can only leave. Deletion publishes `space:membership_changed` with `action: "deleted"` before the row goes, then cascades memberships and invites. Entries keep their `space_ids`, but with no memberships left nobody can pull them, and clients drop and zeroize keyrings for spaces that stop coming back from `GET /spaces`. What members already decrypted stays in their local history.

---

## 11. Desktop App Cloud Integration

How cloud sync sits inside `orange-copy-paste-clipboard-app-rust`. **The integration is additive** — no existing capture, storage, or popup logic changed.

### 11.1 Tauri module: `src-tauri/src/sync/`

```
src-tauri/src/sync/
  mod.rs              -- SyncClient init, background Tokio runtime
  client.rs           -- reqwest HTTP client, Bearer + X-Device-Id injection, 401 refresh
  supabase.rs         -- Supabase Auth (GoTrue): login, signup, refresh, recovery, PKCE
  oauth.rs            -- Google sign-in via a loopback redirect server
  ws_listener.rs      -- WebSocket connection, event dispatch to Tauri event system
  pending_queue.rs    -- sync_pending.json read/write
  id_map.rs           -- client_id → server_id mapping (id_map.json)
  sync_state.rs       -- connection/status state surfaced to the UI
  persist.rs          -- cached session and sync metadata
  crypto.rs           -- UMK unwrap (Argon2id KEK), AES-256-GCM, X25519
  types.rs            -- wire types mirroring the backend contract
  commands.rs         -- Tauri commands exposed to React UI
  config.rs           -- server + Supabase endpoints, sync enabled flag
```

### 11.2 Cargo dependencies
```toml
reqwest           = { version = "0.12", features = ["json", "rustls-tls"] }
tokio-tungstenite = { version = "0.24", features = ["rustls-tls-webpki-roots", "connect"] }
argon2            = "0.5"
aes-gcm           = "0.10"
x25519-dalek      = { version = "2", features = ["static_secrets"] }
sha2              = "0.10"    # blob checksums
keyring           = "2"       # OS credential store (device private key, cached session)
zeroize           = { version = "1", features = ["derive"] }
open              = "5"       # system browser for the OAuth hop
```

### 11.3 Tauri commands (frontend-accessible)

Registered in `lib.rs`; see `src-tauri/src/sync/commands.rs` for exact signatures.
```
sync_login(email, password, …)           → Result<SyncUser>
sync_signup(…)                           // Supabase sign-up
sync_oauth_begin() / sync_oauth_complete() / sync_oauth_cancel()   // Google, loopback PKCE
sync_reset_password(email)               // Supabase recovery
sync_restore_session()                   // silent re-auth from cached session + device UMK wrap
sync_logout()
sync_get_user()                          → Option<SyncUser>
sync_get_status()                        → SyncStatus
sync_get_connection()                    → connection state for the UI
sync_now()
sync_set_enabled(enabled: bool)
sync_get_quota()                         → blob quota usage
sync_list_devices() / sync_revoke_device(device_id)
sync_get_entry_states() / sync_get_entry_shares() / sync_clear_skipped()
sync_set_mode(mode) / sync_get_mode()    // "realtime" | "passive"; personal entries only
spaces_list()                            → Vec<Space>   // refetch + reconcile keys
spaces_cached()                          → Vec<Space>   // last known, no network
space_create(name, share_history)        → Space
space_join(invite_code: String)
space_leave(space_id: String)
space_remove_member(…) / space_delete(space_id)
space_set_entry_shares(entry_id, entry_type, space_ids)  // re-pushes with the new share set
space_set_send_filter(space_id, filter) / space_get_send_filters()
space_set_autocopy(space_id, enabled)    // device-local; writes incoming entries to the clipboard
sync_list_invites() / sync_send_invite(…) / sync_accept_invite(…)
sync_decline_invite(…) / sync_revoke_invite(…)
sync_push_settings()                     // encrypt settings blob → PUT /settings; debounced 2s
sync_pull_settings()                     // GET /settings; decrypt; emit sync:settings if server wins
sync_receive_local_settings(json: String) // React → Rust bridge: pass localStorage values for next push
```

There are no `sharing_*` commands and no `sync_*_group` commands — spaces replaced both.

### 11.4 Integration points (existing files touched minimally)

| File | Change |
|---|---|
| `src-tauri/src/lib.rs` | Register sync commands; initialize SyncClient in `setup()` |
| `src-tauri/src/clipboard/history.rs` | Add `server_id: Option<String>` field (not persisted to `history.bin`); add `load_remote_entry()` method |
| `src-tauri/src/notes/store.rs` | Same: `server_id` field + `load_remote_note()` |
| `src-tauri/src/state/app_state.rs` | Add `sync_client: Option<Arc<SyncClient>>` |
| `src/components/app/App.tsx` | Listen for `sync:history-merged` / `sync:notes-merged` Tauri events to refresh history/notes |

### 11.5 React UI (account screen + settings additions)
- Cloud Sync toggle (enable/disable)
- Login / signup / Google sign-in / logout, with the account password prompt that establishes the E2E secret
- Endpoints are compiled in — there is deliberately **no** server URL input; self-hosting overrides them through `settings.json` (`sync_server_url`, `supabase_url`, `supabase_anon_key`)
- Connected devices list
- Sync status indicator: Synced / Syncing / Offline / Re-login required
- Per-entry cloud icon (synced ✓ / pending ○ / local-only —)
- Spaces screen (`src/components/app/spaces-screen/`): the spaces a user is in, their members with online state and whether each holds a key, plus create / join / invite / leave / delete
- Per-space controls: send filter (off by default), auto-copy toggle, invite code
- Per-entry share picker: choose which spaces one entry goes to, independent of any filter
- Invite inbox on the account screen: received invites to accept or decline, sent invites with their status
- File sync skip notification: when an entry is too large to sync (> 5 MB), a dismissible notice in sync status naming the entry and the reason

---

## 12. Deployment Topology

### Development
```
localhost:1420   Vite dev server, loaded by the Tauri webview (strict port)
localhost:1421   Vite HMR websocket
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
| 3 | **Server never sees plaintext content or any key.** `encrypted_content` and `encrypted_metadata` are encrypted on-device before any network call, and `wrapped_keys` / `wrapped_space_keys` stay opaque — the server holds no private key that could open either. |
| 4 | **UMK never leaves the device in the clear.** It lives in memory only, unwrapped at login with a key derived from the user's password + `kdf_salt`. The server holds only the wrapped envelope. Cleared on lock or exit. |
| 5 | **Tombstones always propagate.** A `deleted_at` value on a sync entry must be honoured by the receiving device. Deletion wins over concurrent update. |
| 6 | **Capture pipeline is untouched.** The clipboard watcher and suppress-flag flow must not be modified by sync logic. Sync is a post-capture side-effect. |
| 7 | **Pin/group operations sync bidirectionally.** A pin or group change on any device must propagate to all other devices for that entry. |
| 8 | **Space Key rotation on member removal.** Removing a member (or a member leaving) must clear every remaining member's wrapped keyring, and the owner's client must mint a new Space Key and redistribute. Rotation is best-effort by design (§10.4) — do not document or present it as airtight. |
| 9 | **Cursor advances only on confirmed receipt.** `POST /sync/cursor` is only called after entries are successfully decrypted and merged into local store. |
| 10 | **ID mapping is maintained.** The `client_id → server_id` mapping must be preserved across restarts. Losing it causes duplicate entries on the next push. |
| 11 | **Sharing is always opt-in.** No entry carries a space id unless the user shared it explicitly or that space's send filter is on and matches. Nothing enters a space by default. |
| 12 | **File/video sync is size-gated.** Entries of `kind: 'file'` are never pushed to the server if their total payload exceeds 5 MB. This is enforced on both client and server (HTTP 413 from `request-upload`). |
| 13 | **Leaving a space stops future sharing.** When a space is left or deleted, its id must be dropped from the client's share records and its keyring dropped and zeroized, so no future entry is tagged with it. Entries already in members' local stores are unaffected. |
| 14 | **Settings sync is encrypted.** The settings blob is encrypted with UMK on-device before `PUT /settings`. The server never sees plaintext preferences. |
| 15 | **Device-specific settings are never synced.** `sync_enabled`, `sync_server_url`, `sync_mode`, `space_autocopy:*`, autostart, and window geometry must never be included in the settings blob. |
| 16 | **Settings sync is debounced.** Changes are batched and pushed at most once every 2 seconds. Never push on every keystroke. |
| 17 | **Content is never encrypted under the UMK or a Space Key.** Every entry gets its own CEK; those keys only wrap it. A push whose envelope has no `"personal"` wrap is unreadable by its own author. |
| 18 | **Keyrings grow at the front, never get replaced.** A rekey prepends the new Space Key and keeps the old ones. Dropping older keys makes every entry written under them permanently unreadable. |
| 19 | **Tombstones keep their `space_ids`.** A delete must fan out to the same members the entry reached, or their copies never disappear. |
