/**
 * Local store schema — the on-device replacement for the Supabase tables the
 * app reads today (`vault_items`, `lykn_chats`, `lykn_synthesis_chunks`).
 *
 * Migrations are append-only and applied in order against `PRAGMA user_version`.
 * Never edit a shipped migration; add a new one. A user who installs an update
 * runs only the steps their file has not seen.
 *
 * Two conventions carried over from Postgres deliberately:
 *   - IDs stay TEXT uuids so rows imported from Supabase keep their identity,
 *     which lets project neurons and belief provenance survive the move.
 *   - Timestamps stay ISO-8601 strings, matching what PostgREST already hands
 *     the renderer, so date handling in the UI does not change.
 */

/** @type {{ version: number, name: string, sql: string }[]} */
const MIGRATIONS = [
  {
    version: 1,
    name: "initial",
    sql: `
      -- Anything the user saves that has a body and optionally a file:
      -- vault notes, chat attachments, generated images, artifacts.
      CREATE TABLE items (
        id               TEXT PRIMARY KEY,
        kind             TEXT NOT NULL DEFAULT 'vault',
        thread_id        TEXT,
        title            TEXT,
        content          TEXT,
        why              TEXT,
        tags             TEXT,
        source           TEXT,
        folder           TEXT,
        att_type         TEXT,
        platform         TEXT,
        url              TEXT,
        blob_path        TEXT,
        mime_type        TEXT,
        byte_size        INTEGER,
        duration_seconds REAL,
        page_count       INTEGER,
        host_name        TEXT,
        media_width      INTEGER,
        media_height     INTEGER,
        variant_thumb    TEXT,
        variant_med      TEXT,
        preview          TEXT,
        comments         TEXT,
        ai_summary       TEXT,
        ai_signals       TEXT,
        created_at       TEXT NOT NULL,
        updated_at       TEXT,
        deleted_at       TEXT
      );

      CREATE INDEX idx_items_kind_created ON items(kind, created_at DESC);
      CREATE INDEX idx_items_live         ON items(deleted_at) WHERE deleted_at IS NULL;
      CREATE INDEX idx_items_thread       ON items(thread_id)  WHERE thread_id IS NOT NULL;
      CREATE INDEX idx_items_source       ON items(source)     WHERE source IS NOT NULL;

      -- Chat threads and grid boards.
      CREATE TABLE threads (
        id         TEXT PRIMARY KEY,
        title      TEXT,
        mode       TEXT NOT NULL DEFAULT 'chat',
        created_at TEXT NOT NULL,
        updated_at TEXT,
        deleted_at TEXT
      );

      CREATE INDEX idx_threads_updated ON threads(updated_at DESC);

      CREATE TABLE messages (
        id         TEXT PRIMARY KEY,
        thread_id  TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        seq        INTEGER NOT NULL,
        role       TEXT NOT NULL,
        content    TEXT,
        blocks     TEXT,
        created_at TEXT NOT NULL,
        UNIQUE(thread_id, seq)
      );

      CREATE INDEX idx_messages_thread ON messages(thread_id, seq);

      -- Retrieval index. Embeddings are Float32Array(dims) stored as raw
      -- little-endian bytes and L2-normalized at write time, so similarity is
      -- a plain dot product at query time.
      CREATE TABLE chunks (
        id          INTEGER PRIMARY KEY,
        source_kind TEXT NOT NULL,
        source_id   TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        text        TEXT NOT NULL,
        embedding   BLOB NOT NULL,
        dims        INTEGER NOT NULL,
        model       TEXT NOT NULL,
        created_at  TEXT NOT NULL,
        UNIQUE(source_kind, source_id, chunk_index)
      );

      CREATE INDEX idx_chunks_source ON chunks(source_kind, source_id);
      CREATE INDEX idx_chunks_model  ON chunks(model);

      CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT);
    `,
  },
  {
    version: 2,
    name: "fulltext",
    sql: `
      -- External-content FTS5: the index stores no copy of the text, it points
      -- at items/messages by rowid. bm25() gives the same lexical ranking the
      -- server got from search_notes_bm25().
      CREATE VIRTUAL TABLE items_fts USING fts5(
        title, content, ai_summary,
        content='items', content_rowid='rowid',
        tokenize='porter unicode61'
      );

      CREATE TRIGGER items_fts_ai AFTER INSERT ON items BEGIN
        INSERT INTO items_fts(rowid, title, content, ai_summary)
        VALUES (new.rowid, new.title, new.content, new.ai_summary);
      END;

      CREATE TRIGGER items_fts_ad AFTER DELETE ON items BEGIN
        INSERT INTO items_fts(items_fts, rowid, title, content, ai_summary)
        VALUES ('delete', old.rowid, old.title, old.content, old.ai_summary);
      END;

      CREATE TRIGGER items_fts_au AFTER UPDATE ON items BEGIN
        INSERT INTO items_fts(items_fts, rowid, title, content, ai_summary)
        VALUES ('delete', old.rowid, old.title, old.content, old.ai_summary);
        INSERT INTO items_fts(rowid, title, content, ai_summary)
        VALUES (new.rowid, new.title, new.content, new.ai_summary);
      END;

      CREATE VIRTUAL TABLE messages_fts USING fts5(
        content,
        content='messages', content_rowid='rowid',
        tokenize='porter unicode61'
      );

      CREATE TRIGGER messages_fts_ai AFTER INSERT ON messages BEGIN
        INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
      END;

      CREATE TRIGGER messages_fts_ad AFTER DELETE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, content)
        VALUES ('delete', old.rowid, old.content);
      END;

      CREATE TRIGGER messages_fts_au AFTER UPDATE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, content)
        VALUES ('delete', old.rowid, old.content);
        INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
      END;
    `,
  },
  {
    version: 3,
    name: "index_state",
    sql: `
      -- What the embedder has already seen. The chunks table alone cannot
      -- answer that: a row whose text is empty (an image with no description
      -- yet, a blank note) correctly produces zero chunks, and without a
      -- record of the attempt the backfill would pick it up again on every
      -- pass and never report itself finished.
      --
      -- text_hash is the authoritative staleness check. Touching a note bumps
      -- updated_at without necessarily changing anything embeddable, so the
      -- timestamp is only a cheap pre-filter for which rows to look at; the
      -- hash decides whether the vectors are actually out of date.
      CREATE TABLE index_state (
        source_kind TEXT NOT NULL,
        source_id   TEXT NOT NULL,
        model       TEXT NOT NULL,
        text_hash   TEXT,
        chunk_count INTEGER NOT NULL DEFAULT 0,
        indexed_at  TEXT NOT NULL,
        PRIMARY KEY (source_kind, source_id)
      );

      CREATE INDEX idx_index_state_model ON index_state(model);
    `,
  },
  {
    version: 4,
    name: "thread_state",
    sql: `
      -- A chat in the cloud is two rows: lykn_chats holds the metadata and
      -- lykn_chat_states.state holds one JSON blob with everything else. Most
      -- of that blob is the conversation, which imports into messages, but it
      -- also carries the grid canvas — blocks, blockOrder, camera, wire
      -- connections, notes pages. That is real user work with nowhere else to
      -- live, so the snapshot is kept verbatim rather than parsed into columns
      -- the grid would have to be rebuilt from.
      ALTER TABLE threads ADD COLUMN state TEXT;

      -- Where a row came from, so a re-run of the import can tell its own
      -- writes apart from anything created locally.
      ALTER TABLE threads ADD COLUMN origin TEXT;
      ALTER TABLE items   ADD COLUMN origin TEXT;
    `,
  },
  {
    version: 5,
    name: "apps",
    sql: `
      -- Apps the user had LYKN build for them, installed on this device.
      --
      -- An app is three things kept apart on purpose: the manifest (this
      -- table), the source it was built from (app_files), and the data it
      -- writes at runtime (app_data). Keeping runtime data out of \`items\`
      -- matters because the vault UI lists items — a to-do app writing a
      -- thousand rows must not turn into a thousand notes in the user's vault.
      --
      -- \`id\` is served as the hostname of lykn-app://<id>/, which gives every
      -- app its own browser origin and therefore its own localStorage,
      -- IndexedDB, and cookie jar with no isolation code of our own. A standard
      -- scheme lowercases its hostname, so ids MUST be lowercase; apps.cjs
      -- enforces that on write rather than trusting callers.
      CREATE TABLE apps (
        id           TEXT PRIMARY KEY,
        name         TEXT NOT NULL,
        icon         TEXT,
        description  TEXT,
        version      INTEGER NOT NULL DEFAULT 1,
        entry        TEXT NOT NULL DEFAULT 'App.jsx',
        -- What the app asked for in app.json, and what the user actually
        -- granted. Kept separate so a rebuild that widens the manifest cannot
        -- silently inherit consent the user gave to the narrower version.
        capabilities TEXT,
        grants       TEXT,
        source_chat  TEXT,
        created_at   TEXT NOT NULL,
        updated_at   TEXT,
        opened_at    TEXT,
        deleted_at   TEXT
      );

      CREATE INDEX idx_apps_live    ON apps(deleted_at) WHERE deleted_at IS NULL;
      CREATE INDEX idx_apps_opened  ON apps(opened_at DESC);

      -- The editable project. This is the source of truth an edit round-trip
      -- patches, not the compiled bundle the protocol serves.
      CREATE TABLE app_files (
        app_id     TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
        path       TEXT NOT NULL,
        content    TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (app_id, path)
      );

      -- Snapshots for rollback. A build that breaks the app must be undoable
      -- without the user having to re-describe what they wanted.
      CREATE TABLE app_versions (
        id         INTEGER PRIMARY KEY,
        app_id     TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
        version    INTEGER NOT NULL,
        files      TEXT NOT NULL,
        note       TEXT,
        created_at TEXT NOT NULL,
        UNIQUE(app_id, version)
      );

      -- Runtime data, namespaced per app. \`collection\` is the app's own table
      -- name; the (app_id, collection, key) primary key is what makes one app
      -- unable to address another's rows even if the bridge were tricked into
      -- passing a foreign id.
      CREATE TABLE app_data (
        app_id     TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
        collection TEXT NOT NULL,
        key        TEXT NOT NULL,
        value      TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (app_id, collection, key)
      );

      CREATE INDEX idx_app_data_collection ON app_data(app_id, collection, updated_at DESC);
    `,
  },
  {
    version: 6,
    name: "app_icon_source",
    sql: `
      -- Where \`icon\` came from: 'user' when the person chose it, NULL when it
      -- is whatever the model wrote into app.json. Reinstalling an app rewrites
      -- the manifest, so without this the next "add a dark mode" would silently
      -- undo an icon the user picked from the dock.
      ALTER TABLE apps ADD COLUMN icon_source TEXT;
    `,
  },
];

const LATEST_VERSION = MIGRATIONS.reduce((max, m) => Math.max(max, m.version), 0);

module.exports = { MIGRATIONS, LATEST_VERSION };
