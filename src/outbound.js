import nodemailer from "nodemailer";
import { connect, isIP } from "node:net";
import { randomInt } from "node:crypto";
import { createDnsResolver } from "./dns-resolver.js";
import { domainName, emailAddress } from "./security.js";
import { isPublicIp } from "./webhooks.js";

export function outboundMode(config) {
  const mode = config.outboundMode || "auto";
  return mode === "auto" ? (config.relay ? "relay" : "direct") : mode;
}

function deliveryError(message, permanent = false) {
  return Object.assign(new Error(message), {
    responseCode: permanent ? 550 : 451,
  });
}

export async function mxTargets(domain, resolver) {
  let records;
  try {
    records = await resolver.resolveMx(domain);
  } catch (error) {
    if (error.code === "ENOTFOUND")
      throw deliveryError(`收件域名不存在：${domain}`, true);
    if (error.code !== "ENODATA") throw error;
    records = [];
  }
  if (!records.length) return [{ priority: 0, exchange: domain }];
  const hostname = (r) => String(r.exchange || "").replace(/\.$/, "");
  if (records.length === 1 && !hostname(records[0]))
    throw deliveryError(`收件域名声明不接收邮件（Null MX）：${domain}`, true);
  records = records.filter(
    (r) =>
      hostname(r) &&
      Number.isInteger(r.priority) &&
      r.priority >= 0 &&
      r.priority <= 65535,
  );
  if (!records.length) throw deliveryError(`收件域名的 MX 无效：${domain}`);
  // Shuffle before a stable priority sort so equal-preference MXs share traffic.
  records = [...records];
  for (let i = records.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [records[i], records[j]] = [records[j], records[i]];
  }
  return records
    .sort((a, b) => a.priority - b.priority)
    .slice(0, 5)
    .map((r) => ({
      priority: r.priority,
      exchange: domainName(hostname(r)),
    }));
}

export function createOutbound(config, dependencies = {}) {
  const mode = outboundMode(config);
  if (!["direct", "relay", "local"].includes(mode))
    throw new Error("OUTBOUND_MODE 无效");
  const factory = dependencies.createTransport || nodemailer.createTransport;
  if (mode === "relay") {
    if (!config.relay) throw new Error("中继模式需要配置 RELAY_HOST");
    let hostname = config.mailHostname;
    let transport = factory({ ...config.relay, name: hostname });
    return {
      mode,
      sendMail(message) {
        if (hostname !== config.mailHostname) {
          transport.close();
          hostname = config.mailHostname;
          transport = factory({ ...config.relay, name: hostname });
        }
        return transport.sendMail(message);
      },
      close: () => transport.close(),
    };
  }
  if (mode === "local")
    return {
      mode,
      sendMail: async () => {
        throw deliveryError("外部投递已关闭");
      },
      close() {},
    };
  const resolver = dependencies.resolver || createDnsResolver(config);
  return {
    mode,
    close() {
      resolver.cancel?.();
    },
    async sendMail(message) {
      if (message.envelope.to.length !== 1)
        throw new Error("每个投递任务必须只有一个收件人");
      const recipient = emailAddress(message.envelope.to[0]);
      const domain = recipient.split("@")[1];
      const deadline = Date.now() + (config.directDeliveryTimeoutMs || 60000);
      const records = await mxTargets(domain, resolver);
      let lastError;
      for (const mx of records) {
        if (Date.now() >= deadline)
          throw lastError || deliveryError("MX 投递超时，稍后重试");
        const lookups = await Promise.allSettled([
          resolver.resolve4(mx.exchange),
          resolver.resolve6(mx.exchange),
        ]);
        const addresses = lookups.flatMap((r) =>
          r.status === "fulfilled" ? r.value : [],
        );
        const targets = [...new Set(addresses)]
          .filter(
            (ip) =>
              isIP(ip) &&
              (dependencies.allowPrivateAddresses || isPublicIp(ip)),
          )
          .slice(0, 4);
        if (!targets.length) {
          lastError = deliveryError(
            `MX ${mx.exchange} 没有可用的公网地址`,
            addresses.length > 0,
          );
          continue;
        }
        for (const address of targets) {
          const remaining = deadline - Date.now();
          if (remaining <= 0)
            throw lastError || deliveryError("MX 投递超时，稍后重试");
          let socket;
          const timeout = setTimeout(
            () => socket?.destroy(deliveryError("MX 投递超时，稍后重试")),
            remaining,
          );
          timeout.unref?.();
          const transport = factory({
            host: address,
            port: dependencies.port || 25,
            name: config.mailHostname,
            secure: false,
            requireTLS: Boolean(config.directRequireTls),
            opportunisticTLS: false,
            tls: {
              servername: mx.exchange,
              rejectUnauthorized: true,
              minVersion: "TLSv1.2",
            },
            connectionTimeout: Math.min(10000, remaining),
            greetingTimeout: Math.min(15000, remaining),
            socketTimeout: Math.min(30000, remaining),
            disableFileAccess: true,
            disableUrlAccess: true,
            // Connect only to the address already validated above; never re-resolve an MX.
            getSocket(options, callback) {
              socket = connect({
                host: address,
                port: options.port,
                family: isIP(address),
              });
              const connectTimeout = setTimeout(
                () => socket.destroy(deliveryError("连接 MX 超时")),
                Math.min(10000, remaining),
              );
              connectTimeout.unref?.();
              const onError = (error) => {
                clearTimeout(connectTimeout);
                callback(error);
              };
              socket.once("error", onError);
              socket.once("connect", () => {
                clearTimeout(connectTimeout);
                socket.removeListener("error", onError);
                callback(null, { connection: socket });
              });
            },
          });
          try {
            return await transport.sendMail(message);
          } catch (error) {
            lastError = error;
            error.message = `MX ${mx.exchange} (${address}): ${error.message}`;
            // A final recipient/message rejection is not an invitation to bypass another MX's policy.
            // An uncertain DATA result is retried by the durable queue, not immediately at a second host.
            if (
              error.responseCode >= 500 ||
              (error.command === "DATA" && !error.responseCode)
            )
              throw error;
          } finally {
            clearTimeout(timeout);
            socket?.destroy();
            transport.close?.();
          }
        }
      }
      throw lastError || deliveryError(`无法连接 ${domain} 的 MX`);
    },
  };
}
