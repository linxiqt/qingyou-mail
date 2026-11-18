import { createHash, randomUUID, verify } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import path from "node:path";
import { edition } from "./edition.js";
import { AppError } from "./security.js";

const INTERVAL = 60000,
  TIMEOUT = 8000,
  DAY = 86400;
class Unavailable extends Error {}
const hash = (value) => createHash("sha256").update(value).digest("hex");
const publicKey = readFileSync(
  new URL("../deploy/keydock-offline-public.pem", import.meta.url),
);

export function createLicense(config) {
  const options = edition.required
    ? edition
    : { ...edition, ...config.license };
  const required = options.required === true;
  const product = options.product || "";
  const server = options.server;
  const directory = path.join(config.dataDir, "license");
  let device = "",
    key = "",
    ca,
    configured = false,
    timer,
    pending;
  let valid = false,
    mode = "blocked",
    reason = "程序尚未激活";
  let expiresAt = null,
    lastCheck = 0,
    lastAttempt = -Infinity;
  let credential = "",
    leaseDeadline = 0,
    verifiedAt = 0,
    nextVerifyAt = 0,
    boundIp = "";
  let offlineExpiry = null,
    offlineDeadline = 0,
    offlineDeadlineExpiry = 0,
    revoked = false,
    highwater = 0;
  let queue = Promise.resolve();
  const file = (name) => path.join(directory, name);
  const read = (name, fallback = "") => {
    try {
      return readFileSync(file(name), "utf8").trim();
    } catch (error) {
      if (error.code === "ENOENT") return fallback;
      throw error;
    }
  };
  const atomic = (name, value) => {
    const temporary = file(`${name}.${randomUUID()}.tmp`);
    try {
      writeFileSync(temporary, value, { mode: 0o600, flag: "wx" });
      renameSync(temporary, file(name));
    } finally {
      rmSync(temporary, { force: true });
    }
  };
  const enqueue = (operation) => {
    const result = queue.then(operation, operation);
    queue = result.catch(() => {});
    return result;
  };
  function status() {
    if (!required)
      return {
        required: false,
        valid: true,
        mode: "development",
        reason: null,
      };
    const expired = expiresAt !== null && expiresAt <= Date.now() / 1000;
    const fresh = performance.now() - lastAttempt < INTERVAL + 2 * TIMEOUT;
    const offlineExpired =
      mode === "offline" && performance.now() >= offlineDeadline;
    const allowed = valid && !expired && fresh && !offlineExpired;
    return {
      required,
      configured,
      activated: Boolean(key) || mode === "offline",
      valid: allowed,
      mode: allowed ? mode : "blocked",
      reason:
        expired || offlineExpired
          ? "程序授权已到期"
          : !fresh
            ? "正在重新校验程序授权"
            : reason,
      expiresAt,
      forever: allowed && mode === "online" && expiresAt === null,
      lastCheckAt: lastCheck ? new Date(lastCheck).toISOString() : null,
      nextCheckAt: lastCheck
        ? new Date(lastCheck + INTERVAL).toISOString()
        : null,
      offlineExpiresAt: offlineExpiry,
    };
  }
  const adminStatus = () => ({
    ...status(),
    productId: product,
    deviceId: device,
    server,
    keyHint: key ? `${key.slice(0, 7)}…${key.slice(-4)}` : null,
    boundIp: boundIp || null,
    lastVerifiedAt: verifiedAt
      ? new Date(verifiedAt * 1000).toISOString()
      : null,
    nextVerifyAt: nextVerifyAt
      ? new Date(nextVerifyAt * 1000).toISOString()
      : null,
  });
  function assertAllowed() {
    if (!status().valid)
      throw Object.assign(
        new AppError(
          "程序授权不可用，请由管理员登录续权；收件仍会保存",
          402,
          451,
        ),
        { code: "LICENSE_REQUIRED" },
      );
  }
  const block = (message) => {
    valid = false;
    mode = "blocked";
    reason = message;
  };
  function validate(result, full = false) {
    if (
      !result ||
      typeof result.valid !== "boolean" ||
      typeof result.code !== "string"
    )
      throw new Error("Invalid response");
    if (result.valid) {
      if (
        result.code !== "OK" ||
        result.product_id !== product ||
        !(
          result.expires_at === null ||
          (Number.isSafeInteger(result.expires_at) &&
            result.expires_at > Date.now() / 1000)
        ) ||
        ![result.server_time, result.verified_at, result.next_verify_at].every(
          Number.isSafeInteger,
        ) ||
        Math.abs(result.server_time - Date.now() / 1000) > 300 ||
        result.verified_at > result.server_time ||
        result.next_verify_at <= result.server_time ||
        result.next_verify_at - result.verified_at > 14 * DAY ||
        typeof result.observed_ip !== "string" ||
        !isIP(result.observed_ip) ||
        ((full || result.verification_token !== undefined) &&
          !/^[A-Za-z0-9_-]{43}$/.test(result.verification_token || ""))
      )
        throw new Error("Mismatched response");
    } else if (result.code === "OK" || !/^[A-Z_]{2,64}$/.test(result.code))
      throw new Error("Invalid rejection");
    return result;
  }
  function post(endpoint, payload) {
    return new Promise((resolve, reject) => {
      const url = new URL(server + endpoint),
        body = JSON.stringify(payload);
      const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(
        url,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(body),
          },
          ...(url.protocol === "https:"
            ? { ca, rejectUnauthorized: true }
            : {}),
        },
        (response) => {
          const chunks = [];
          let size = 0;
          response.on("data", (chunk) => {
            size += chunk.length;
            if (size > 65536) request.destroy(new Error("Response too large"));
            else chunks.push(chunk);
          });
          response.on("error", reject);
          response.on("end", () => {
            if (response.statusCode !== 200)
              return reject(
                response.statusCode >= 500
                  ? new Unavailable()
                  : new Error("Request rejected"),
              );
            try {
              resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
            } catch {
              reject(new Error("Invalid response"));
            }
          });
        },
      );
      const deadline = setTimeout(
        () => request.destroy(new Unavailable()),
        TIMEOUT,
      );
      request.on("close", () => clearTimeout(deadline));
      request.on("error", (error) =>
        reject(
          error instanceof Unavailable ||
            [
              "ECONNREFUSED",
              "ECONNRESET",
              "ENOTFOUND",
              "EAI_AGAIN",
              "ETIMEDOUT",
              "EHOSTUNREACH",
              "ENETUNREACH",
            ].includes(error.code)
            ? new Unavailable()
            : error,
        ),
      );
      request.end(body);
    });
  }
  const verifyRemote = async (candidate) =>
    validate(
      await post("/api/v1/verify", {
        product_id: product,
        license_key: candidate,
        device_id: device,
      }),
      true,
    );
  function applyOnline(result, full = true) {
    lastCheck = Date.now();
    if (!result.valid) {
      credential = "";
      revoked = true;
      atomic("denied", result.code);
      block("授权站拒绝此授权，请恢复授权或更换授权码");
      return;
    }
    if (result.verification_token) credential = result.verification_token;
    verifiedAt = result.verified_at;
    nextVerifyAt = result.next_verify_at;
    boundIp = result.observed_ip;
    const deadline =
      performance.now() + (result.next_verify_at - result.server_time) * 1000;
    leaseDeadline = full ? deadline : Math.min(leaseDeadline, deadline);
    valid = true;
    mode = "online";
    reason = null;
    expiresAt = result.expires_at;
    revoked = false;
    rmSync(file("denied"), { force: true });
    highwater = Number.isFinite(highwater)
      ? Math.max(highwater, Date.now() / 1000, result.server_time)
      : result.server_time;
    atomic("clock", String(highwater));
  }
  function readOffline(raw) {
    if (typeof raw !== "string" || Buffer.byteLength(raw) > 16384)
      throw new Error("离线文件格式或大小无效");
    let envelope, grant;
    try {
      envelope = JSON.parse(raw);
    } catch {
      throw new Error("离线文件不是有效 JSON");
    }
    if (
      !envelope ||
      !/^[A-Za-z0-9_-]+$/.test(envelope.payload || "") ||
      !/^[A-Za-z0-9_-]{86}$/.test(envelope.signature || "")
    )
      throw new Error("离线文件格式错误");
    const payload = Buffer.from(envelope.payload, "base64url"),
      signature = Buffer.from(envelope.signature, "base64url");
    if (
      signature.length !== 64 ||
      !verify(null, payload, options.publicKey || publicKey, signature)
    )
      throw new Error("离线授权签名无效");
    try {
      grant = JSON.parse(payload.toString("utf8"));
    } catch {
      throw new Error("离线授权内容无效");
    }
    const current = Date.now() / 1000;
    const maximum =
      grant.grant_type === "admin"
        ? 365
        : grant.grant_type === "self_service"
          ? 14
          : 0;
    if (
      grant.version !== 1 ||
      grant.kind !== "keydock-offline-license" ||
      grant.product_id !== product ||
      grant.device_hash !== hash(device) ||
      typeof grant.license_id !== "string" ||
      !grant.license_id ||
      typeof grant.jti !== "string" ||
      !grant.jti ||
      !maximum
    )
      throw new Error("离线授权与程序或设备不匹配");
    if (
      ![grant.issued_at, grant.not_before, grant.expires_at].every(
        Number.isSafeInteger,
      ) ||
      grant.not_before < grant.issued_at - 300 ||
      grant.not_before >= grant.expires_at ||
      grant.issued_at > current + 300 ||
      grant.not_before > current ||
      grant.expires_at <= current ||
      grant.expires_at - grant.issued_at > maximum * DAY ||
      grant.expires_at <= grant.issued_at
    )
      throw new Error("离线授权未生效、已到期或期限不符合规则");
    if (current + 300 < highwater)
      throw new Error("检测到系统时钟回退，请校准时间");
    return grant;
  }
  function useOffline() {
    if (revoked) return false;
    try {
      const grant = readOffline(read("offline.json"));
      highwater = Math.max(highwater, Date.now() / 1000);
      atomic("clock", String(highwater));
      offlineExpiry = grant.expires_at;
      const deadline =
        performance.now() + (grant.expires_at - Date.now() / 1000) * 1000;
      offlineDeadline = offlineDeadline
        ? Math.min(
            offlineDeadline + (grant.expires_at - offlineDeadlineExpiry) * 1000,
            deadline,
          )
        : deadline;
      offlineDeadlineExpiry = grant.expires_at;
      valid = true;
      mode = "offline";
      reason = null;
      expiresAt = grant.expires_at;
      lastCheck = Date.now();
      return status().valid;
    } catch {
      return false;
    }
  }
  async function check(force) {
    lastAttempt = performance.now();
    if (!configured) {
      block("授权连接配置未完成");
      return false;
    }
    if (!key) {
      if (useOffline()) return true;
      block("程序尚未激活，请输入授权码或导入离线文件");
      return false;
    }
    try {
      let result;
      let full = force || !credential || performance.now() >= leaseDeadline;
      if (full) result = await verifyRemote(key);
      else {
        result = validate(
          await post("/api/v1/heartbeat", {
            product_id: product,
            device_id: device,
            verification_token: credential,
          }),
        );
        if (
          result.valid &&
          (result.verified_at !== verifiedAt ||
            result.next_verify_at !== nextVerifyAt ||
            result.observed_ip !== boundIp)
        )
          throw new Error("Heartbeat changed verification binding");
        if (
          !result.valid &&
          [
            "IP_CHANGED",
            "REVERIFY_REQUIRED",
            "SESSION_INVALID",
            "DEVICE_RESET",
          ].includes(result.code)
        ) {
          result = await verifyRemote(key);
          full = true;
        }
      }
      applyOnline(result, full);
    } catch (error) {
      if (error instanceof Unavailable && useOffline()) return true;
      block(
        error instanceof Unavailable
          ? "授权站暂时不可连接，请导入有效离线文件"
          : "授权响应未通过安全检查",
      );
    }
    return status().valid;
  }
  const beginCheck = (force) => {
    if (pending) return pending;
    pending = enqueue(() => check(force)).finally(() => {
      pending = null;
    });
    return pending;
  };
  const ensureValid = (force = false) => {
    if (!required) return Promise.resolve(true);
    if (pending) return pending;
    if (!force && performance.now() - lastAttempt < INTERVAL)
      return Promise.resolve(status().valid);
    return beginCheck(force);
  };
  return {
    status,
    adminStatus,
    assertAllowed,
    ensureValid,
    async init() {
      if (!required) return;
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      try {
        writeFileSync(file("installation.id"), randomUUID(), {
          flag: "wx",
          mode: 0o600,
        });
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
      }
      const id = read("installation.id");
      if (!/^[0-9a-f-]{36}$/.test(id))
        throw new Error("授权安装 ID 无效，请从备份恢复");
      device = hash(id);
      key = read("license.key", process.env.LICENSE_KEY?.trim() || "");
      revoked = Boolean(read("denied"));
      highwater = Number(read("clock", "0"));
      if (!Number.isFinite(highwater)) highwater = Infinity;
      try {
        const url = new URL(server);
        if (
          url.username ||
          url.password ||
          url.search ||
          url.hash ||
          url.pathname !== "/" ||
          !(
            url.protocol === "https:" ||
            (url.protocol === "http:" &&
              ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
          ) ||
          !/^app_[A-Za-z0-9_-]{1,76}$/.test(product)
        )
          throw new Error("Invalid license origin or product");
        if (process.env.LICENSE_CA_FILE)
          ca = readFileSync(process.env.LICENSE_CA_FILE);
        configured = true;
      } catch {
        configured = false;
      }
      await ensureValid(true);
      timer = setInterval(() => {
        void beginCheck(false).catch(() =>
          block("授权状态保存失败，请检查数据目录权限"),
        );
      }, INTERVAL);
      timer.unref();
    },
    activate(candidate) {
      return enqueue(async () => {
        if (!required || !configured) throw new AppError("授权连接未配置");
        if (
          typeof candidate !== "string" ||
          !candidate.trim() ||
          candidate.length > 128
        )
          throw new AppError("授权码格式无效");
        candidate = candidate.trim().toUpperCase();
        let result;
        try {
          result = await verifyRemote(candidate);
        } catch {
          throw new AppError("无法安全连接授权站，请检查网络和证书", 502);
        }
        if (!result.valid) {
          if (candidate === key) applyOnline(result);
          throw new AppError("授权码无效、已到期、停用或设备数量超限");
        }
        atomic("license.key", candidate);
        key = candidate;
        lastAttempt = performance.now();
        applyOnline(result);
        return adminStatus();
      });
    },
    importOffline(raw) {
      return enqueue(async () => {
        if (!required || !configured) throw new AppError("授权连接未配置");
        let grant;
        try {
          grant = readOffline(raw);
        } catch (error) {
          throw new AppError(error.message);
        }
        if (revoked)
          throw new AppError("已有明确在线拒绝记录，请先恢复在线授权");
        atomic("offline.json", raw);
        offlineExpiry = grant.expires_at;
        await check(true);
        return adminStatus();
      });
    },
    async close() {
      clearInterval(timer);
      await queue;
    },
  };
}
