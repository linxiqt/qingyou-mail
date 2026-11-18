import path from "node:path";
import { readFileSync } from "node:fs";
import { X509Certificate } from "node:crypto";
import { createSecureContext } from "node:tls";
import { dkimSelector } from "./domain-keys.js";
import { domainName, emailAddress } from "./security.js";

export function loadConfig(env = process.env) {
  const number = (key, fallback, min = 1, max = 65535) => {
    const value = Number(env[key] || fallback);
    if (!Number.isInteger(value) || value < min || value > max)
      throw new Error(`${key} 配置无效`);
    return value;
  };
  const production = env.NODE_ENV === "production";
  const publicUrl = new URL(env.PUBLIC_URL || "http://localhost:3000");
  if (
    !["http:", "https:"].includes(publicUrl.protocol) ||
    publicUrl.username ||
    publicUrl.password ||
    publicUrl.pathname !== "/" ||
    publicUrl.search ||
    publicUrl.hash
  )
    throw new Error("PUBLIC_URL 必须为不带路径、查询参数或密码的 HTTP(S) 地址");
  const dnsDohUrl = new URL(
    env.DNS_DOH_URL || "https://dns.alidns.com/resolve",
  );
  if (
    dnsDohUrl.protocol !== "https:" ||
    dnsDohUrl.username ||
    dnsDohUrl.password
  )
    throw new Error("DNS_DOH_URL 必须使用无用户名密码的 HTTPS 地址");
  if (production && publicUrl.protocol !== "https:")
    throw new Error("生产环境 PUBLIC_URL 必须使用 HTTPS");
  if (Boolean(env.TLS_CERT_PATH) !== Boolean(env.TLS_KEY_PATH))
    throw new Error("必须同时配置 TLS_CERT_PATH 与 TLS_KEY_PATH");
  const tls = env.TLS_CERT_PATH
    ? {
        cert: readFileSync(env.TLS_CERT_PATH),
        key: readFileSync(env.TLS_KEY_PATH),
      }
    : {};
  if (env.TLS_SNI_HOSTNAME || env.TLS_SNI_CERT_PATH || env.TLS_SNI_KEY_PATH) {
    if (
      !tls.cert ||
      !env.TLS_SNI_HOSTNAME ||
      !env.TLS_SNI_CERT_PATH ||
      !env.TLS_SNI_KEY_PATH
    )
      throw new Error(
        "域名证书需要默认证书及完整的 TLS_SNI_HOSTNAME、TLS_SNI_CERT_PATH、TLS_SNI_KEY_PATH",
      );
    const hostname = domainName(env.TLS_SNI_HOSTNAME);
    const cert = readFileSync(env.TLS_SNI_CERT_PATH);
    if (!new X509Certificate(cert).checkHost(hostname, { subject: "never" }))
      throw new Error("TLS_SNI_HOSTNAME 与域名证书不匹配");
    const context = createSecureContext({
      cert,
      key: readFileSync(env.TLS_SNI_KEY_PATH),
      minVersion: "TLSv1.2",
    });
    // Returning no context keeps the listener's default certificate for other names.
    tls.SNICallback = (name, done) =>
      done(
        null,
        name.toLowerCase().replace(/\.$/, "") === hostname
          ? context
          : undefined,
      );
  }
  if (production && !tls.cert)
    throw new Error("生产环境 SMTP 必须配置 TLS 证书");
  const plaintextMailbox = env.MAIL_PLAINTEXT_ACCOUNT
    ? emailAddress(env.MAIL_PLAINTEXT_ACCOUNT)
    : "";
  const imapPort = number("IMAP_PORT", plaintextMailbox ? 143 : 0, 0);
  if (imapPort && !plaintextMailbox)
    throw new Error("IMAP_PORT 需要指定 MAIL_PLAINTEXT_ACCOUNT");
  const imapsPort = number("IMAPS_PORT", production ? 993 : 0, 0);
  const pop3sPort = number("POP3S_PORT", production ? 995 : 0, 0);
  const smtpsPort = number("SMTPS_PORT", production ? 465 : 0, 0);
  if ((imapsPort || pop3sPort || smtpsPort) && !tls.cert)
    throw new Error("第三方邮箱协议需要配置 TLS_CERT_PATH 和 TLS_KEY_PATH");
  if (production && env.SMTP_ALLOW_INSECURE_AUTH === "true")
    throw new Error("生产环境禁止明文 SMTP 登录");
  const webTlsPort = number("WEB_TLS_PORT", 0, 0);
  if (webTlsPort && (!tls.cert || publicUrl.protocol !== "https:"))
    throw new Error("内置 HTTPS 需要 HTTPS 网页地址和 TLS 证书");
  if (webTlsPort && number("TRUST_PROXY", 0, 0, 10) !== 0)
    throw new Error("内置 HTTPS 直连模式必须设置 TRUST_PROXY=0");
  if (
    webTlsPort &&
    !["127.0.0.1", "::1", "localhost"].includes(env.HOST || "127.0.0.1")
  )
    throw new Error("内置 HTTPS 模式的 HTTP 健康检查只允许监听回环地址");
  const outboundMode = env.OUTBOUND_MODE || "auto";
  if (!["auto", "direct", "relay", "local"].includes(outboundMode))
    throw new Error("OUTBOUND_MODE 必须为 auto、direct、relay 或 local");
  const dkimBackend = env.DKIM_BACKEND || "node";
  if (!["node", "rspamd"].includes(dkimBackend))
    throw new Error("DKIM_BACKEND 必须为 node 或 rspamd");
  if (
    dkimBackend === "rspamd" &&
    (env.DKIM_DOMAIN || env.DKIM_PRIVATE_KEY_PATH || env.DKIM_SELECTOR)
  )
    throw new Error(
      "Rspamd 模式不可同时配置 DKIM_DOMAIN、DKIM_PRIVATE_KEY_PATH 或 DKIM_SELECTOR",
    );
  const rspamdUrl = new URL(env.RSPAMD_URL || "http://127.0.0.1:11333/checkv2");
  if (
    !["http:", "https:"].includes(rspamdUrl.protocol) ||
    !["127.0.0.1", "[::1]"].includes(rspamdUrl.hostname) ||
    rspamdUrl.username ||
    rspamdUrl.password ||
    rspamdUrl.pathname !== "/checkv2" ||
    rspamdUrl.search ||
    rspamdUrl.hash
  )
    throw new Error(
      "RSPAMD_URL 必须为本机回环 IP 的 /checkv2 地址且不带认证或查询参数",
    );
  return {
    production,
    publicUrl: publicUrl.origin,
    secureCookies: publicUrl.protocol === "https:",
    host: env.HOST || "127.0.0.1",
    port: number("PORT", 3000, 0),
    webTlsPort,
    webTlsHost: env.WEB_TLS_HOST || "127.0.0.1",
    dataDir: path.resolve(env.DATA_DIR || "./data"),
    trustProxy: number("TRUST_PROXY", 0, 0, 10),
    mailHostname: env.MAIL_HOSTNAME || "localhost",
    mailPublicIp: env.MAIL_PUBLIC_IP || "",
    mailSpf: env.MAIL_SPF || "",
    dnsDohUrl: dnsDohUrl.href,
    dnsDohFallback: env.DNS_DOH_FALLBACK !== "false",
    smtpHost: env.SMTP_HOST || "127.0.0.1",
    smtpPort: number("SMTP_PORT", 2525, 0),
    submissionPort: number("SUBMISSION_PORT", 1587, 0),
    plaintextMailbox,
    imapPort,
    imapsPort,
    pop3sPort,
    smtpsPort,
    tls,
    allowInsecureAuth: env.SMTP_ALLOW_INSECURE_AUTH === "true",
    maxMessageBytes: number("MAX_MESSAGE_MB", 20, 1, 100) * 1024 * 1024,
    defaultQuotaBytes:
      number("DEFAULT_QUOTA_MB", 1024, 1, 1048576) * 1024 * 1024,
    remoteApiAllowPrivate: env.REMOTE_API_ALLOW_PRIVATE === "true",
    outboundMode,
    directRequireTls: env.DIRECT_REQUIRE_TLS === "true",
    directDeliveryTimeoutMs: number(
      "DIRECT_DELIVERY_TIMEOUT_MS",
      60000,
      5000,
      120000,
    ),
    deliveryMaxAttempts: number("DELIVERY_MAX_ATTEMPTS", 48, 1, 200),
    deliveryMaxAgeMs: number("DELIVERY_MAX_AGE_HOURS", 120, 1, 168) * 3600000,
    dkimBackend,
    rspamdUrl: rspamdUrl.href,
    rspamdTimeoutMs: number("RSPAMD_TIMEOUT_MS", 10000, 1000, 60000),
    rspamdKeyDir: path.resolve(
      env.RSPAMD_KEY_DIR || "/var/lib/postoffice-dkim",
    ),
    rspamdSelector: dkimSelector(env.RSPAMD_SELECTOR || "rspamd"),
    rspamadmPath: env.RSPAMADM_PATH || "/usr/bin/rspamadm",
    relay: env.RELAY_HOST
      ? {
          host: env.RELAY_HOST,
          port: number("RELAY_PORT", 587),
          secure: env.RELAY_SECURE === "true",
          requireTLS: env.RELAY_SECURE !== "true",
          ...(env.RELAY_USER
            ? { auth: { user: env.RELAY_USER, pass: env.RELAY_PASSWORD || "" } }
            : {}),
          connectionTimeout: 15000,
          greetingTimeout: 15000,
          socketTimeout: 30000,
          disableFileAccess: true,
          disableUrlAccess: true,
        }
      : null,
    dkim:
      env.DKIM_DOMAIN && env.DKIM_PRIVATE_KEY_PATH
        ? {
            domainName: env.DKIM_DOMAIN,
            keySelector: env.DKIM_SELECTOR || "mail",
            privateKey: readFileSync(env.DKIM_PRIVATE_KEY_PATH, "utf8"),
          }
        : undefined,
    webhookAllowPrivate: env.WEBHOOK_ALLOW_PRIVATE === "true",
  };
}
