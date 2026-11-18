import tls from "node:tls";
import { setImmediate as yieldIO } from "node:timers/promises";
import { popOctets } from "./pop-octets.js";

function wireMessage(bytes) {
  let text = bytes.toString("latin1").replace(/\r\n|\r|\n/g, "\r\n");
  if (text && !text.endsWith("\r\n")) text += "\r\n";
  return Buffer.from(text, "latin1");
}
function topLines(message, count) {
  const split = message.indexOf("\r\n\r\n");
  if (split < 0) return message;
  let end = split + 4;
  while (count-- > 0 && end < message.length) {
    const next = message.indexOf("\r\n", end);
    end = next < 0 ? message.length : next + 2;
  }
  return message.subarray(0, end);
}
const chunkSize = 64 * 1024;
async function sendMessage(write, message) {
  for (let offset = 0; offset < message.length; offset += chunkSize) {
    const chunk = message
      .subarray(offset, offset + chunkSize)
      .toString("latin1");
    const prefix =
      (offset === 0 || message[offset - 1] === 10) && chunk.startsWith(".")
        ? "."
        : "";
    await write(Buffer.from(prefix + chunk.replace(/\n\./g, "\n.."), "latin1"));
  }
  await write(".\r\n");
}

export function createPop3Server(config, auth, mailbox) {
  const locked = new Set(),
    transports = new Set(),
    sessions = new Set();
  let stopping = false;
  async function serve(socket) {
    const write = (value) =>
      new Promise((resolve, reject) =>
        socket.write(value, (error) => (error ? reject(error) : resolve())),
      );
    const ok = (value = "") => write("+OK " + value + "\r\n");
    const err = (value = "Invalid command or argument") =>
      write("-ERR " + value + "\r\n");
    let identity,
      owner,
      username,
      authPlain = false,
      failures = 0,
      messages = [],
      validity;
    const deleted = new Set();
    const selected = (index) =>
      Number.isSafeInteger(index) &&
      index > 0 &&
      !deleted.has(index) &&
      messages[index - 1];
    const multi = (entries) =>
      write(entries.length ? entries.join("\r\n") + "\r\n.\r\n" : ".\r\n");
    async function login(name, password) {
      try {
        const token = await auth.authenticate(
          name,
          password,
          socket.remoteAddress,
          "mail.read",
        );
        if (socket.destroyed) return;
        const user = auth.authorize(token, "mail.read");
        if (locked.has(user.id)) {
          await err("[IN-USE] Maildrop already locked");
          return;
        }
        owner = user.id;
        locked.add(owner);
        validity = mailbox.inboxInfo(token).uidValidity;
        const rows = await mailbox.rowsFor(token, "inbox");
        messages = [];
        let sliceStarted = Date.now();
        for (const row of rows) {
          let size = row.pop_octets;
          if (size === null) {
            size = popOctets(mailbox.readRaw(token, "inbox", row.uid));
            mailbox.rememberPopSize(token, row.uid, size);
          }
          messages.push({ uid: row.uid, size });
          if (Date.now() - sliceStarted > 25) {
            await yieldIO();
            if (socket.destroyed) return;
            sliceStarted = Date.now();
          }
        }
        auth.authorize(token, "mail.read");
        identity = token;
        socket.setTimeout(10 * 60000);
        await ok("Maildrop ready");
      } catch {
        if (owner !== undefined) {
          locked.delete(owner);
          owner = undefined;
        }
        await err("[AUTH] Authentication failed");
        if (++failures >= 5) socket.end();
      }
    }
    async function plain(payload) {
      authPlain = false;
      const fields = Buffer.from(payload, "base64")
        .toString("utf8")
        .split("\0");
      if (
        payload === "*" ||
        fields.length !== 3 ||
        (fields[0] && fields[0] !== fields[1])
      )
        return err("Invalid authentication exchange");
      await login(fields[1], fields[2]);
    }
    async function command(line) {
      if (authPlain) {
        await plain(line);
        return;
      }
      const split = line.indexOf(" ");
      const verb = (split < 0 ? line : line.slice(0, split)).toUpperCase();
      const arg = split < 0 ? "" : line.slice(split + 1);
      if (identity) {
        try {
          auth.authorize(identity, "mail.read");
        } catch {
          await err("[AUTH] Mailbox session expired");
          return "close";
        }
      }
      if (verb === "QUIT") {
        if (identity)
          mailbox.popCommit(
            identity,
            [...deleted].map((n) => messages[n - 1].uid),
          );
        await ok("Goodbye");
        return "close";
      }
      if (verb === "CAPA") {
        await ok("Capabilities");
        await multi(["USER", "SASL PLAIN", "UIDL", "TOP", "RESP-CODES"]);
        return;
      }
      if (!identity) {
        if (verb === "USER" && arg) {
          username = arg;
          await ok("Password required");
        } else if (verb === "PASS" && username) await login(username, arg);
        else if (verb === "AUTH" && /^PLAIN(?: |$)/i.test(arg)) {
          if (arg.trim().toUpperCase() === "PLAIN") {
            authPlain = true;
            await write("+ \r\n");
          } else await plain(arg.slice(6));
        } else await err("Authenticate with USER/PASS or AUTH PLAIN");
        return;
      }
      if (verb === "NOOP") return ok();
      if (verb === "RSET") {
        deleted.clear();
        return ok("Deletion marks cleared");
      }
      if (verb === "STAT")
        return ok(
          messages.length -
            deleted.size +
            " " +
            messages.reduce(
              (sum, m, i) => sum + (deleted.has(i + 1) ? 0 : m.size),
              0,
            ),
        );
      if (verb === "LIST" || verb === "UIDL") {
        const value = (n) =>
          n +
          " " +
          (verb === "LIST"
            ? messages[n - 1].size
            : validity + "-" + messages[n - 1].uid);
        if (arg) {
          const n = /^\d+$/.test(arg) ? Number(arg) : 0;
          return selected(n) ? ok(value(n)) : err("No such message");
        }
        await ok("Maildrop listing");
        return multi(
          messages.flatMap((_, i) =>
            deleted.has(i + 1) ? [] : [value(i + 1)],
          ),
        );
      }
      if (["RETR", "TOP", "DELE"].includes(verb)) {
        const parts = arg.split(/ +/);
        const n = Number(parts[0]);
        const match = selected(n);
        if (
          !match ||
          !/^\d+$/.test(parts[0]) ||
          (verb === "TOP"
            ? parts.length !== 2 || !/^\d{1,10}$/.test(parts[1])
            : parts.length !== 1)
        )
          return err("Invalid message or arguments");
        if (verb === "DELE") {
          auth.authorize(identity, "mail.delete");
          deleted.add(n);
          return ok("Marked for removal on QUIT");
        }
        const wire = wireMessage(mailbox.readRaw(identity, "inbox", match.uid));
        await ok(verb === "TOP" ? "Top of message" : wire.length + " octets");
        return sendMessage(
          write,
          verb === "TOP" ? topLines(wire, Number(parts[1])) : wire,
        );
      }
      await err();
    }
    socket.setTimeout(60000, () => socket.destroy());
    try {
      await ok("Qingyou POP3 ready");
      let pending = Buffer.alloc(0);
      for await (const chunk of socket) {
        pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
        let end;
        while ((end = pending.indexOf("\r\n")) >= 0) {
          if (end > 4096) {
            await err("Line too long");
            return;
          }
          const line = pending.subarray(0, end).toString("utf8");
          pending = pending.subarray(end + 2);
          try {
            if ((await command(line)) === "close" || socket.writableEnded)
              return;
          } catch {
            if (socket.destroyed) return;
            await err("Operation unavailable or permission denied");
          }
        }
        if (pending.length > 4096) {
          await err("Line too long");
          return;
        }
      }
    } finally {
      if (owner !== undefined) locked.delete(owner);
      socket.end();
    }
  }
  const server = tls.createServer(
    { ...config.tls, minVersion: "TLSv1.2", handshakeTimeout: 10000 },
    (socket) => {
      if (stopping) {
        socket.destroy();
        return;
      }
      transports.add(socket);
      socket.once("close", () => transports.delete(socket));
      const done = serve(socket).catch(() => socket.destroy());
      sessions.add(done);
      done.finally(() => sessions.delete(done));
    },
  );
  server.maxConnections = 50;
  return {
    server,
    async close() {
      stopping = true;
      const closed = new Promise((resolve) => server.close(resolve));
      for (const socket of transports) socket.destroy();
      await closed;
      await Promise.allSettled([...sessions]);
    },
  };
}
