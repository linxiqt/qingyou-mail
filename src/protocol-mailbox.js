import MailComposer from "nodemailer/lib/mail-composer/index.js";
import { ImapBackendError } from "@push.rocks/smartimap";

const folders = new Map([
  ["inbox", ["INBOX", ""]],
  ["sent", ["Sent", "\\Sent"]],
  ["drafts", ["Drafts", "\\Drafts"]],
  ["trash", ["Trash", "\\Trash"]],
  ["archive", ["Archive", "\\Archive"]],
  ["spam", ["Junk", "\\Junk"]],
]);
const denied = () => new ImapBackendError("Mailbox access denied", "NOPERM");
const fixedFolder = () => {
  throw new ImapBackendError("This server uses fixed mail folders", "CANNOT");
};
const ensureFolder = (folder) => {
  if (!folders.has(folder))
    throw new ImapBackendError("Unknown folder", "NONEXISTENT");
};
const canonical = new Map(
  ["\\Seen", "\\Flagged", "\\Deleted", "\\Answered", "\\Draft"].map((f) => [
    f.toLowerCase(),
    f,
  ]),
);
function cleanFlags(input) {
  const unique = new Map();
  for (const value of input) {
    const known = canonical.get(String(value).toLowerCase());
    if (!known && !/^[a-zA-Z0-9$._:+-]{1,64}$/.test(value)) continue;
    unique.set(value.toLowerCase(), known || value);
  }
  if (unique.size > 48)
    throw new ImapBackendError("Too many message flags", "LIMIT");
  return [...unique.values()];
}
function rowFlags(row) {
  return [
    ...(row.is_read ? ["\\Seen"] : []),
    ...(row.starred ? ["\\Flagged"] : []),
    ...JSON.parse(row.extra_flags),
  ];
}

