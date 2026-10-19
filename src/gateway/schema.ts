export const GATEWAY_TABLES = `
CREATE TABLE IF NOT EXISTS gateway_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS gateway_peers (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  via TEXT NOT NULL,
  machine TEXT,
  login TEXT,
  may_message TEXT NOT NULL DEFAULT '[]',
  detail TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  last_seen INTEGER,
  disabled INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS gateway_tokens (
  id TEXT PRIMARY KEY,
  peer_id TEXT NOT NULL,
  label TEXT NOT NULL,
  salt TEXT NOT NULL,
  hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at INTEGER
);
CREATE TABLE IF NOT EXISTS gateway_oauth_clients (
  client_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  redirect_uris TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS gateway_oauth_codes (
  hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  challenge TEXT NOT NULL,
  peer_name TEXT NOT NULL,
  may_message TEXT NOT NULL,
  family TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);
CREATE TABLE IF NOT EXISTS gateway_oauth_tokens (
  hash TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  peer_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  family TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE TABLE IF NOT EXISTS gateway_pairings (
  hash TEXT PRIMARY KEY,
  peer_name TEXT NOT NULL,
  may_message TEXT NOT NULL,
  redirect_host TEXT,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);
CREATE TABLE IF NOT EXISTS gateway_hosts (
  host TEXT PRIMARY KEY,
  allowed INTEGER NOT NULL DEFAULT 0,
  linked INTEGER NOT NULL DEFAULT 0,
  url TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS gateway_push (
  endpoint TEXT PRIMARY KEY,
  peer_id TEXT NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
`;
