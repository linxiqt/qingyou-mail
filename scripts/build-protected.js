import { createHash, randomBytes } from "node:crypto";
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
  if (args.length !== 2 || args[0] !== "--out" || !args[1] || args[1].startsWith("--"))
    throw new Error("Usage: --out NEW_DIRECTORY");
  return { out: args[1] };
}

export function validateOptions(values) {
  if (!values.out || Object.keys(values).some((name) => name !== "out"))
    throw new Error("Only --out NEW_DIRECTORY is supported");
  return values;
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
  pkg.description = "青邮 · 源码保护发行版";
  if (lock.lockfileVersion !== 3 || !lock.packages?.[""])
    throw new Error("A version 3 npm lockfile is required");
  lock.packages[""].description = pkg.description;
  delete lock.packages[""].devDependencies;
  for (const [name, metadata] of Object.entries(lock.packages))
    if (name && metadata.dev === true) delete lock.packages[name];
  return { pkg, lock };
}

const releaseGuide = () => "# 青邮源码保护发行版\n\n本版仅混淆代码，无需激活或连接授权站。使用条件见 [LICENSE](LICENSE)，部署步骤见 [README.md](README.md)。\n";

const smokeSource = `import test from 'node:test';
import assert from 'node:assert/strict';
import {access} from 'node:fs/promises';
import {edition} from '../src/edition.js';
test('protected release has no activation requirement and includes mail entry points', async()=>{
  assert.equal(edition.protected,true); assert.equal(edition.required,false);
  for(const name of ['public/index.html','public/webmail.html','src/server.js','src/code-rules-worker.js','compose.yaml']) await access(new URL('../'+name,import.meta.url));
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
  const buildId = `protected-${createdAt.slice(0, 10).replaceAll("-", "")}-${randomBytes(4).toString("hex")}`;
  const manifest = {
    schemaVersion: 2,
    kind: "postoffice-protected-release",
    buildId,
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
    const content = await sourceBytes(name);
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
            required: false,
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
    await put(relative, await sourceBytes(relative));
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
      files: manifest.files.length,
      note: "Ready for package-protected.py verification",
    }),
  );
  return manifest;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  if (process.argv.includes("--help"))
    console.log("node scripts/build-protected.js --out NEW_DIRECTORY");
  else
    buildProtected(parseArguments(process.argv.slice(2))).catch((error) => {
      console.error(`Protected build failed: ${error.message}`);
      process.exitCode = 1;
    });
}