export function createProtocolMailbox({ db, transaction }, mail, auth, config) {
  const actor = (session, capability = "mail.read") => {
    try {
      return auth.authorize(session, capability);
    } catch {
      throw denied();
    }
  };
  const base =
    " FROM protocol_messages p JOIN messages m ON m.id=p.message_id WHERE p.owner_id=? AND p.folder=?";
  const metadata =
    "SELECT m.id,p.uid,m.created_at,m.is_read,m.starred,m.size,p.extra_flags,p.pop_octets, (m.raw IS NULL) AS legacy";
  const list = db.prepare(metadata + base + " ORDER BY p.uid");
  const one = db.prepare(metadata + base + " AND p.uid=?");
  const raw = db.prepare("SELECT m.raw" + base + " AND p.uid=?");
  const findFolders = db.prepare(
    "SELECT * FROM protocol_folders WHERE owner_id=? ORDER BY folder",
  );
  const addFolder = db.prepare(
    "INSERT INTO protocol_folders(owner_id,folder) VALUES(?,?) ON CONFLICT DO NOTHING",
  );
  const updateWebFlags = db.prepare(
    "UPDATE messages SET is_read=?,starred=? WHERE id=? AND owner_id=?",
  );
  const updateExtra = db.prepare(
    "UPDATE protocol_messages SET extra_flags=? WHERE owner_id=? AND folder=? AND uid=?",
  );
  const move = db.prepare(
    "UPDATE messages SET previous_folder=folder, folder=?, trashed_at=? WHERE id=? AND owner_id=?",
  );

  function mailboxes(user) {
    let rows = findFolders.all(user.id);
    if (rows.length < folders.size) {
      for (const folder of folders.keys()) addFolder.run(user.id, folder);
      rows = findFolders.all(user.id);
    }
    return rows.map((row) => {
      const [name, special] = folders.get(row.folder);
      return {
        id: row.folder,
        name,
        delimiter: "/",
        attributes: ["\\HasNoChildren", ...(special ? [special] : [])],
        subscribed: Boolean(row.subscribed),
        uidValidity: row.validity,
        uidNext: row.next_uid,
      };
    });
  }
  function setFlags(user, folder, row, input) {
    const flags = cleanFlags(input);
    updateWebFlags.run(
      Number(flags.includes("\\Seen")),
      Number(flags.includes("\\Flagged")),
      row.id,
      user.id,
    );
    updateExtra.run(
      JSON.stringify(flags.filter((f) => f !== "\\Seen" && f !== "\\Flagged")),
      user.id,
      folder,
      row.uid,
    );
  }
  // Very old/imported rows can contain parsed fields with no original MIME.
  // Materialize only those rows once, retaining their existing IDs and attachments.
  async function restoreRaw(session, user, folder, row) {
    const m = db
      .prepare("SELECT m.*" + base + " AND p.uid=?")
      .get(user.id, folder, row.uid);
    if (!m || m.raw !== null) return;
    const attachments = db
      .prepare(
        "SELECT filename,content_type,content FROM attachments WHERE message_id=?",
      )
      .all(m.id)
      .map((a) => ({
        filename: a.filename,
        contentType: a.content_type,
        content: Buffer.from(a.content),
      }));
    const mime = await new MailComposer({
      from: { name: m.from_name, address: m.from_email },
      to: JSON.parse(m.to_json),
      cc: JSON.parse(m.cc_json),
      bcc: JSON.parse(m.bcc_json),
      subject: m.subject,
      date: new Date(m.created_at),
      messageId: m.message_id || undefined,
      text: m.body_text,
      html: m.body_html || undefined,
      attachments,
      disableFileAccess: true,
      disableUrlAccess: true,
    })
      .compile()
      .build();
    actor(session);
    db.prepare(
      "UPDATE messages SET raw=?,size=? WHERE raw IS NULL AND id=(SELECT message_id FROM protocol_messages WHERE owner_id=? AND folder=? AND uid=?)",
    ).run(mime, mime.length, user.id, folder, row.uid);
  }
  async function rowsFor(session, folder) {
    ensureFolder(folder);
    const user = actor(session);
    const rows = list.all(user.id, folder);
    if (!rows.some((r) => r.legacy)) return rows;
    for (const row of rows)
      if (row.legacy) await restoreRaw(session, user, folder, row);
    actor(session);
    return list.all(user.id, folder);
  }
  function readRaw(session, folder, uid) {
    const user = actor(session);
    const value = raw.get(user.id, folder, uid);
    if (!value)
      throw new ImapBackendError("Message no longer exists", "NONEXISTENT");
    return Buffer.from(
      value.raw.buffer,
      value.raw.byteOffset,
      value.raw.byteLength,
    );
  }
  function asMessage(row, load) {
    return {
      id: String(row.id),
      uid: row.uid,
      internalDate: new Date(row.created_at),
      flags: rowFlags(row),
      get raw() {
        return load(row);
      },
    };
  }
  function checkAppend(user, session, folder) {
    if (folder === "sent" || folder === "drafts") {
      actor(session, "mail.send");
      try {
        mail.assertSendingAllowed();
      } catch {
        throw denied();
      }
    } else {
      actor(session, folder === "trash" ? "mail.delete" : "mail.update");
    }
    return user;
  }
  function transfer(session, source, destination, uids, moving) {
    ensureFolder(source);
    ensureFolder(destination);
    const user = actor(session);
    checkAppend(user, session, destination);
    actor(
      session,
      moving && (source === "trash" || destination === "trash")
        ? "mail.delete"
        : "mail.update",
    );
    if (moving && source === destination)
      throw new ImapBackendError("Choose another folder", "CANNOT");
    return transaction(() => {
      const result = [];
      let used = moving ? 0 : mail.usage(user.id);
      for (const uid of new Set(uids)) {
        const row = one.get(user.id, source, uid);
        if (!row) continue;
        const trashed =
          destination === "trash" ? new Date().toISOString() : null;
        let id = row.id;
        if (moving) move.run(destination, trashed, id, user.id);
        else {
          used += row.size;
          if (used > user.quota_bytes)
            throw new ImapBackendError("Mailbox quota exceeded", "LIMIT");
          const copied = db
            .prepare(
              "INSERT INTO messages(owner_id,folder,previous_folder,trashed_at,from_email,from_name,to_json,cc_json,bcc_json,subject,body_text,body_html,snippet,raw,size,is_read,starred,delivery_status,message_id,created_at) SELECT owner_id,?,folder,?,from_email,from_name,to_json,cc_json,bcc_json,subject,body_text,body_html,snippet,raw,size,is_read,starred,delivery_status,message_id,created_at FROM messages WHERE owner_id=? AND id=?",
            )
            .run(destination, trashed, user.id, id);
          id = Number(copied.lastInsertRowid);
          db.prepare(
            "INSERT INTO attachments(message_id,filename,content_type,size,content) SELECT ?,filename,content_type,size,content FROM attachments WHERE message_id=?",
          ).run(id, row.id);
          db.prepare(
            "UPDATE protocol_messages SET extra_flags=?,pop_octets=? WHERE message_id=? AND owner_id=?",
          ).run(row.extra_flags, row.pop_octets, id, user.id);
        }
        const dest = db
          .prepare(
            "SELECT uid FROM protocol_messages WHERE owner_id=? AND folder=? AND message_id=?",
          )
          .get(user.id, destination, id);
        result.push({ sourceUid: uid, destinationUid: dest.uid });
      }
      return result;
    });
  }
  const backend = {
    listMailboxes: (session) => mailboxes(actor(session)),
    getMailboxByName: (session, name) =>
      mailboxes(actor(session)).find(
        (box) => box.name.toLowerCase() === String(name).toLowerCase(),
      ) || null,
    async getMessages(session, folder) {
      const rows = await rowsFor(session, folder);
      // SELECT/STATUS/UID listings only need metadata. Read MIME on demand for FETCH/SEARCH.
      let lastUid,
        lastBuffer,
        bytes = 0;
      const load = (row) => {
        if (lastUid !== row.uid) {
          bytes += row.size;
          if (bytes > Math.max(64 * 1024 * 1024, config.maxMessageBytes))
            throw new ImapBackendError(
              "Request a smaller message range",
              "LIMIT",
            );
          lastBuffer = readRaw(session, folder, row.uid);
          lastUid = row.uid;
        }
        return lastBuffer;
      };
      return rows.map((row) => asMessage(row, load));
    },
    async appendMessage(session, folder, input) {
      ensureFolder(folder);
      const user = checkAppend(actor(session), session, folder);
      const bytes = Buffer.from(input.raw);
      if (bytes.length > config.maxMessageBytes)
        throw new ImapBackendError("Message is too large", "LIMIT");
      const parsed = await mail.parse(bytes);
      return transaction(() => {
        const fresh = checkAppend(actor(session), session, folder);
        const flags = cleanFlags(input.flags);
        if (flags.includes("\\Deleted")) actor(session, "mail.delete");
        if (mail.usage(user.id) + bytes.length > fresh.quota_bytes)
          throw new ImapBackendError("Mailbox quota exceeded", "LIMIT");
        const id = mail.insert(
          fresh,
          folder,
          parsed,
          bytes,
          folder === "drafts" ? "draft" : "stored",
          false,
        );
        db.prepare(
          "UPDATE messages SET created_at=?,trashed_at=? WHERE id=? AND owner_id=?",
        ).run(
          input.internalDate.toISOString(),
          folder === "trash" ? new Date().toISOString() : null,
          id,
          user.id,
        );
        const { uid } = db
          .prepare(
            "SELECT uid FROM protocol_messages WHERE owner_id=? AND message_id=?",
          )
          .get(user.id, id);
        setFlags(user, folder, { id, uid }, flags);
        return asMessage(one.get(user.id, folder, uid), () => bytes);
      });
    },
    updateFlags(session, folder, uids, mode, input) {
      ensureFolder(folder);
      const user = actor(session);
      const flags = cleanFlags(input);
      return transaction(() => {
        const output = [];
        for (const uid of new Set(uids)) {
          const row = one.get(user.id, folder, uid);
          if (!row) continue;
          const before = rowFlags(row);
          const requested = new Set(flags.map((f) => f.toLowerCase()));
          const next = cleanFlags(
            mode === "add"
              ? [...before, ...flags]
              : mode === "remove"
                ? before.filter((f) => !requested.has(f.toLowerCase()))
                : flags,
          );
          if (before.includes("\\Deleted") !== next.includes("\\Deleted"))
            actor(session, "mail.delete");
          if (
            before
              .filter((f) => f !== "\\Deleted")
              .sort()
              .join(" ") !==
            next
              .filter((f) => f !== "\\Deleted")
              .sort()
              .join(" ")
          )
            actor(session, "mail.update");
          setFlags(user, folder, row, next);
          output.push(
            asMessage(one.get(user.id, folder, uid), (r) =>
              readRaw(session, folder, r.uid),
            ),
          );
        }
        return output;
      });
    },
    copyMessages: (s, from, to, uids) => transfer(s, from, to, uids, false),
    moveMessages: (s, from, to, uids) => transfer(s, from, to, uids, true),
    expungeMessages(session, folder, uids) {
      ensureFolder(folder);
      const user = actor(session);
      const targets = uids && new Set(uids);
      return transaction(() => {
        const doomed = list
          .all(user.id, folder)
          .filter(
            (r) =>
              (!targets || targets.has(r.uid)) &&
              rowFlags(r).includes("\\Deleted"),
          );
        if (doomed.length) actor(session, "mail.delete");
        for (const r of doomed)
          db.prepare(
            "DELETE FROM messages WHERE id=? AND owner_id=? AND folder=?",
          ).run(r.id, user.id, folder);
        return doomed.map((r) => r.uid);
      });
    },
    createMailbox: fixedFolder,
    deleteMailbox: fixedFolder,
    renameMailbox: fixedFolder,
    setSubscribed(session, folder, subscribed) {
      ensureFolder(folder);
      const user = actor(session, "mail.update");
      db.prepare(
        "UPDATE protocol_folders SET subscribed=? WHERE owner_id=? AND folder=?",
      ).run(Number(subscribed), user.id, folder);
    },
    subscribeChanges(session, listener) {
      const user = actor(session);
      const versions = new Map(
        findFolders.all(user.id).map((r) => [r.folder, r.revision]),
      );
      const timer = setInterval(() => {
        try {
          actor(session);
        } catch {
          clearInterval(timer);
          return;
        }
        for (const row of findFolders.all(user.id)) {
          if (versions.get(row.folder) !== row.revision) {
            versions.set(row.folder, row.revision);
            listener({ mailboxId: row.folder, type: "mailbox" });
          }
        }
      }, 2500);
      timer.unref();
      return () => clearInterval(timer);
    },
  };
  return {
    backend,
    rowsFor,
    readRaw,
    inboxInfo: (session) =>
      mailboxes(actor(session)).find((box) => box.id === "inbox"),
    rememberPopSize(session, uid, size) {
      db.prepare(
        "UPDATE protocol_messages SET pop_octets=? WHERE owner_id=? AND folder='inbox' AND uid=?",
      ).run(size, actor(session).id, uid);
    },
    popCommit(session, uids) {
      const user = actor(session, uids.length ? "mail.delete" : "mail.read");
      transaction(() => {
        for (const uid of uids) {
          const row = one.get(user.id, "inbox", uid);
          if (row) move.run("trash", new Date().toISOString(), row.id, user.id);
        }
      });
    },
  };
}
