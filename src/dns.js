import { createDnsResolver } from "./dns-resolver.js";
import { createPublicKey } from "node:crypto";
import { isIP } from "node:net";
import { AppError, domainName } from "./security.js";
import { outboundMode } from "./outbound.js";
import { isPublicIp } from "./webhooks.js";

export function dnsPlan(domain, config, input = {}, domainKey = null) {
  domain = domainName(domain);
  const configuredHost = config.mailHostname;
  const suggestedHost = ["localhost", "mail.example.com", ""].includes(
    configuredHost,
  )
    ? `mail.${domain}`
    : configuredHost;
  const hostname = domainName(
    String(input.hostname || suggestedHost)
      .trim()
      .replace(/\.$/, ""),
  );
  const webHost =
    config.production && config.publicUrl
      ? new URL(config.publicUrl).hostname.replace(/^\[|\]$/g, "")
      : "";
  const inferredIp = isPublicIp(webHost) ? webHost : "";
  const ip = String(input.ip || config.mailPublicIp || inferredIp).trim();
  const ipSource = input.ip
    ? "input"
    : config.mailPublicIp
      ? "configuration"
      : inferredIp
        ? "web-address"
        : "";
  if (ip && !isIP(ip)) throw new AppError("请输入有效的服务器公网 IP 地址");
  const webUrl =
    config.production && config.publicUrl
      ? config.publicUrl
      : `https://${hostname}`;
  const deliveryMode = outboundMode(config);
  const host = (fqdn) =>
    fqdn === domain
      ? "@"
      : fqdn.endsWith(`.${domain}`)
        ? fqdn.slice(0, -domain.length - 1)
        : fqdn;
  const record = (key, type, fqdn, value, purpose, extra = {}) => ({
    key,
    type,
    name: fqdn,
    host: host(fqdn),
    value,
    purpose,
    ...extra,
  });
  const signingKey =
    config.dkim?.domainName === domain ? config.dkim : domainKey;
  const selector = signingKey?.keySelector || "default";
  let dkim = null;
  if (signingKey?.domainName === domain) {
    const publicKey = createPublicKey(signingKey.privateKey);
    if (publicKey.asymmetricKeyType === "rsa")
      dkim = `v=DKIM1; k=rsa; p=${publicKey.export({ type: "spki", format: "der" }).toString("base64")}`;
  }
  const records = [
    record(
      "address",
      isIP(ip) === 6 ? "AAAA" : "A",
      hostname,
      ip || null,
      "将邮件主机指向部署邮局的公网服务器",
      {
        pending: ip
          ? ""
          : "填写 Linux 服务器公网 IP，不能填写 localhost 或 127.0.0.1",
      },
    ),
    record("mx", "MX", domain, hostname, "让其他邮局知道往哪里投递来信", {
      priority: 10,
    }),
    record(
      "spf",
      "TXT",
      domain,
      config.mailSpf ||
        (deliveryMode === "relay"
          ? null
          : ip
            ? `v=spf1 ${isIP(ip) === 6 ? "ip6" : "ip4"}:${ip} ~all`
            : "v=spf1 a mx ~all"),
      "授权允许的邮件发送服务器",
      {
        pending: config.mailSpf
          ? ""
          : deliveryMode === "relay"
            ? "从 SMTP 中继服务商复制 SPF 记录，并填写 MAIL_SPF；不能猜测中继的 include 值"
            : "此值授权当前邮局服务器；若还有其他发信来源，请合并为同一条 SPF。启用中继后须加入中继服务商的授权规则。",
      },
    ),
    record(
      "dkim",
      "TXT",
      `${selector}._domainkey.${domain}`,
      dkim,
      "为外发邮件提供签名公钥",
      {
        pending: dkim
          ? ""
          : "使用中继提供的 DKIM 记录，类型和主机名以服务商为准；或在服务器配置 DKIM_DOMAIN、DKIM_PRIVATE_KEY_PATH",
      },
    ),
    record(
      "dmarc",
      "TXT",
      `_dmarc.${domain}`,
      "v=DMARC1; p=none",
      "初始使用观察策略；已有 DMARC 时应保留现有策略",
    ),
  ];
  const warnings = [];
  if (!config.production)
    warnings.push("当前为本机开发模式，完成网页初始化并不代表公网收发已就绪。");
  if (hostname !== configuredHost)
    warnings.push(
      `当前服务 MAIL_HOSTNAME=${configuredHost}，部署时应改为 ${hostname} 并重启。`,
    );
  if (!config.tls?.cert)
    warnings.push(
      "尚未配置 SMTP TLS 证书，生产环境必须配置该主机名的有效证书。",
    );
  if (deliveryMode === "local")
    warnings.push("当前为本地投递模式，对外发信已关闭。");
  if (deliveryMode === "direct")
    warnings.push(
      "直接外发会查询收件方 MX 并连接其 25 端口；需放行出站 25，并在服务器商控制台将本机 IP 的 PTR 反向解析设为邮件主机名，同时配置 SPF、DKIM、DMARC。",
    );
  return {
    domain,
    hostname,
    ip,
    ipSource,
    records,
    warnings,
    relayConfigured: Boolean(config.relay),
    outboundMode: deliveryMode,
    tlsConfigured: Boolean(config.tls?.cert),
    env: [
      `MAIL_HOSTNAME=${hostname}`,
      `MAIL_PUBLIC_IP=${ip || "填写服务器公网IP"}`,
      `PUBLIC_URL=${webUrl}`,
    ].join("\n"),
    instructions: [
      "先把程序部署到 Linux 公网服务器；localhost 仅供这台电脑测试。",
      "在域名的 DNS 控制台添加下列记录，默认 TTL 可用 600 秒。Cloudflare 的邮件主机必须选「仅 DNS」，关闭橙色代理。",
      "邮件主机名的 A/AAAA 记录放在该主机所属 DNS 区域；当前邮箱域名的 MX、SPF、DMARC 放在当前域名下。",
      "放行云安全组和 Linux 防火墙的 25、587、443 端口；确认服务商允许入站 25。若使用 Docker，保留 compose.yaml 中的端口映射。",
      "为邮件主机申请 HTTPS/STARTTLS 证书，配置 .env 和反向代理，切换生产模式后重启。",
      "直接投递模式检查出站 25 与 PTR 反向解析；中继模式按服务商要求验证发件域名。用另一个外部邮箱分别测试收信与发信。",
    ],
  };
}

