import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const DATA_DIR = path.resolve('data');
fs.mkdirSync(path.join(DATA_DIR, 'uploads'), { recursive: true });
export const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'wedding.db');
export const UPLOAD_DIR = process.env.UPLOAD_DIR ? path.resolve(process.env.UPLOAD_DIR) : path.resolve('data/uploads');

export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

export function id(prefix) {
  return `${prefix}_${crypto.randomBytes(10).toString('base64url')}`;
}
export function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}
export function token() {
  return crypto.randomBytes(32).toString('base64url');
}
export function nowIso() {
  return new Date().toISOString();
}
export function parseJson(value, fallback = null) {
  if (!value) return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

db.exec(`
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  couple_name TEXT NOT NULL,
  hall TEXT NOT NULL,
  default_language TEXT NOT NULL DEFAULT 'zh-CN',
  retention_days INTEGER NOT NULL DEFAULT 30,
  starts_at TEXT,
  ends_at TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS assets (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK(type IN ('photo','font')),
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  size INTEGER NOT NULL,
  focal_x REAL NOT NULL DEFAULT 0.5,
  focal_y REAL NOT NULL DEFAULT 0.5,
  darken REAL NOT NULL DEFAULT 0,
  license_scope TEXT NOT NULL DEFAULT 'event',
  license_holder TEXT NOT NULL DEFAULT '',
  licensed_from TEXT,
  licensed_until TEXT,
  license_version INTEGER NOT NULL DEFAULT 1,
  revoked INTEGER NOT NULL DEFAULT 0,
  revoked_at TEXT,
  revoked_reason TEXT,
  file_purged INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  event_id TEXT REFERENCES events(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  hall TEXT NOT NULL,
  device_token TEXT NOT NULL UNIQUE,
  resolution TEXT NOT NULL DEFAULT '1920x1080',
  registered_at TEXT NOT NULL,
  last_seen_at TEXT,
  last_ip TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT,
  pending_event_id TEXT REFERENCES events(id) ON DELETE SET NULL
);
CREATE TABLE IF NOT EXISTS groups (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS device_groups (
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  PRIMARY KEY(device_id, group_id)
);
CREATE TABLE IF NOT EXISTS versions (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  design_json TEXT NOT NULL,
  font_embedded INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL CHECK(status IN ('draft','ready','scheduled','published','canceled','superseded')),
  manifest_json TEXT NOT NULL DEFAULT '{}',
  published_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS version_groups (
  version_id TEXT NOT NULL REFERENCES versions(id) ON DELETE CASCADE,
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  PRIMARY KEY(version_id, group_id)
);
CREATE TABLE IF NOT EXISTS version_devices (
  version_id TEXT NOT NULL REFERENCES versions(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  PRIMARY KEY(version_id, device_id)
);
CREATE TABLE IF NOT EXISTS device_versions (
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  version_id TEXT NOT NULL REFERENCES versions(id) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK(state IN ('assigned','preloading','ready','active','failed','superseded')),
  scheduled_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(device_id, version_id)
);
CREATE TABLE IF NOT EXISTS proofs (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  version_id TEXT NOT NULL REFERENCES versions(id) ON DELETE CASCADE,
  slide_index INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('synthetic','screenshot')),
  sha256 TEXT NOT NULL,
  size INTEGER NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  metrics_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','approved','rejected')) DEFAULT 'pending',
  created_at TEXT NOT NULL,
  reviewed_at TEXT,
  file_purged INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS delete_tasks (
  id TEXT PRIMARY KEY,
  event_id TEXT,
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  scope TEXT NOT NULL CHECK(scope IN ('event','assets','all')),
  asset_sha TEXT,
  version_id TEXT,
  status TEXT NOT NULL CHECK(status IN ('pending','acked','deleted','failed')),
  issued_at TEXT NOT NULL,
  completed_at TEXT,
  proof_sha TEXT,
  note TEXT,
  task_key TEXT NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS audits (
  id TEXT PRIMARY KEY,
  event_id TEXT,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  detail_json TEXT NOT NULL DEFAULT '{}',
  photo_body_included INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_assets_event ON assets(event_id);
CREATE INDEX IF NOT EXISTS idx_versions_event ON versions(event_id);
CREATE INDEX IF NOT EXISTS idx_devices_event ON devices(event_id);
CREATE INDEX IF NOT EXISTS idx_dv_device ON device_versions(device_id, state);
CREATE INDEX IF NOT EXISTS idx_tasks_device ON delete_tasks(device_id, status);
CREATE INDEX IF NOT EXISTS idx_audits_event ON audits(event_id, created_at);
`);

export function audit(actor, action, targetType, targetId, eventId = null, detail = {}) {
  db.prepare(`INSERT INTO audits(id,event_id,actor,action,target_type,target_id,detail_json,photo_body_included,created_at)
              VALUES (?,?,?,?,?,?,?,0,?)`)
    .run(id('aud'), eventId, actor, action, targetType, targetId, JSON.stringify(detail), nowIso());
}
