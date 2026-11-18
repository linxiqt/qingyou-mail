import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { migrateMailProtocolSchema } from "./mail-protocol-schema.js";

export function openStore(config) {
  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path.join(config.dataDir, "postoffice.sqlite"));
  db.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA foreign_keys=ON;
    PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS domains (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY, domain_id INTEGER NOT NULL REFERENCES domains(id),
      email TEXT NOT NULL UNIQUE, name TEXT NOT NULL, password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('admin','user')),
      active INTEGER NOT NULL DEFAULT 1, quota_bytes INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE TABLE IF NOT EXISTS domain_keys (
      domain_id INTEGER PRIMARY KEY REFERENCES domains(id) ON DELETE CASCADE,
      selector TEXT NOT NULL,private_key TEXT NOT NULL,public_key TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      csrf_token TEXT NOT NULL, expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY, owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      folder TEXT NOT NULL CHECK(folder IN ('inbox','sent','drafts','trash','archive','spam')),
      previous_folder TEXT, from_email TEXT NOT NULL, from_name TEXT NOT NULL DEFAULT '',
      to_json TEXT NOT NULL DEFAULT '[]', cc_json TEXT NOT NULL DEFAULT '[]', bcc_json TEXT NOT NULL DEFAULT '[]',
      subject TEXT NOT NULL DEFAULT '', body_text TEXT NOT NULL DEFAULT '', body_html TEXT NOT NULL DEFAULT '',
      snippet TEXT NOT NULL DEFAULT '', raw BLOB, size INTEGER NOT NULL DEFAULT 0,
      is_read INTEGER NOT NULL DEFAULT 0, starred INTEGER NOT NULL DEFAULT 0,
      delivery_status TEXT NOT NULL DEFAULT 'received', message_id TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE TABLE IF NOT EXISTS attachments (
      id INTEGER PRIMARY KEY, message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      filename TEXT NOT NULL, content_type TEXT NOT NULL, size INTEGER NOT NULL, content BLOB NOT NULL
    );
    CREATE TABLE IF NOT EXISTS delivery_jobs (
      id INTEGER PRIMARY KEY, message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
      owner_id INTEGER NOT NULL REFERENCES users(id), sender TEXT NOT NULL, recipient TEXT NOT NULL,
      raw BLOB NOT NULL, state TEXT NOT NULL DEFAULT 'queued', attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt INTEGER NOT NULL DEFAULT 0, last_error TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      delivered_at TEXT
    );
    CREATE INDEX IF NOT EXISTS delivery_due ON delivery_jobs(state,next_attempt);
    CREATE TABLE IF NOT EXISTS forwards (
      id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), target TEXT NOT NULL,
      keep_copy INTEGER NOT NULL DEFAULT 1, enabled INTEGER NOT NULL DEFAULT 1,
      UNIQUE(user_id,target)
    );
    CREATE TABLE IF NOT EXISTS api_keys (
      id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), name TEXT NOT NULL,
      prefix TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, scopes TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), last_used_at TEXT
    );
    CREATE TABLE IF NOT EXISTS webhooks (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL, url TEXT NOT NULL, secret TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE TABLE IF NOT EXISTS webhook_jobs (
      id INTEGER PRIMARY KEY, webhook_id INTEGER NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
      payload TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'queued', attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt INTEGER NOT NULL DEFAULT 0, last_error TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY, actor TEXT NOT NULL, action TEXT NOT NULL, detail TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS code_rules (
      id INTEGER PRIMARY KEY,name TEXT NOT NULL,pattern TEXT NOT NULL,flags TEXT NOT NULL DEFAULT 'i',
      sender_filter TEXT NOT NULL DEFAULT '',subject_filter TEXT NOT NULL DEFAULT '',
      priority INTEGER NOT NULL DEFAULT 10,enabled INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS code_links (
      id INTEGER PRIMARY KEY,token TEXT NOT NULL UNIQUE COLLATE BINARY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      label TEXT NOT NULL DEFAULT '',enabled INTEGER NOT NULL DEFAULT 1,expires_at INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE TABLE IF NOT EXISTS mail_templates (
      id INTEGER PRIMARY KEY,owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,subject TEXT NOT NULL DEFAULT '',body_text TEXT NOT NULL DEFAULT '',
      body_html TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE TABLE IF NOT EXISTS domain_catchalls (
      domain_id INTEGER PRIMARY KEY REFERENCES domains(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,enabled INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS catchall_forwards (
      domain_id INTEGER PRIMARY KEY REFERENCES domains(id) ON DELETE CASCADE,
      target TEXT NOT NULL,enabled INTEGER NOT NULL DEFAULT 1,
      created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS temp_pages (
      id INTEGER PRIMARY KEY,token TEXT NOT NULL UNIQUE,name TEXT NOT NULL,enabled INTEGER NOT NULL DEFAULT 1,
      domains_json TEXT NOT NULL,prefix TEXT NOT NULL DEFAULT 'temp',suffix_length INTEGER NOT NULL DEFAULT 8,
      lifetime_minutes INTEGER NOT NULL DEFAULT 60,daily_ip_limit INTEGER NOT NULL DEFAULT 5,
      password_hash TEXT NOT NULL DEFAULT '',revision INTEGER NOT NULL DEFAULT 1,
      created_by INTEGER NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE TABLE IF NOT EXISTS temp_mailboxes (
      id INTEGER PRIMARY KEY,page_id INTEGER NOT NULL REFERENCES temp_pages(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL,ip_hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE TABLE IF NOT EXISTS temp_sessions (
      token_hash TEXT PRIMARY KEY,page_id INTEGER NOT NULL REFERENCES temp_pages(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL,expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS temp_session_mailboxes (
      session_hash TEXT NOT NULL REFERENCES temp_sessions(token_hash) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,PRIMARY KEY(session_hash,user_id)
    );
    CREATE TABLE IF NOT EXISTS temp_creation_counts (
      page_id INTEGER NOT NULL REFERENCES temp_pages(id) ON DELETE CASCADE,
      ip_hash TEXT NOT NULL,day TEXT NOT NULL,count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(page_id,ip_hash,day)
    );
    CREATE TABLE IF NOT EXISTS code_link_users (
      link_id INTEGER NOT NULL REFERENCES code_links(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,PRIMARY KEY(link_id,user_id)
    );
    CREATE TABLE IF NOT EXISTS code_access_logs (
      id INTEGER PRIMARY KEY,link_id INTEGER REFERENCES code_links(id) ON DELETE CASCADE,
      ip TEXT NOT NULL,action TEXT NOT NULL,result TEXT NOT NULL,reason TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE TABLE IF NOT EXISTS mail_connections (
      id INTEGER PRIMARY KEY,name TEXT NOT NULL,type TEXT NOT NULL,url TEXT NOT NULL,
      secret TEXT NOT NULL,enabled INTEGER NOT NULL DEFAULT 1,last_status TEXT NOT NULL DEFAULT '',
      last_checked_at TEXT,created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE TABLE IF NOT EXISTS domain_permissions (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      domain_id INTEGER NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
      can_read INTEGER NOT NULL DEFAULT 0,can_create INTEGER NOT NULL DEFAULT 0,
      can_update INTEGER NOT NULL DEFAULT 0,can_delete INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(user_id,domain_id)
    );
    CREATE TABLE IF NOT EXISTS api_daily_usage (
      api_key_id INTEGER NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
      day TEXT NOT NULL,count INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(api_key_id,day)
    );
    CREATE TABLE IF NOT EXISTS branding_assets (
      id TEXT PRIMARY KEY,mime TEXT NOT NULL,content BLOB NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE TABLE IF NOT EXISTS cleanup_plans (
      token TEXT PRIMARY KEY,actor_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      message_ids TEXT NOT NULL,mode TEXT NOT NULL,expires_at INTEGER NOT NULL
    );
  `);
  const addColumns = (table, columns) => {
    const existing = new Set(
      db
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .map((c) => c.name),
    );
    for (const [name, definition] of Object.entries(columns))
      if (!existing.has(name))
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
  };
  addColumns("users", {
    is_temporary: "INTEGER NOT NULL DEFAULT 0",
    temporary_expires_at: "INTEGER NOT NULL DEFAULT 0",
    admin_scope: "TEXT NOT NULL DEFAULT 'global'",
    admin_role: "TEXT NOT NULL DEFAULT 'legacy'",
    admin_capabilities: "TEXT DEFAULT NULL",
    client_manager: "INTEGER NOT NULL DEFAULT 0 CHECK(client_manager IN (0,1))",
    avatar: "TEXT NOT NULL DEFAULT ''",
    note: "TEXT NOT NULL DEFAULT ''",
  });
  // Pre-separation sessions are intentionally not accepted by either portal.
  addColumns("sessions", { portal: "TEXT NOT NULL DEFAULT 'legacy'" });
  addColumns("domains", {
    mailbox_limit:
      "INTEGER DEFAULT NULL CHECK (mailbox_limit IS NULL OR (typeof(mailbox_limit)='integer' AND mailbox_limit BETWEEN 0 AND 1000000))",
  });
  // Enforce capacity in SQLite as well as at the API boundary. A batch, another
  // process, or a temporary mailbox cannot race past the domain's final slot.
  db.exec(`
    CREATE INDEX IF NOT EXISTS users_domain_mailboxes ON users(domain_id,is_temporary,id DESC);
    CREATE INDEX IF NOT EXISTS message_owner_folder_order ON messages(owner_id,folder,created_at DESC,id DESC);
    CREATE INDEX IF NOT EXISTS message_mailbox_counts ON messages(owner_id,folder,is_read,size);
    CREATE INDEX IF NOT EXISTS message_owner_starred_order ON messages(owner_id,created_at DESC,id DESC) WHERE starred=1 AND folder NOT IN ('trash','spam');
    DROP INDEX IF EXISTS message_owner_folder;
    CREATE INDEX IF NOT EXISTS message_folder_order ON messages(folder,created_at DESC,id DESC);
    CREATE INDEX IF NOT EXISTS attachments_message ON attachments(message_id);
    CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS delivery_owner_state ON delivery_jobs(owner_id,state);
    CREATE INDEX IF NOT EXISTS code_link_users_user ON code_link_users(user_id);
    CREATE TRIGGER IF NOT EXISTS domain_mailbox_capacity_insert
    BEFORE INSERT ON users
    WHEN EXISTS (
      SELECT 1 FROM domains d WHERE d.id=NEW.domain_id AND d.name<>''
        AND d.mailbox_limit IS NOT NULL
        AND (SELECT count(*) FROM users u WHERE u.domain_id=d.id)>=d.mailbox_limit
    )
    BEGIN SELECT RAISE(ABORT,'DOMAIN_MAILBOX_LIMIT'); END;
    CREATE TRIGGER IF NOT EXISTS domain_mailbox_capacity_move
    BEFORE UPDATE OF domain_id ON users
    WHEN NEW.domain_id<>OLD.domain_id AND EXISTS (
      SELECT 1 FROM domains d WHERE d.id=NEW.domain_id AND d.name<>''
        AND d.mailbox_limit IS NOT NULL
        AND (SELECT count(*) FROM users u WHERE u.domain_id=d.id)>=d.mailbox_limit
    )
    BEGIN SELECT RAISE(ABORT,'DOMAIN_MAILBOX_LIMIT'); END;
    CREATE TRIGGER IF NOT EXISTS domain_mailbox_capacity_lower
    BEFORE UPDATE OF mailbox_limit,name ON domains
    WHEN NEW.name<>'' AND NEW.mailbox_limit IS NOT NULL
      AND NEW.mailbox_limit<(SELECT count(*) FROM users WHERE domain_id=NEW.id)
    BEGIN SELECT RAISE(ABORT,'DOMAIN_MAILBOX_LIMIT_BELOW_USAGE'); END;
  `);
  addColumns("code_links", {
    ip_allowlist: "TEXT NOT NULL DEFAULT ''",
    include_message: "INTEGER NOT NULL DEFAULT 0",
  });
  addColumns("code_rules", { description: "TEXT NOT NULL DEFAULT ''" });
  addColumns("api_keys", { policy_json: "TEXT NOT NULL DEFAULT '{}'" });
  addColumns("mail_connections", { ca_pem: "TEXT NOT NULL DEFAULT ''" });
  addColumns("messages", { trashed_at: "TEXT" });
  migrateMailProtocolSchema(db);
  db.exec(
    "UPDATE messages SET trashed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE folder='trash' AND trashed_at IS NULL",
  );
  db.exec(
    "INSERT OR IGNORE INTO code_link_users(link_id,user_id) SELECT id,user_id FROM code_links",
  );
  if (
    !db
      .prepare("PRAGMA table_info(users)")
      .all()
      .some((column) => column.name === "display_email")
  )
    db.exec(
      "ALTER TABLE users ADD COLUMN display_email TEXT NOT NULL DEFAULT ''",
    );
  // A process may have stopped after taking a job. SMTP delivery is at-least-once.
  db.exec(
    "UPDATE delivery_jobs SET state='queued' WHERE state='sending'; UPDATE webhook_jobs SET state='queued' WHERE state='sending';",
  );
  return {
    db,
    transaction(fn) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const result = fn();
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    audit(actor, action, detail = {}) {
      db.prepare(
        "INSERT INTO audit_logs(actor,action,detail) VALUES(?,?,?)",
      ).run(actor, action, JSON.stringify(detail));
    },
  };
}
