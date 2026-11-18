import { createHash, createPublicKey, randomBytes } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  realpath,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import JavaScriptObfuscator from "javascript-obfuscator";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const productionServer = "https://authorize.lxya.cc";
const rootFiles = [
  "LICENSE",
  ".env.example",
  ".dockerignore",
  "Dockerfile",
  "compose.yaml",
];
const scriptFiles = [
  "backup.js",
  "check.js",
  "check-mail-listeners.js",
];
const deployFiles = [
  "nginx.conf",
  "postoffice.service",
  "node-version.txt",
  "node-sha256.txt",
  "keydock-offline-public.pem",
  "rspamd/dkim_signing.conf",
  "rspamd/postoffice-rspamd.conf",
  "rspamd/worker-controller.inc",
  "rspamd/worker-normal.inc",
  "rspamd/worker-proxy.inc",
];
const digest = (value) => createHash("sha256").update(value).digest("hex");

export function protectionOptions(filename, seed = 1) {
  return {
    target: filename.startsWith("public/") ? "browser-no-eval" : "node",
    compact: true,
    controlFlowFlattening: false,
    deadCodeInjection: false,
    debugProtection: false,
    debugProtectionInterval: 0,
    disableConsoleOutput: false,
    domainLock: [],
    identifierNamesGenerator: "hexadecimal",
    identifiersPrefix: `q${digest(filename).slice(0, 10)}_`,
    ignoreImports: true,
    log: false,
    numbersToExpressions: false,
    renameGlobals: false,
    renameProperties: false,
    selfDefending: false,
    simplify: false,
    sourceMap: false,
    splitStrings: false,
    stringArray: true,
    stringArrayCallsTransform: false,
    stringArrayEncoding: ["rc4", "base64"],
    stringArrayIndexShift: true,
    stringArrayRotate: true,
    stringArrayShuffle: true,
    stringArrayThreshold: 0.85,
    stringArrayWrappersCount: 1,
    stringArrayWrappersChainedCalls: false,
    stringArrayWrappersType: "variable",
    transformObjectKeys: false,
    unicodeEscapeSequence: false,
    seed,
  };
}

export function parseArguments(args) {
  const values = { qa: false };
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === "--qa") {
      if (values.qa) throw new Error("Duplicate --qa");
      values.qa = true;
    } else if (
      ["--out", "--product", "--qa-server", "--qa-public-key"].includes(
        argument,
      )
    ) {
      const key = argument.slice(2);
      if (values[key] || !args[index + 1] || args[index + 1].startsWith("--"))
        throw new Error(`Missing or duplicate value: ${argument}`);
      values[key] = args[++index];
    } else throw new Error(`Unknown argument: ${argument}`);
  }
  return validateOptions(values);
}

export function validateOptions(values) {
  if (!values.out)
    throw new Error("--out must name a new, isolated build directory");
  if (values.qa) {
    if (values.product && values.product !== "app_postoffice_qa")
      throw new Error("QA product is fixed to app_postoffice_qa");
    let url;
    try {
      url = new URL(values["qa-server"]);
    } catch {
      throw new Error("--qa-server must be an explicit local test URL");
    }
    if (
      !["http:", "https:"].includes(url.protocol) ||
      !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    )
      throw new Error(
        "QA license server must be a loopback origin without a path",
      );
    if (!values["qa-public-key"])
      throw new Error("--qa-public-key is required for QA builds");
    return { ...values, product: "app_postoffice_qa", server: url.origin };
  }
  if (values["qa-server"] || values["qa-public-key"])
    throw new Error("QA options require --qa");
  if (
    !/^app_[A-Za-z0-9_-]{1,76}$/.test(values.product || "") ||
    values.product === "app_postoffice_qa"
  )
    throw new Error(
      "Provide the real KeyDock --product app_...; QA IDs cannot be released",
    );
  return { ...values, server: productionServer };
}

