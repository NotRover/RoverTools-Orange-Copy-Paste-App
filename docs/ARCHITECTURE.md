# RoverTools — Where Everything Lives

**Owns:** the map of the doc set, and the invariants that bind the client and the backend
together so neither doc can own them alone.
**Not here:** anything one component enforces by itself. Wire contract, payloads and DDL are
the backend's; state, commands and runtime behavior are the client's; who-may-do-what is
`PERMISSIONS.md`. This file links, it does not describe.

One fact, one home. This page is deliberately short: it used to describe the whole system a
third time, and the third copy is what went stale.

---

## The components

| Path | Role | Repo |
|------|------|------|
| `orange-copy-paste-clipboard-app-rust/` | Desktop app. React + TypeScript UI, Tauri v2 + Rust core. Captures the clipboard, stores history and notes locally, holds every key, does all encryption. | Lives **directly** in the parent repo |
| `orange-copy-paste-clipboard-backend/` | Cloud sync API. FastAPI + Supabase Postgres + Redis + S3/R2. Verifies JWTs, stores ciphertext, fans out over WebSocket, brokers blobs. | **Submodule**, its own repo |
| `orange-copy-paste-clipboard-website/` | Public docs + presentation site. Astro + Starlight. End-user how-to and the marketing landing page; not part of the product runtime. | **Submodule**, its own repo |

The client and the backend are the two product halves. The backend is a relay and a
store: it never holds a key that could open anything it persists, which is why it can be
stateless about content and strict about identity. The website is documentation only — it
describes product behavior and links to the homes below, it enforces nothing.

## Which doc answers which question

| Question | Doc |
|----------|-----|
| What does the API look like — routes, payloads, DDL, socket events, the crypto envelope? | `orange-copy-paste-clipboard-backend/docs/ARCHITECTURE.md` |
| How does the app work inside — state, Tauri commands, events, persistence, the sync engine? | `orange-copy-paste-clipboard-app-rust/docs/ARCHITECTURE.md` |
| Who may do what to an entry or inside a space, and where is it enforced? | `PERMISSIONS.md` |
| Has this broken before, and why? | `orange-copy-paste-clipboard-app-rust/docs/BUGFIX_HISTORY.md` |
| How does a release get cut? | `RELEASING.md` |
| How do I reach, recover, harden, and deploy the self-hosted VPS? | `orange-copy-paste-clipboard-backend/docs/DEPLOY.md` |
| How do I work in this repo? | `CLAUDE.md` at the workspace root |
| Where do end users learn to install and use the app? | `orange-copy-paste-clipboard-website/` — the public docs + marketing site |
| How is a space key handed over / how does join approval work, as a walkthrough? | `space-key-handover.html`, `join-approval.html` — dated explainers, not references |
| Why was a design chosen, and what was rejected? | `SPACE-ACCESS.md`, `SPACE-JOIN-APPROVAL.md` — decision records |

The backend doc is the source of truth for anything crossing the wire. When it and this
page disagree, the backend doc wins; when the backend doc and the code disagree, the code
wins and the doc is a bug.

## Cross-Component Invariants

These are the reason this file exists. Each one is a promise **neither** component can keep
alone, so it has no home in either doc. Preserve them across any change to either repo.

| # | Invariant |
|---|---|
| 1 | **The local store is always plaintext.** `history.bin` and `notes.bin` are never encrypted. The encryption boundary is the network, not the disk. |
| 2 | **Sync is always optional.** The app is fully functional with no account, no network and no server. Nothing in the capture, search, paste or notes paths may block on it. |
| 3 | **The server never sees plaintext or any key.** `encrypted_content` and `encrypted_metadata` are sealed on-device before any network call, and `wrapped_keys` / `wrapped_space_keys` stay opaque — the server holds no private key that could open either. |
| 4 | **The UMK never leaves the device in the clear.** In memory only, unwrapped at login from the password and `kdf_salt`, cleared on lock or exit. The server holds only the wrapped envelope. |
| 5 | **Tombstones always propagate and always win.** A `deleted_at` on a received entry is honoured; deletion beats a concurrent update. |
| 6 | **The capture pipeline is untouched by sync.** The clipboard watcher and the suppress-flag flow are not modified by sync logic. Sync is a post-capture side effect. |
| 7 | **Pins and groups sync both ways.** A pin or group change on one device reaches every other device holding that entry. |
| 8 | **Removing a member rotates the Space Key.** Removal, or a member leaving, clears every remaining member's wrapped keyring and asks the owner's client for a new key. Rotation is best-effort by design — never document or present it as airtight. |
| 9 | **The cursor advances only on confirmed receipt.** `POST /sync/cursor` is called after entries are decrypted and merged, never before. |
| 10 | **The id mapping survives restarts.** Losing `client_id → server_id` duplicates every entry on the next push. |
| 11 | **Sharing is always opt-in.** No entry carries a space id unless the user shared it or that space's send filter is on and matches. Nothing enters a space by default. |
| 12 | **File sync is size-gated on both sides.** A `kind: 'file'` entry over 5 MB total is not pushed, and the server refuses it anyway (413 from `request-upload`). |
| 13 | **Leaving a space stops future sharing.** Its id is dropped from the client's share records and its keyring dropped and zeroized, so no later entry is tagged with it. Copies already in members' local stores are unaffected. |
| 14 | **Settings sync is encrypted.** The blob is sealed under the UMK before `PUT /settings`. The server never sees a plaintext preference. |
| 15 | **Device-local settings are never synced.** `sync_enabled`, `sync_server_url`, `sync_mode`, `space_autocopy:*`, autostart and window geometry stay out of the blob. |
| 16 | **Settings sync is debounced.** Batched, at most one push every 2 seconds. Never on a keystroke. |
| 17 | **Content is never encrypted under the UMK or a Space Key.** Every entry gets its own CEK; those keys only wrap it. A push whose envelope carries no `"personal"` wrap is unreadable by its own author. |
| 18 | **Keyrings grow at the front and are never replaced.** A rekey prepends; dropping older keys makes every entry written under them permanently unreadable. |
| 19 | **Tombstones keep their `space_ids`.** A delete must reach the same members the entry did, or their copies never disappear. |

## The shape of a change

Anything crossing the wire touches both repos and their docs disagree easily, so the order
matters:

1. **Backend first**, because it is the contract. Route, payload, DDL, socket event — and
   its `docs/ARCHITECTURE.md` in the same commit, since the doc *is* the contract's
   readable form.
2. **Client second**, against what the backend now accepts. Its doc gets a line only if
   client internals changed — not a copy of the payload.
3. **`PERMISSIONS.md`** only if the change is about who may do something.
4. **This file** only if the change adds an invariant neither component can keep alone.

Migrations are authored freely and **applied by the deploy**, never from a machine. Commits
stay scoped to one repo; a submodule pointer bump is its own commit.
