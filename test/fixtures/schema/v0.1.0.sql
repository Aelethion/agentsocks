CREATE TABLE threads (
        thread_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        cwd TEXT,
        mode TEXT,
        state TEXT NOT NULL DEFAULT 'unknown',
        remote TEXT,
        created_at INTEGER NOT NULL,
        last_seen INTEGER NOT NULL,
        pending_wake_at INTEGER,
        wake_log TEXT NOT NULL DEFAULT '[]',
        stop_streak INTEGER NOT NULL DEFAULT 0
      );

CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        to_thread TEXT NOT NULL,
        kind TEXT NOT NULL,
        from_addr TEXT,
        from_name TEXT,
        from_kind TEXT,
        from_session TEXT,
        from_mode TEXT,
        body TEXT NOT NULL,
        received_at INTEGER NOT NULL,
        state TEXT NOT NULL DEFAULT 'queued',
        surfaced_at INTEGER
      );

CREATE INDEX messages_inbox ON messages (to_thread, state, received_at);

INSERT INTO threads (thread_id, name, cwd, mode, state, created_at, last_seen) VALUES ('t-old', 'codex-old', '/w/old', 'prompting', 'idle', 1000, 2000);
INSERT INTO messages (id, to_thread, kind, from_addr, from_name, from_kind, body, received_at, state) VALUES ('m-old', 't-old', 'message', 'uds:/x/cc-socks/1.sock', 'api', 'claude', 'written by v0.1', 3000, 'notified');
