import express from "express";
import helmet from "helmet";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { openStore } from "./db.js";
import { createMailService } from "./mail.js";
import { mountApi } from "./api.js";
import { createSmtpServers } from "./smtp.js";
import { createMailProtocolAuth } from "./mail-protocol-auth.js";
import { ensureDomainKeys } from "./domain-keys.js";
import { loadMailSettings } from "./mail-settings.js";
import { quotaError } from "./domain-quota.js";
import { createAssetHandler } from "./static-assets.js";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";

export async function start(overrides = {}) {
  const config = { ...loadConfig(), ...overrides };
  if (!/^[a-zA-Z0-9.-]+$/.test(config.mailHostname))
    throw new Error("MAIL_HOSTNAME 无效");
  const assets = await createAssetHandler(
    new URL("../public", import.meta.url),
  );
  const store = openStore(config);
  try {
    loadMailSettings(store.db, config);
    await ensureDomainKeys(store.db, config);
  } catch (error) {
    store.db.close();
    throw error;
  }
  const mail = createMailService(store, config);
  const app = express();
  app.disable("x-powered-by");
  if (config.trustProxy) app.set("trust proxy", config.trustProxy);
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", "data:", "https:"],
          connectSrc: ["'self'"],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
          baseUri: ["'self'"],
          formAction: ["'self'"],
          upgradeInsecureRequests: config.secureCookies ? [] : null,
        },
      },
      strictTransportSecurity: config.secureCookies ? undefined : false,
    }),
  );
  app.use("/api", (_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });
  app.use(express.json({ limit: Math.ceil(config.maxMessageBytes * 1.5) }));
  const api = mountApi(app, store, mail, config);
  app.get("/healthz", (_req, res) => {
    store.db.prepare("SELECT 1").get();
    res.json({ status: "ok" });
  });
  app.get(["/webmail", "/webmail/"], (_req, res) =>
    res.sendFile(
      fileURLToPath(new URL("../public/webmail.html", import.meta.url)),
    ),
  );
  app.use(assets);
  app.use(
    express.static(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../public"),
      { index: "index.html", maxAge: 0 },
    ),
  );
  app.use((error, _req, res, _next) => {
    error = quotaError(error);
    const duplicate =
      error.code?.startsWith("ERR_SQLITE") &&
      /UNIQUE constraint/.test(error.message);
    const status = duplicate ? 409 : error.status || 500;
    if (status >= 500) console.error(error);
    res.status(status).json({
      ...([
        "DOMAIN_MAILBOX_LIMIT",
        "DOMAIN_MAILBOX_LIMIT_BELOW_USAGE",
      ].includes(error.code)
        ? { code: error.code }
        : {}),
      error: duplicate
        ? "记录已存在，请检查邮箱、域名或转发目标"
        : status >= 500
          ? "服务暂时不可用，请查看服务器日志"
          : error.type === "entity.too.large"
            ? "请求内容过大"
            : error.message,
    });
  });
  const protocolAuth = createMailProtocolAuth(store, mail);
  const servers = createSmtpServers(store, mail, config, protocolAuth);
  const httpServer = createHttpServer(app);
  let httpsServer,
    imap,
    plainImap,
    pop3,
    imapPort = 0,
    imapsPort = 0;
  async function closeListeners() {
    const listeners = [
      httpServer,
      httpsServer,
      ...Object.values(servers),
    ].filter(Boolean);
    await Promise.all([
      ...listeners.map(
        (server) => new Promise((resolve) => server.close(resolve)),
      ),
      imap?.stop(),
      plainImap?.stop(),
      pop3?.close(),
    ]);
  }
  const listen = (server, port, host) =>
    new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => {
        server.removeListener("error", reject);
        server.on("error", (error) => console.error(error));
        resolve(server);
      });
    });
  try {
    await listen(httpServer, config.port, config.host);
    if (config.webTlsPort) {
      httpsServer = createHttpsServer(
        { ...config.tls, minVersion: "TLSv1.2" },
        app,
      );
      await listen(httpsServer, config.webTlsPort, config.webTlsHost);
    }
    await listen(servers.inbound, config.smtpPort, config.smtpHost);
    await listen(servers.submission, config.submissionPort, config.smtpHost);
    if (servers.smtps)
      await listen(servers.smtps, config.smtpsPort, config.smtpHost);
    if (config.imapPort || config.imapsPort || config.pop3sPort) {
      if (
        (config.imapsPort || config.pop3sPort) &&
        (!config.tls.cert || !config.tls.key)
      )
        throw new Error("Mailbox TLS certificate required");
      const { createProtocolMailbox } = await import("./protocol-mailbox.js");
      const mailbox = createProtocolMailbox(store, mail, protocolAuth, config);
      if (config.imapPort || config.imapsPort) {
        const { createImapServer } = await import("./imap.js");
        if (config.imapsPort) {
          imap = createImapServer(config, protocolAuth, mailbox);
          imapsPort = await imap.start(config.imapsPort, config.smtpHost);
        }
        if (config.imapPort) {
          plainImap = createImapServer(config, protocolAuth, mailbox, {
            plaintext: true,
          });
          imapPort = await plainImap.start(config.imapPort, config.smtpHost);
        }
      }
      if (config.pop3sPort) {
        const { createPop3Server } = await import("./pop3.js");
        pop3 = createPop3Server(config, protocolAuth, mailbox);
        await listen(pop3.server, config.pop3sPort, config.smtpHost);
      }
    }
  } catch (error) {
    api.close();
    await closeListeners();
    await mail.stop();
    store.db.close();
    throw error;
  }
  const ports = {
    http: httpServer.address().port,
    https: httpsServer?.address().port || 0,
    smtp: servers.inbound.server.address().port,
    submission: servers.submission.server.address().port,
    imap: imapPort,
    imaps: imapsPort,
    pop3s: pop3?.server.address().port || 0,
    smtps: servers.smtps?.server.address().port || 0,
  };
  console.log(
    `Post Office HTTP ${config.host}:${ports.http}${ports.https ? ` · HTTPS ${config.webTlsHost}:${ports.https}` : ""} · SMTP ${ports.smtp} · Submission ${ports.submission}`,
  );
  if (ports.imaps || ports.pop3s || ports.smtps)
    console.log(
      "External mail TLS listeners · IMAP " +
        ports.imaps +
        " · POP3 " +
        ports.pop3s +
        " · SMTP " +
        ports.smtps,
    );
  if (ports.imap)
    console.log(
      `Single-mailbox client access · IMAP ${ports.imap} · SMTP ${ports.smtp}`,
    );
  if (!store.db.prepare("SELECT id FROM users LIMIT 1").get())
    console.log("首次打开网页，直接设置管理员账号和密码即可，无需初始化口令。");
  void mail.work();
  return {
    app,
    config,
    store,
    mail,
    ports,
    async close() {
      api.close();
      await closeListeners();
      await mail.stop();
      store.db.close();
    },
  };
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  start()
    .then((instance) => {
      let closing = false;
      const shutdown = async () => {
        if (closing) return;
        closing = true;
        await instance.close();
        process.exit(0);
      };
      process.once("SIGINT", shutdown);
      process.once("SIGTERM", shutdown);
    })
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