export function runtimeMetadata(packageSource, lockSource) {
  const pkg = structuredClone(packageSource),
    lock = structuredClone(lockSource);
  delete pkg.devDependencies;
  pkg.scripts = {
    start: "node --env-file-if-exists=.env src/server.js",
    test: "node --test test/release-smoke.js",
    check: "node scripts/check.js",
    backup: "node --env-file-if-exists=.env scripts/backup.js",
  };
  pkg.description = "青邮 · KeyDock 授权源码保护发行版";
  if (lock.lockfileVersion !== 3 || !lock.packages?.[""])
    throw new Error("A version 3 npm lockfile is required");
  lock.packages[""].description = pkg.description;
  delete lock.packages[""].devDependencies;
  for (const [name, metadata] of Object.entries(lock.packages))
    if (name && metadata.dev === true) delete lock.packages[name];
  return { pkg, lock };
}

const releaseGuide = (options) =>
  `# 青邮源码保护${options.qa ? " QA 测试" : "授权"}发行版\n\n` +
  `程序 ID：\`${options.product}\`。授权服务器：\`${options.server}\`。\n\n` +
  (options.qa
    ? "**仅供本地验收。此目录和其中的测试公钥不能作为正式安装包发布。**\n\n"
    : "首次安装后用浏览器创建管理员，再到「系统设置 → 程序授权」输入本产品有效授权码。\n\n") +
  "普通用户入口：网页地址后加 `/webmail/`，使用完整邮箱地址和邮箱密码。管理员入口为 `/`，登录后添加邮件域名、SMTP 主机名，再复制并验证 DNS。\n\n" +
  "管理权限：在「用户列表 → 权限管理」配置管理员和客户端域名用户、自定义功能权限及域名读/建/改/删范围。客户端与后台独立登录，只有超级管理员可分配权限，变更撤销目标旧会话。\n\n" +
  "「邮件转发」支持 Catch-all（*@域名），只接收未创建地址的来信并转发到本地或外部邮箱，已创建邮箱仍按自己的规则收件。运行状态、平台设置、功能管理、程序信息与授权合并到「系统设置」；多邮局管理暂时停用，已保存连接配置保留。\n\n" +
  "「域名与容量」设置邮箱账号数量上限（不限 / 0禁止新增 / 指定数量）；管理员、停用及临时邮箱均计入，独立管理账号不占邮件域名名额。删除释放名额，降低上限不能低于已用数量；所有创建入口及并发写入统一约束。该限制是邮箱数量，单邮箱空间仍按MB配额管理。\n\n" +
  "用户列表支持服务端分页、搜索防抖与当前页导出；升级自动保留数据并迁移字段，原域名默认为不限。升级前完整备份，回退需同时恢复升级前数据库。\n\n" +
  "已有部署请先备份数据库、`.env`、证书、DKIM 私钥和授权资料。禁止把 QA 目录覆盖到正式服务器。\n\n" +
  "本版对 JavaScript 进行了本地离线混淆及字符串编码，无需解密口令。这些措施增加源码分析成本，不能保证无法逆向；HTML、CSS、配置模板仍为可读文件。\n\n" +
  "授权由服务端固定绑定产品 ID；环境变量不能关闭正式发行版授权或改用其他产品。不得把授权码、密钥、实际 `.env` 或客户数据加入发行包。\n\n" +
  "验收：安装运行依赖后执行 `npm test`（仅发行冒烟）及 `npm run check`。按实际端口手动配置主机防火墙；云安全组仍须在服务商控制台开放。\n";

const smokeSource = `import test from 'node:test';
import assert from 'node:assert/strict';
import {access} from 'node:fs/promises';
import {edition} from '../src/edition.js';
test('protected release has fixed licensing and mail entry points', async()=>{
  assert.equal(edition.protected,true); assert.equal(edition.required,true);
  assert.match(edition.product,/^app_/);
  if(!edition.qa) assert.equal(edition.server,'https://authorize.lxya.cc');
  for(const name of ['public/index.html','public/webmail.html','src/server.js','src/code-rules-worker.js','deploy/keydock-offline-public.pem','compose.yaml']) await access(new URL('../'+name,import.meta.url));
});
`;

async function listFiles(directory, prefix) {
  const result = [];
  for (const item of await readdir(directory, { withFileTypes: true })) {
    if (item.isSymbolicLink())
      throw new Error(`Refusing symlink: ${prefix}/${item.name}`);
    const name = `${prefix}/${item.name}`;
    if (item.isDirectory())
      result.push(...(await listFiles(path.join(directory, item.name), name)));
    else if (item.isFile()) result.push(name);
    else throw new Error(`Unexpected file type: ${name}`);
  }
  return result.sort();
}

