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
      , hooks_active INTEGER NOT NULL DEFAULT 0, current_task TEXT, last_tool TEXT, last_activity INTEGER, wake_hold_since INTEGER);

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
      , msg_id TEXT, stop_blocked INTEGER NOT NULL DEFAULT 0, wakes INTEGER NOT NULL DEFAULT 0, route TEXT NOT NULL DEFAULT 'now', decision TEXT);

CREATE INDEX messages_inbox ON messages (to_thread, state, received_at);

CREATE INDEX messages_msgid ON messages (to_thread, msg_id);

CREATE TABLE outbox (
        id TEXT PRIMARY KEY,
        msg_id TEXT NOT NULL,
        from_addr TEXT,
        from_name TEXT NOT NULL,
        from_kind TEXT NOT NULL,
        from_session TEXT,
        from_mode TEXT,
        to_addr TEXT NOT NULL,
        to_name TEXT NOT NULL,
        to_kind TEXT NOT NULL,
        to_thread TEXT,
        to_session TEXT,
        body TEXT NOT NULL,
        urgency TEXT NOT NULL,
        route TEXT NOT NULL,
        decision TEXT NOT NULL,
        status TEXT NOT NULL,
        task_id TEXT,
        carrier_id TEXT,
        created_at INTEGER NOT NULL,
        sent_at INTEGER,
        shown_at INTEGER,
        replied_at INTEGER,
        error TEXT
      );

CREATE INDEX outbox_to ON outbox (to_addr, created_at);

CREATE INDEX outbox_pair ON outbox (from_addr, to_addr, created_at);

CREATE INDEX outbox_msgid ON outbox (msg_id);

CREATE INDEX outbox_status ON outbox (status, created_at);

CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        from_addr TEXT NOT NULL,
        from_name TEXT NOT NULL,
        to_addr TEXT NOT NULL,
        to_name TEXT NOT NULL,
        to_kind TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        acceptance TEXT,
        risk TEXT NOT NULL,
        external_ref TEXT,
        on_behalf_of TEXT,
        status TEXT NOT NULL,
        result TEXT,
        evidence TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );

CREATE INDEX tasks_assignee ON tasks (to_addr, status);

CREATE INDEX tasks_creator ON tasks (from_addr, status);

INSERT INTO threads (thread_id, name, cwd, mode, state, created_at, last_seen, hooks_active, current_task, last_tool) VALUES ('t-mid', 'codex-mid', '/w/mid', 'bypass', 'busy', 1000, 2000, 1, 'write the tests', 'Edit');
INSERT INTO messages (id, to_thread, kind, from_addr, from_name, from_kind, body, received_at, state, msg_id, route, decision) VALUES ('m-mid', 't-mid', 'message', 'uds:/x/cc-socks/2.sock', 'api', 'claude', 'written by v0.2', 3000, 'queued', 'wire-1', 'pause', '{"route":"pause"}');
INSERT INTO outbox (id, msg_id, from_addr, from_name, from_kind, to_addr, to_name, to_kind, body, urgency, route, decision, status, created_at) VALUES ('o-mid', 'wire-2', 'uds:/x/cc-socks/2.sock', 'api', 'claude', 'uds:/x/t/t-mid.sock', 'codex-mid', 'codex', 'sent by v0.2', 'normal', 'now', '{"route":"now"}', 'sent', 4000);
INSERT INTO tasks (id, from_addr, from_name, to_addr, to_name, to_kind, title, body, risk, status, created_at, updated_at, expires_at) VALUES ('T-0a1b2c', 'uds:/x/cc-socks/2.sock', 'api', 'uds:/x/t/t-mid.sock', 'codex-mid', 'codex', 'Add retries', 'details', 'low', 'open', 5000, 5000, 9000);
