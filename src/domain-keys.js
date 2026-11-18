import {
  generateKeyPair,
  createPublicKey,
  createPrivateKey,
} from "node:crypto";
import { execFile } from "node:child_process";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { domainName } from "./security.js";
const generate = promisify(generateKeyPair);
const run = promisify(execFile);

export function dkimSelector(value) {
  if (
    typeof value !== "string" ||
    !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value)
  )
    throw new Error("RSPAMD_SELECTOR 必须为不超过 63 个字符的 DNS 标签");
  return value;
}

export function rspamdKeyPath(config, domain) {
  return path.join(
    path.resolve(config.rspamdKeyDir || "/var/lib/postoffice-dkim"),
    `${domainName(domain)}.${dkimSelector(config.rspamdSelector || "rspamd")}.key`,
  );
}

function keyFromPrivate(selector, privateKey) {
  const parsed = createPrivateKey(privateKey);
  if (
    parsed.asymmetricKeyType !== "rsa" ||
    parsed.asymmetricKeyDetails.modulusLength < 2048
  )
    throw new Error("Rspamd DKIM 密钥必须为至少 2048 位 RSA 私钥");
  return {
    selector,
    privateKey,
    publicKey: createPublicKey(parsed)
      .export({ type: "spki", format: "der" })
      .toString("base64"),
  };
}

async function readKey(filename, selector) {
  try {
    const info = await lstat(filename);
    if (!info.isFile() || info.size > 16384)
      throw new Error("Rspamd DKIM 密钥文件类型或大小无效");
    const key = keyFromPrivate(selector, await readFile(filename, "utf8"));
    await chmod(filename, 0o640);
    return key;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

// Hard linking publishes a complete file atomically and never replaces a key
// installed by another request. The setgid key directory preserves its group.
async function publishKey(filename, selector, create) {
  await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  const existing = await readKey(filename, selector);
  if (existing) return existing;
  const staging = await mkdtemp(path.join(path.dirname(filename), ".keygen-"));
  const temporary = path.join(staging, "private.key");
  try {
    await create(temporary);
    const generated = await readKey(temporary, selector);
    if (!generated) throw new Error("Rspamd 未生成 DKIM 密钥文件");
    try {
      await link(temporary, filename);
      return generated;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const winner = await readKey(filename, selector);
      if (!winner) throw new Error("Rspamd DKIM 密钥发布失败");
      return winner;
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

export async function generateDomainKey(
  config = {},
  domain,
  dependencies = {},
) {
  if (config.dkimBackend === "rspamd") {
    const name = domainName(domain);
    const selector = dkimSelector(config.rspamdSelector || "rspamd");
    return publishKey(
      rspamdKeyPath(config, name),
      selector,
      async (filename) => {
        try {
          await (dependencies.run || run)(
            config.rspamadmPath || "/usr/bin/rspamadm",
            [
              "dkim_keygen",
              "-b",
              "2048",
              "-s",
              selector,
              "-d",
              name,
              "-k",
              filename,
            ],
            {
              timeout: config.rspamdTimeoutMs || 10000,
              maxBuffer: 65536,
              windowsHide: true,
            },
          );
        } catch {
          // Never propagate CLI stdout/stderr: they may include private material.
          throw new Error(
            "Rspamd DKIM 密钥生成失败，请检查 rspamadm 与密钥目录权限",
          );
        }
      },
    );
  }
  const { privateKey, publicKey } = await generate("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  return {
    selector: "default",
    privateKey,
    publicKey: createPublicKey(publicKey)
      .export({ type: "spki", format: "der" })
      .toString("base64"),
  };
}
export function saveDomainKey(db, domainId, key) {
  db.prepare(
    "INSERT OR IGNORE INTO domain_keys(domain_id,selector,private_key,public_key) VALUES(?,?,?,?)",
  ).run(domainId, key.selector, key.privateKey, key.publicKey);
}
export async function ensureDomainKeys(db, config = {}, dependencies = {}) {
  const domains = db
    .prepare(
      "SELECT d.id,d.name,k.selector,k.private_key,k.public_key FROM domains d LEFT JOIN domain_keys k ON k.domain_id=d.id WHERE d.name<>''",
    )
    .all();
  for (const domain of domains) {
    if (config.dkimBackend === "rspamd") {
      const selector = dkimSelector(config.rspamdSelector || "rspamd");
      let key;
      if (domain.selector === selector) {
        const stored = keyFromPrivate(selector, domain.private_key);
        if (stored.publicKey !== domain.public_key)
          throw new Error(`域名 ${domain.name} 的 DKIM 公私钥不匹配`);
        key = await publishKey(
          rspamdKeyPath(config, domain.name),
          selector,
          (filename) =>
            writeFile(filename, stored.privateKey, { mode: 0o640, flag: "wx" }),
        );
        if (key.publicKey !== stored.publicKey)
          throw new Error(
            `域名 ${domain.name} 的 Rspamd 密钥文件与数据库不匹配`,
          );
      } else {
        key = await generateDomainKey(config, domain.name, dependencies);
        db.prepare(
          "INSERT INTO domain_keys(domain_id,selector,private_key,public_key) VALUES(?,?,?,?) ON CONFLICT(domain_id) DO UPDATE SET selector=excluded.selector,private_key=excluded.private_key,public_key=excluded.public_key",
        ).run(domain.id, key.selector, key.privateKey, key.publicKey);
      }
    } else if (!domain.selector) {
      saveDomainKey(
        db,
        domain.id,
        await generateDomainKey(config, domain.name),
      );
    }
  }
}
