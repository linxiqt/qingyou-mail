import http from "node:http";
import https from "node:https";
import { domainName, emailAddress } from "./security.js";

const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_SIGNATURE_BYTES = 16 * 1024;

function signingError(message, cause) {
  return Object.assign(
    new Error(`Rspamd DKIM 签名失败：${message}`, { cause }),
    {
      responseCode: 451,
    },
  );
}

function headerValue(value, name) {
  if (
    typeof value !== "string" ||
    !value.length ||
    value.length > 320 ||
    /[^\x21-\x7e]/.test(value)
  )
    throw signingError(`${name} 无效`);
  return value;
}

function signatureHeader(value, domain, selector) {
  if (
    typeof value !== "string" ||
    !value.length ||
    Buffer.byteLength(value) > MAX_SIGNATURE_BYTES ||
    /[^\x09\x0a\x0d\x20-\x7e]/.test(value)
  )
    throw signingError("返回了无效签名");

  // Rspamd versions can return LF folding. SMTP headers use CRLF; folds must
  // remain continuation lines so a response cannot add arbitrary mail headers.
  const folded = value.replace(/\r?\n$/, "").replace(/\r?\n/g, "\r\n");
  if (/\r(?!\n)|(?<!\r)\n|\r\n(?![\t ])/.test(folded))
    throw signingError("签名包含非法换行");
  const header = /^DKIM-Signature:/i.test(folded)
    ? folded
    : `DKIM-Signature: ${folded}`;
  if (header.split("\r\n").some((line) => line.length > 998))
    throw signingError("签名头过长");
  const unfolded = header
    .slice(header.indexOf(":") + 1)
    .replace(/\r\n[\t ]+/g, " ");
  const tags = new Map();
  for (const part of unfolded.split(";")) {
    if (!part.trim()) continue;
    const match = /^\s*([a-z][a-z0-9_]*)\s*=\s*([\s\S]*?)\s*$/i.exec(part);
    if (!match || tags.has(match[1].toLowerCase()))
      throw signingError("签名标签无效");
    tags.set(match[1].toLowerCase(), match[2]);
  }
  if (
    tags.get("v") !== "1" ||
    !/^(?:rsa|ed25519)-sha256$/i.test(tags.get("a") || "") ||
    !/^[a-z0-9+/]+={0,2}$/i.test((tags.get("b") || "").replace(/\s/g, "")) ||
    !/^[a-z0-9+/]+={0,2}$/i.test((tags.get("bh") || "").replace(/\s/g, "")) ||
    !(tags.get("h") || "")
      .split(":")
      .some((h) => h.trim().toLowerCase() === "from")
  )
    throw signingError("返回了不完整签名");
  if (
    (tags.get("d") || "").toLowerCase() !== domain ||
    (tags.get("s") || "").toLowerCase() !== selector.toLowerCase()
  )
    throw signingError("签名域名或选择器不匹配");
  return Buffer.from(`${header}\r\n`, "ascii");
}

function readReply(url, raw, headers, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };
    const transport = url.protocol === "https:" ? https : http;
    const request = transport.request(
      url,
      { method: "POST", headers, agent: false },
      (response) => {
        if (response.statusCode !== 200) {
          finish(signingError(`HTTP ${response.statusCode}`));
          response.destroy();
          return;
        }
        if (Number(response.headers["content-length"]) > MAX_RESPONSE_BYTES) {
          finish(signingError("响应过大"));
          response.destroy();
          return;
        }
        const chunks = [];
        let bytes = 0;
        response.on("data", (chunk) => {
          bytes += chunk.length;
          if (bytes > MAX_RESPONSE_BYTES) {
            finish(signingError("响应过大"));
            response.destroy();
          } else chunks.push(chunk);
        });
        response.on("error", (error) =>
          finish(signingError("读取响应失败", error)),
        );
        response.on("aborted", () => finish(signingError("响应中断")));
        response.on("end", () => {
          if (settled) return;
          try {
            finish(
              null,
              JSON.parse(Buffer.concat(chunks, bytes).toString("utf8")),
            );
          } catch (error) {
            finish(signingError("响应不是有效 JSON", error));
          }
        });
      },
    );
    request.on("error", (error) => finish(signingError("连接失败", error)));
    // An absolute deadline also bounds a peer that keeps sending tiny chunks.
    timer = setTimeout(() => {
      finish(signingError("请求超时"));
      request.destroy();
    }, timeoutMs);
    timer.unref?.();
    request.end(raw);
  });
}

export async function signWithRspamd(
  config,
  { raw, sender, recipient, domain, selector },
) {
  try {
    if (!Buffer.isBuffer(raw) || !raw.length)
      throw signingError("邮件原文无效");
    const signingDomain = domainName(headerValue(domain, "域名"));
    const signingSelector = headerValue(selector, "选择器");
    if (!/^[a-z0-9](?:[a-z0-9_.-]{0,126}[a-z0-9])?$/i.test(signingSelector))
      throw signingError("选择器无效");
    const from = emailAddress(headerValue(sender, "发件人"));
    const to = emailAddress(headerValue(recipient, "收件人"));
    const helo = domainName(headerValue(config.mailHostname, "主机名"));
    if (from.slice(from.lastIndexOf("@") + 1) !== signingDomain)
      throw signingError("发件域名不匹配");
    const url = new URL(config.rspamdUrl);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      !["127.0.0.1", "[::1]"].includes(url.hostname) ||
      url.pathname !== "/checkv2" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw signingError("服务地址必须是本机 checkv2 接口");
    const timeoutMs = config.rspamdTimeoutMs ?? 10000;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000)
      throw signingError("请求超时配置无效");
    const reply = await readReply(
      url,
      raw,
      {
        "Content-Type": "message/rfc822",
        "Content-Length": raw.length,
        Accept: "application/json",
        "Accept-Encoding": "identity",
        User: from,
        From: from,
        Rcpt: to,
        IP: "127.0.0.1",
        Helo: helo,
        Settings: JSON.stringify({ symbols_enabled: ["DKIM_SIGNED"] }),
        Log: "no",
      },
      timeoutMs,
    );
    const signatures = reply?.["dkim-signature"];
    const values = Array.isArray(signatures) ? signatures : [signatures];
    if (!values.length || values.length > 4)
      throw signingError("未返回有效签名");
    return Buffer.concat([
      ...values.map((value) =>
        signatureHeader(value, signingDomain, signingSelector),
      ),
      raw,
    ]);
  } catch (error) {
    if (error.responseCode === 451) throw error;
    throw signingError("无法完成签名", error);
  }
}