export async function checkDnsPlan(plan, resolver = createDnsResolver()) {
  const clean = (v) => String(v).trim().toLowerCase().replace(/\.$/, "");
  const tags = (v) =>
    Object.fromEntries(
      String(v)
        .split(";")
        .map((x) => {
          const i = x.indexOf("=");
          return i < 0
            ? null
            : [x.slice(0, i).trim().toLowerCase(), x.slice(i + 1).trim()];
        })
        .filter(Boolean),
    );
  const sameIp = (a, b) =>
    isIP(a) === 6 && isIP(b) === 6
      ? new URL(`http://[${a}]`).hostname === new URL(`http://[${b}]`).hostname
      : a === b;
  const timer = setTimeout(() => resolver.cancel?.(), 8000);
  timer.unref?.();
  try {
    const items = await Promise.all(
      plan.records.map(async (record) => {
        try {
          let found;
          if (record.key === "address")
            found = await resolver[
              record.type === "AAAA" ? "resolve6" : "resolve4"
            ](record.name);
          else if (record.key === "mx")
            found = (await resolver.resolveMx(record.name)).map((x) => ({
              exchange: x.exchange === "." ? "." : clean(x.exchange),
              priority: x.priority,
            }));
          else
            found = (await resolver.resolveTxt(record.name))
              .map((parts) => parts.join("").trim())
              .filter((v) =>
                record.key === "spf"
                  ? /^v=spf1\b/i.test(v)
                  : record.key === "dmarc"
                    ? /^v=DMARC1\b/i.test(v)
                    : /\bp\s*=/i.test(v),
              );
          if (!found.length)
            return {
              ...record,
              status: "missing",
              found,
              detail: "尚未查到对应记录，或 DNS 缓存尚未更新",
            };
          if (record.key === "spf" && found.length > 1)
            return {
              ...record,
              status: "mismatch",
              found,
              detail: "存在多条 SPF 记录，请合并为一条",
            };
          const matches =
            record.key === "mx"
              ? found.some((x) => x.exchange === clean(record.value))
              : record.key === "dmarc"
                ? found.length === 1 &&
                  ["none", "quarantine", "reject"].includes(
                    tags(found[0]).p?.toLowerCase(),
                  )
                : !record.value
                  ? false
                  : record.key === "dkim"
                    ? found.some(
                        (x) =>
                          tags(x).p?.replace(/\s/g, "") ===
                          tags(record.value).p?.replace(/\s/g, ""),
                      )
                    : record.key === "address"
                      ? found.some((x) => sameIp(x, record.value))
                      : found.some(
                          (x) =>
                            clean(x).replace(/\s+/g, " ") ===
                            clean(record.value).replace(/\s+/g, " "),
                        );
          return {
            ...record,
            status: matches ? "passed" : record.value ? "mismatch" : "review",
            found,
            detail: matches
              ? "当前 DNS 已解析到所需记录"
              : record.value
                ? "已有记录与本次指引不同，请核对"
                : "已查到记录；尚未提供预期值，请与中继服务商控制台核对",
          };
        } catch (error) {
          return {
            ...record,
            status: ["ENODATA", "ENOTFOUND"].includes(error.code)
              ? "missing"
              : "error",
            found: [],
            detail: ["ENODATA", "ENOTFOUND"].includes(error.code)
              ? "尚未查到此记录"
              : `DNS 查询失败：${error.code || "UNKNOWN"}`,
          };
        }
      }),
    );
    return {
      checkedAt: new Date().toISOString(),
      items,
      note: `${resolver.fallbackUsed ? `本地 DNS 不可用，已使用 HTTPS 公共 DNS（${resolver.provider}）` : "检测使用当前服务器的 DNS 解析器"}，结果可能受缓存影响。DNS 通过不代表 25 端口、中继验证或实际收发已经通过。`,
    };
  } finally {
    clearTimeout(timer);
  }
}
