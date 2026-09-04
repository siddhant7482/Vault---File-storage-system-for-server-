# Vault

The file store for **CommandHQ**, a self-hosted app node running on a Lenovo
ThinkCentre M900 behind Tailscale.

Vault is deliberately not a Dropbox clone. It is a **destination**, not a sync
target: files arrive, get filed, and sit there until you need them. There is no
sync client, no in-place editing, no version history, no sharing model beyond a
link with an expiry, and no second user.

What it does have is an answer to the only question that matters on a 30 GB
allocation you cannot expand:

> what is actually in here, and what of it is dead weight?

---

## The three ideas

### 1. The Map

Every file drawn as a rectangle sized by its real bytes, nested inside its
folder. A treemap, pointed at a personal archive rather than a disk utility.

**Area is bytes.** A block that looks twice as big is twice as big, and the
hatched region is genuinely your free space. Every temptation to nudge a
rectangle for looks — a minimum size, padding on the small ones — breaks the one
claim that makes the Map worth having, so none of them are in
[`src/components/treemap.ts`](src/components/treemap.ts).

Folders with more files than fit as individual blocks fold their tail into one
block whose area is the exact sum of what it replaces. Total area per folder is
unchanged.

### 2. Cold

A file is **cold** when it has never been opened, or has not been opened within
`coldDays` (default 365). Press `COLD` and the Map dims everything you have
touched and lights up the rest.

That number is load-bearing, so the code is careful about what counts as an
open:

| | counts |
|---|---|
| You asked for the file | yes |
| The detail pane rendered a thumbnail because the row was selected | **no** |
| Someone redeemed a share link you sent them | **no** |

Glancing at a preview is not using a file, and someone else reading a document
you sent is not you using it. If either cleared the flag, COLD would evaporate
the first time you scrolled the index. See
[`src/app/api/objects/[id]/url/route.ts`](src/app/api/objects/%5Bid%5D/url/route.ts).

### 3. The Inbox

Everything arrives unfiled. Always — never "unless we can guess". `folderId IS
NULL` is a real state, the count sits in the sidebar and the top rail, and it
does not go down on its own.

Filing is made cheap rather than mandatory: with an OpenRouter key set, a model
proposes a folder and a tidier filename, and accepting is one press. **Only the
filename is ever sent** — never the contents. Suggestions are a convenience; with
no key the Inbox works exactly the same, it just asks you where things go.

---

## Architecture

```
        bytes                       index                    panel
  ┌──────────────────┐      ┌──────────────────┐      ┌──────────────────┐
  │  Garage (S3)     │      │   Postgres       │      │   Next 16        │
  │  or a directory  │─────▶│   derived,       │─────▶│   glass cockpit  │
  │  SOURCE OF TRUTH │ scan │   disposable     │      │   :3004          │
  └──────────────────┘      └──────────────────┘      └──────────────────┘
```

**The object store is the truth.** Every row in Postgres is derived from bytes
that exist in the store, and `pnpm scan` rebuilds the lot by walking it. Drop the
database and the only things genuinely lost are what a scan cannot know — tags,
pins, shares, and open history.

That makes `objects.key` sacred. It is the address of the bytes, it never
changes, and renaming a file changes `name` and nothing else. Filing is a **move
in the store** followed by an index update, in that order: if the move fails
nothing changed, and if the index write fails the next scan repairs it.

**Bytes never pass through the app.** With Garage the browser gets a presigned
URL and talks to it directly. The `fs` driver has nothing to presign, so it does
the same thing by hand — an HMAC over key and expiry, checked by
[`/api/blob`](src/app/api/blob/route.ts). Same contract, same short lifetime.

### Storage drivers

| driver | what it is | when |
|---|---|---|
| `fs` | a directory on disk | local dev, and a fine single-node choice |
| `s3` | any S3-compatible endpoint | Garage on the node |

Garage rather than MinIO: ~100 MB resident against 300–400, which matters on a
box with 16 GB that will never be upgraded. Nothing in
[`src/lib/storage/s3.ts`](src/lib/storage/s3.ts) is Garage-specific — point it at
MinIO, B2 or R2 and it works.

Switching is one env var plus a scan. Keys are identical across drivers by
design.

---

## Running it

```sh
cp .env.example .env.local          # then set LINK_SIGNING_KEY
pnpm install
pnpm db:up                          # Postgres on 5434 (Warden's is 5433)
pnpm db:push                        # create the schema
pnpm seed                           # a vault worth looking at
pnpm dev                            # http://localhost:3004
```

The seed writes everything at **1/1000 scale** and sets the allocation to 30 MB
to match, so a 2.9 GB archive becomes 2.9 MB. Every proportion on the Map is
identical to production while the whole fixture is about 18 MB.

```sh
pnpm check:storage                  # prove the driver can read, write, sign, delete
pnpm scan -- --hash                 # reconcile the index; hash for duplicates
pnpm typecheck
```

`pnpm check:storage` is the one to run first after pointing Vault at Garage. The
failure modes there — path-style addressing off, bucket missing, a key without
write permission — all surface as confusing 403s at runtime, and this turns them
into one clear line.

---

## What the other apps see

| endpoint | who calls it |
|---|---|
| `GET /api/status` | the hub, on every render, with a 1.5 s timeout |
| `POST /api/capture` | the hub's `DROP` button — returns an upload target |
| `POST /api/refs` | Warden, Nori, Archive, registering what they depend on |
| `GET /s/<token>` | whoever you sent a link to |

`/api/refs` is how a file learns it is load-bearing. Warden posts *"this CV is
attached to 4 applications"*; the panel shows an amber dot on that row and names
the app in the detail pane, so you can see what depends on a file before you
delete it. Keyed by object key rather than id, upserted per app, so a re-sync in
Warden cannot multiply the same reference four times over.

No auth on the internal routes. Everything sits behind Tailscale, and a shared
secret between six apps that already trust each other buys nothing but a rotation
problem.

---

## Deliberately not built

Sync. In-place editing. Version history. Multi-user. Comments. Collaboration.
Full-text search inside documents. A mobile app.

Each of those turns a thing that has to be reliable into a thing that has to be
reliable *and* correct under concurrency. The backend is borrowed for exactly
that reason; the UI is where the opinions live.
