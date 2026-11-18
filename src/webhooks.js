import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import https from "node:https";
import http from "node:http";
import { createHmac } from "node:crypto";
import { AppError } from "./security.js";

const blocked = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
])
  blocked.addSubnet(address, prefix, "ipv4");
for (const [address, prefix] of [
  ["::", 128],
  ["::", 96],
  ["::1", 128],
  ["64:ff9b::", 96],
  ["100::", 64],
  ["2001::", 32],
  ["2002::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
])
  blocked.addSubnet(address, prefix, "ipv6");

export function isPublicIp(address) {
  const family = isIP(address);
  return (
    Boolean(family) && !blocked.check(address, family === 6 ? "ipv6" : "ipv4")
  );
}

export async function webhookTarget(value, allowPrivate) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new AppError("Webhook URL 无效");
  }
  if (
    url.username ||
    url.password ||
    url.hash ||
    (!allowPrivate && url.protocol !== "https:") ||
    !["https:", "http:"].includes(url.protocol)
  )
    throw new AppError("Webhook 必须为无用户名和密码的公共 HTTPS 地址");
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(hostname)
    ? [{ address: hostname, family: isIP(hostname) }]
    : await lookup(hostname, { all: true });
  if (
    !addresses.length ||
    (!allowPrivate && addresses.some((a) => !isPublicIp(a.address)))
  )
    throw new AppError("Webhook 不允许访问本地或私有网络");
  return { url, address: addresses[0] };
}

export async function postWebhook(hook, payload, allowPrivate) {
  // Revalidate DNS for every delivery, and pin the validated address to avoid rebinding.
  const { url, address } = await webhookTarget(hook.url, allowPrivate);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac("sha256", hook.secret)
    .update(`${timestamp}.${payload}`)
    .digest("hex");
  await new Promise((resolve, reject) => {
    const client = url.protocol === "https:" ? https : http;
    const request = client.request(
      url,
      {
        method: "POST",
        timeout: 10000,
        lookup: (_hostname, options, callback) =>
          options.all
            ? callback(null, [address])
            : callback(null, address.address, address.family),
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
          "X-PostOffice-Timestamp": timestamp,
          "X-PostOffice-Signature": `sha256=${signature}`,
        },
      },
      (response) => {
        response.resume();
        if (response.statusCode >= 200 && response.statusCode < 300) resolve();
        else reject(new Error(`Webhook HTTP ${response.statusCode}`));
      },
    );
    request.on("timeout", () => request.destroy(new Error("Webhook timeout")));
    request.on("error", reject);
    request.end(payload);
  });
}
