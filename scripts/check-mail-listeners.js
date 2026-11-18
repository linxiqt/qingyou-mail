import { connect, isIP } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { X509Certificate } from "node:crypto";
import { readFile } from "node:fs/promises";
import { parseEnv } from "node:util";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { loadConfig } from "../src/config.js";

export async function verifyMailListeners(config) {
  const host =
    { "0.0.0.0": "127.0.0.1", "::": "::1" }[config.smtpHost] || config.smtpHost;
  const fingerprint =
    config.tls.cert && new X509Certificate(config.tls.cert).fingerprint256;
  const endpoints = [
    ["SMTP", config.smtpPort, false, /^220[ -]/],
    ["Submission", config.submissionPort, false, /^220[ -]/],
    ["IMAP", config.imapPort, false, /^\* OK\b/i],
    ["SMTPS", config.smtpsPort, true, /^220[ -]/],
    ["IMAPS", config.imapsPort, true, /^\* OK\b/i],
    ["POP3S", config.pop3sPort, true, /^\+OK\b/],
  ].filter((endpoint) => endpoint[1]);
  await Promise.all(
    endpoints.map(
      ([protocol, port, secure, banner]) =>
        new Promise((resolve, reject) => {
          const socket = secure
            ? tlsConnect({
                host,
                port,
                ca: config.tls.cert,
                minVersion: "TLSv1.2",
                allowPartialTrustChain: true,
                ...(config.mailHostname && !isIP(config.mailHostname)
                  ? { servername: config.mailHostname }
                  : {}),
                checkServerIdentity(_host, peer) {
                  if (peer.fingerprint256 !== fingerprint)
                    return new Error("Unexpected listener certificate");
                },
              })
            : connect({ host, port });
          let line = "";
          function finish(error) {
            socket.destroy();
            if (error)
              reject(
                new Error(
                  protocol + " " + port + " 自检失败 (" + error.message + ")",
                ),
              );
            else resolve();
          }
          socket.setTimeout(5000, () => finish(new Error("timeout")));
          socket.once("error", finish);
          socket.once("end", () => finish(new Error("closed before greeting")));
          socket.on("data", (bytes) => {
            line += bytes.toString("utf8");
            if (line.length > 8192 || line.includes("\n"))
              finish(
                banner.test(line) ? null : new Error("unexpected greeting"),
              );
          });
        }),
    ),
  );
  return endpoints.map(([protocol, port]) => protocol + " " + port).join(" / ");
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    console.log(
      await verifyMailListeners(
        loadConfig(parseEnv(await readFile(".env", "utf8"))),
      ),
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
