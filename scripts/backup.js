import { DatabaseSync, backup } from "node:sqlite";
import { mkdirSync, chmodSync } from "node:fs";
import path from "node:path";

// SQLite online backup includes committed WAL pages; copying only .sqlite would not.
const dataDir = path.resolve(process.env.DATA_DIR || "./data");
const backupDir = path.resolve(process.env.BACKUP_DIR || "./backups");
mkdirSync(backupDir, { recursive: true, mode: 0o700 });
const db = new DatabaseSync(path.join(dataDir, "postoffice.sqlite"), {
  readOnly: true,
});
const destination = path.join(
  backupDir,
  `postoffice-${new Date().toISOString().replace(/[:.]/g, "-")}.sqlite`,
);
try {
  await backup(db, destination);
  chmodSync(destination, 0o600);
  console.log(`备份完成：${destination}`);
} finally {
  db.close();
}
