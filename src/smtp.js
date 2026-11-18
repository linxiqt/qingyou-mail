import { SMTPServer } from "smtp-server";
import { createMailProtocolAuth } from "./mail-protocol-auth.js";
import { AppError, emailAddress, makeWindowLimiter } from "./security.js";

export function createSmtpServers(
  store,
  mail,
  config,
  auth = createMailProtocolAuth(store, mail),
) {
  const credentials = new WeakMap();
  const messageRate = makeWindowLimiter(100, 60000);
  function create(submission, secure = false) {
    const mailboxOnInboundPort = submission
      ? undefined
      : config.plaintextMailbox;
    const server = new SMTPServer({
      name: config.mailHostname,
      banner: "Post Office",
      size: config.maxMessageBytes,
      ...config.tls,
      secure,
      minVersion: "TLSv1.2",
      authOptional: !submission,
      disabledCommands: submission || mailboxOnInboundPort ? [] : ["AUTH"],
      hideSTARTTLS: !config.tls.cert,
      allowInsecureAuth: Boolean(
        mailboxOnInboundPort || (submission && config.allowInsecureAuth),
      ),
      disableReverseLookup: true,
      maxClients: 50,
      socketTimeout: 60000,
      closeTimeout: 1000,
      onAuth(login, session, callback) {
        (async () => {
          if (!submission && !mailboxOnInboundPort)
            throw new AppError("Authentication unavailable", 403, 535);
          if (
            !session.secure &&
            !mailboxOnInboundPort &&
            !config.allowInsecureAuth
          )
            throw new AppError("必须使用 STARTTLS 后登录", 403, 538);
          const identity = await auth.authenticate(
            login.username,
            login.password,
            session.remoteAddress,
            "mail.send",
            mailboxOnInboundPort,
          );
          credentials.set(session, identity);
          return auth.authorize(identity).id;
        })().then((id) => callback(null, { user: id }), callback);
      },
      onMailFrom(address, session, callback) {
        try {
          messageRate(
            session.user ? `u:${session.user}` : `ip:${session.remoteAddress}`,
          );
          if (submission || session.user) {
            mail.assertSendingAllowed?.();
            const user = auth.authorize(credentials.get(session), "mail.send");
            if (!user || emailAddress(address.address) !== user.email)
              throw new AppError(
                "Sender must match authenticated account",
                403,
                553,
              );
          } else if (
            address.address &&
            mail.isLocalDomain(emailAddress(address.address))
          )
            throw new AppError(
              "Local senders must use authenticated submission",
              403,
              553,
            );
          callback();
        } catch (error) {
          callback(error);
        }
      },
      onRcptTo(address, session, callback) {
        try {
          if (session.envelope.rcptTo.length >= 100)
            throw new AppError("Too many recipients", 400, 452);
          const email = emailAddress(address.address);
          const sending = submission || Boolean(session.user);
          if (!sending && !mail.acceptsRecipient(email))
            throw new AppError("Relay denied or mailbox unavailable", 403, 550);
          if (
            sending &&
            mail.isLocalDomain(email) &&
            !mail.acceptsRecipient(email)
          )
            throw new AppError("Mailbox unavailable", 400, 550);
          if (
            sending &&
            !mail.isLocalDomain(email) &&
            mail.outboundMode === "local"
          )
            throw new AppError("Outbound delivery is disabled", 400, 451);
          callback();
        } catch (error) {
          callback(error);
        }
      },
      onData(stream, session, callback) {
        (async () => {
          const chunks = [];
          let size = 0;
          for await (const chunk of stream) {
            size += chunk.length;
            if (size <= config.maxMessageBytes) chunks.push(chunk);
          }
          if (stream.sizeExceeded || size > config.maxMessageBytes)
            throw new AppError("Message too large", 413, 552);
          const currentSender = () =>
            auth.authorize(credentials.get(session), "mail.send");
          const sending = submission || Boolean(session.user);
          const user = sending ? currentSender() : null;
          if (sending && !user)
            throw new AppError("Account disabled", 403, 535);
          await mail.receive(
            Buffer.concat(chunks),
            {
              from: session.envelope.mailFrom.address,
              to: session.envelope.rcptTo.map((r) => r.address),
            },
            user,
            session.remoteAddress,
            sending ? currentSender : null,
          );
        })().then(
          () => {
            callback(null, "Message accepted");
            void mail.work();
          },
          (error) =>
            callback(
              Object.assign(error, { responseCode: error.responseCode || 451 }),
            ),
        );
      },
    });
    // New connections use the hostname saved in the web admin without a restart.
    Object.defineProperty(server.options, "name", {
      get: () => config.mailHostname,
      configurable: true,
    });
    return server;
  }
  return {
    inbound: create(false),
    submission: create(true),
    ...(config.smtpsPort ? { smtps: create(true, true) } : {}),
  };
}
