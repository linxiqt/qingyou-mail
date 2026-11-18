// IMAP UIDs identify a delivery to a particular folder, not a SQLite rowid.
// A move (including one made by the web client) allocates a new destination UID.
export function migrateMailProtocolSchema(db) {
  db.exec("BEGIN IMMEDIATE");
  try {
    if (
      !db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name='protocol_folders'",
        )
        .get()
    ) {
      db.exec(`
        CREATE TABLE protocol_folders (
          owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          folder TEXT NOT NULL, validity INTEGER NOT NULL DEFAULT ((random() & 2147483647)+1),
          next_uid INTEGER NOT NULL DEFAULT 1 CHECK(next_uid BETWEEN 1 AND 4294967296),
          revision INTEGER NOT NULL DEFAULT 0, subscribed INTEGER NOT NULL DEFAULT 1,
          PRIMARY KEY(owner_id,folder)
        );
        CREATE TABLE protocol_messages (
          message_id INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
          owner_id INTEGER NOT NULL, folder TEXT NOT NULL, uid INTEGER NOT NULL CHECK(uid BETWEEN 1 AND 4294967295),
          extra_flags TEXT NOT NULL DEFAULT '[]', pop_octets INTEGER,
          FOREIGN KEY(owner_id,folder) REFERENCES protocol_folders(owner_id,folder) ON DELETE CASCADE,
          UNIQUE(owner_id,folder,uid)
        );
        INSERT INTO protocol_folders(owner_id,folder,next_uid)
          SELECT owner_id,folder,COUNT(*)+1 FROM messages GROUP BY owner_id,folder;
        INSERT INTO protocol_messages(message_id,owner_id,folder,uid)
          SELECT id,owner_id,folder,ROW_NUMBER() OVER(PARTITION BY owner_id,folder ORDER BY id) FROM messages;
        CREATE TRIGGER protocol_message_insert AFTER INSERT ON messages BEGIN
          INSERT INTO protocol_folders(owner_id,folder) VALUES(NEW.owner_id,NEW.folder) ON CONFLICT DO NOTHING;
          INSERT INTO protocol_messages(message_id,owner_id,folder,uid)
            SELECT NEW.id,NEW.owner_id,NEW.folder,next_uid FROM protocol_folders
            WHERE owner_id=NEW.owner_id AND folder=NEW.folder;
          UPDATE protocol_folders SET next_uid=next_uid+1,revision=revision+1 WHERE owner_id=NEW.owner_id AND folder=NEW.folder;
        END;
        CREATE TRIGGER protocol_message_move AFTER UPDATE OF folder,owner_id ON messages
        WHEN NEW.folder<>OLD.folder OR NEW.owner_id<>OLD.owner_id BEGIN
          INSERT INTO protocol_folders(owner_id,folder) VALUES(NEW.owner_id,NEW.folder) ON CONFLICT DO NOTHING;
          UPDATE protocol_messages SET owner_id=NEW.owner_id,folder=NEW.folder,
            uid=(SELECT next_uid FROM protocol_folders WHERE owner_id=NEW.owner_id AND folder=NEW.folder),
            extra_flags=(SELECT json_group_array(value) FROM json_each(extra_flags) WHERE lower(value)<>(char(92)||'deleted'))
            WHERE message_id=NEW.id;
          UPDATE protocol_folders SET revision=revision+1 WHERE owner_id=OLD.owner_id AND folder=OLD.folder;
          UPDATE protocol_folders SET next_uid=next_uid+1,revision=revision+1 WHERE owner_id=NEW.owner_id AND folder=NEW.folder;
        END;
        CREATE TRIGGER protocol_message_remove AFTER DELETE ON messages BEGIN
          UPDATE protocol_folders SET revision=revision+1 WHERE owner_id=OLD.owner_id AND folder=OLD.folder;
        END;
        CREATE TRIGGER protocol_web_flags AFTER UPDATE OF is_read,starred ON messages
        WHEN NEW.is_read<>OLD.is_read OR NEW.starred<>OLD.starred BEGIN
          UPDATE protocol_folders SET revision=revision+1 WHERE owner_id=NEW.owner_id AND folder=NEW.folder;
        END;
        CREATE TRIGGER protocol_extra_flags AFTER UPDATE OF extra_flags ON protocol_messages
        WHEN NEW.extra_flags<>OLD.extra_flags BEGIN
          UPDATE protocol_folders SET revision=revision+1 WHERE owner_id=NEW.owner_id AND folder=NEW.folder;
        END;
      `);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
