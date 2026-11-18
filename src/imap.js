import { ImapServer } from "@push.rocks/smartimap";

export function createImapServer(
  config,
  auth,
  mailbox,
  { plaintext = false } = {},
) {
  if (plaintext && !config.plaintextMailbox)
    throw new Error("明文 IMAP 需要指定一个邮箱");
  return new ImapServer({
    hostname: config.mailHostname,
    tls: plaintext
      ? undefined
      : { ...config.tls, minVersion: "TLSv1.2", handshakeTimeout: 10000 },
    allowInsecureAuth: plaintext,
    backend: mailbox.backend,
    authMechanisms: ["LOGIN", "PLAIN"],
    maxConnections: 50,
    socketTimeoutMs: 30 * 60000,
    maxQueuedCommands: 16,
    maxCommandBytes: 16384,
    maxLiteralBytes: config.maxMessageBytes,
    maxAuthAttempts: 5,
    async authenticate(request) {
      if (!request.secure && !plaintext) return null;
      try {
        const id = await auth.authenticate(
          request.username,
          request.secret,
          request.remoteAddress,
          "mail.read",
          plaintext ? config.plaintextMailbox : undefined,
        );
        return { id, username: auth.authorize(id).email };
      } catch {
        return null;
      }
    },
  });
}