export async function buildProtected(rawOptions, sourceRoot = root) {
  const options = validateOptions(rawOptions);
  const source = await realpath(sourceRoot),
    output = path.resolve(options.out);
  const sourceRelative = path.relative(output, source);
  if (
    !sourceRelative ||
    (!sourceRelative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(sourceRelative))
  )
    throw new Error("Build output cannot contain or replace the source tree");
  const childDirectory = path.relative(source, output).split(path.sep)[0];
  if (
    [
      "src",
      "public",
      "scripts",
      "deploy",
      "test",
      "data",
      "backups",
      "node_modules",
      "certs",
      ".git",
    ].includes(childDirectory)
  )
    throw new Error(
      "Build output must not be inside a source or runtime data directory",
    );
  const outputParent = await realpath(path.dirname(output));
  if (path.join(outputParent, path.basename(output)) !== output)
    throw new Error(
      "Build output must use a canonical parent without symlinks",
    );
  // Non-recursive mkdir deliberately refuses to reuse even an empty directory.
  await mkdir(output);
  const createdAt = new Date().toISOString();
  const buildId = `${options.qa ? "qa" : "protected"}-${createdAt.slice(0, 10).replaceAll("-", "")}-${randomBytes(4).toString("hex")}`;
  const manifest = {
    schemaVersion: 1,
    kind: "postoffice-protected-release",
    buildId,
    qa: Boolean(options.qa),
    productId: options.product,
    licenseServer: options.server,
    createdAt,
    obfuscator: "javascript-obfuscator@5.9.0",
    profile: "csp-safe-rc4-base64-v1",
    files: [],
  };
  const seed = randomBytes(4).readUInt32BE() || 1;
  const put = async (name, input, protect = false) => {
    let content = Buffer.isBuffer(input) ? input : Buffer.from(input);
    if (name.endsWith(".sh"))
      content = Buffer.from(content.toString("utf8").replace(/\r\n/g, "\n"));
    if (protect) {
      const sourceText = content.toString("utf8").replace(/^\uFEFF/, "");
      content = Buffer.from(
        JavaScriptObfuscator.obfuscate(
          sourceText,
          protectionOptions(name, seed),
        ).getObfuscatedCode() + "\n",
      );
    }
    if (
      name.endsWith(".ps1") &&
      !content.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))
    )
      content = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), content]);
    const destination = path.join(output, ...name.split("/"));
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, content, {
      flag: "wx",
      mode: name.endsWith(".sh") ? 0o755 : 0o644,
    });
    manifest.files.push({
      path: name,
      bytes: content.length,
      sha256: digest(content),
      role: protect ? "obfuscated-js" : "runtime-asset",
    });
    if (protect) console.log(`Protected ${name}`);
  };
  const sourceBytes = async (name) => {
    const absolute = path.join(source, ...name.split("/"));
    if (
      (await realpath(absolute)) !== absolute ||
      !(await stat(absolute)).isFile()
    )
      throw new Error(`Refusing non-regular source: ${name}`);
    return readFile(absolute);
  };
  const { pkg, lock } = runtimeMetadata(
    JSON.parse(await sourceBytes("package.json")),
    JSON.parse(await sourceBytes("package-lock.json")),
  );
  await put("package.json", JSON.stringify(pkg, null, 2) + "\n");
  await put("package-lock.json", JSON.stringify(lock, null, 2) + "\n");
  for (const name of rootFiles) {
    let content = await sourceBytes(name);
    if (name === "Dockerfile") {
      const text = content.toString("utf8");
      content = Buffer.from(
        text.includes("COPY --chown=node:node deploy ./deploy") ||
          text.includes("deploy/keydock-offline-public.pem")
          ? text
          : text.replace(
              "COPY --chown=node:node scripts ./scripts",
              "COPY --chown=node:node scripts ./scripts\nCOPY --chown=node:node deploy/keydock-offline-public.pem ./deploy/keydock-offline-public.pem",
            ),
      );
    }
    await put(name, content);
  }
  for (const prefix of ["src", "public"])
    for (const name of await listFiles(path.join(source, prefix), prefix)) {
      if (name.endsWith(".map")) continue;
      if (!/\.(js|html|css|svg|png|jpg|jpeg|webp|ico|woff2?)$/i.test(name))
        throw new Error(
          `Review unexpected runtime asset before including: ${name}`,
        );
      let content = await sourceBytes(name);
      if (name === "src/edition.js")
        content = Buffer.from(
          `export const edition=Object.freeze(${JSON.stringify({
            protected: true,
            required: true,
            product: options.product,
            server: options.server,
            ...(options.qa ? { qa: true } : {}),
          })});\n`,
        );
      if (name.endsWith(".html"))
        content = Buffer.from(
          content
            .toString("utf8")
            .replace(
              /(<script\s+[^>]*src=["'])(\/[^"'?]+\.js)(?:\?[^"']*)?(["'])/g,
              `$1$2?v=${buildId}$3`,
            )
            .replace(
              /(<link\s+[^>]*href=["'])(\/[^"'?]+\.css)(?:\?[^"']*)?(["'])/g,
              `$1$2?v=${buildId}$3`,
            ),
        );
      await put(name, content, name.endsWith(".js"));
    }
  for (const name of scriptFiles)
    await put(
      `scripts/${name}`,
      await sourceBytes(`scripts/${name}`),
      name.endsWith(".js"),
    );
  for (const name of deployFiles) {
    const relative = `deploy/${name}`;
    let content = await sourceBytes(relative);
    if (name === "keydock-offline-public.pem") {
      if (options.qa)
        content = await readFile(path.resolve(options["qa-public-key"]));
      if (/PRIVATE KEY/.test(content.toString("utf8")))
        throw new Error(
          "Only a public KeyDock verification key may be included",
        );
      const key = createPublicKey(content);
      if (key.asymmetricKeyType !== "ed25519")
        throw new Error("KeyDock verification key must be Ed25519");
      content = Buffer.from(key.export({ type: "spki", format: "pem" }));
    }
    await put(relative, content);
  }
  await put("test/release-smoke.js", smokeSource, true);
  for (const name of [
    "docs/api/README.md",
    "docs/api/openapi.json",
    "docs/api/openapi-mail.json",
    "docs/api/examples/qingyou-tools.mjs",
    "docs/api/examples/requests.http",
  ])
    await put(name, await sourceBytes(name));
  await put(
    "test/README.md",
    "发行包只含运行冒烟检查，不包含维护源码、业务测试或构建工具。执行 npm test。\n",
  );
  const guide =
    releaseGuide(options) +
    "\n外部 AI 调用邮局请参阅 [服务端 API 文档](docs/api/README.md)，包含 OpenAPI 定义与 Node.js 工具调用示例。\n";
  for (const name of [
    "DEPLOYMENT.md",
    "FEATURE-PARITY.md",
    "PROTECTED-RELEASE.md",
  ])
    await put(name, guide);
  await put("README.md", await sourceBytes("README.md"));
  manifest.files.sort((a, b) => a.path.localeCompare(b.path));
  await writeFile(
    path.join(output, "release-manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
    { flag: "wx" },
  );
  console.log(
    JSON.stringify({
      output,
      buildId,
      qa: manifest.qa,
      files: manifest.files.length,
      productId: options.product,
      note: options.qa
        ? "QA ONLY; official packager will reject this directory"
        : "Ready for package-protected.py verification",
    }),
  );
  return manifest;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  if (process.argv.includes("--help"))
    console.log(
      "Formal: node scripts/build-protected.js --out NEW_DIRECTORY --product REAL_app_ID\n" +
        "QA: node scripts/build-protected.js --out NEW_DIRECTORY --qa --qa-server http://127.0.0.1:PORT --qa-public-key TEST_PUBLIC_KEY.pem\n" +
        "Build is local/offline, source files are unchanged. QA output cannot be formally packaged.",
    );
  else
    buildProtected(parseArguments(process.argv.slice(2))).catch((error) => {
      console.error(`Protected build failed: ${error.message}`);
      process.exitCode = 1;
    });
}
