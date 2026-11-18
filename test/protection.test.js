import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import vm from "node:vm";
import { Worker } from "node:worker_threads";
import JavaScriptObfuscator from "javascript-obfuscator";
import {
  buildProtected,
  parseArguments,
  protectionOptions,
  runtimeMetadata,
} from "../scripts/build-protected.js";

const protect = (source, name) =>
  JavaScriptObfuscator.obfuscate(
    source,
    protectionOptions(name, 121),
  ).getObfuscatedCode();

test("builds need only an output directory and reject legacy product bindings", () => {
  assert.deepEqual(parseArguments(["--out", "release"]), { out: "release" });
  assert.throws(() => parseArguments(["--out", "release", "--product", "old"]));
});

test("runtime metadata excludes developer tooling but retains the npm production graph", async () => {
  const pkg = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url)),
  );
  const lock = JSON.parse(
    await readFile(new URL("../package-lock.json", import.meta.url)),
  );
  const result = runtimeMetadata(pkg, lock);
  assert.equal(result.pkg.devDependencies, undefined);
  assert.equal(result.pkg.scripts["build:protected"], undefined);
  assert.equal(result.pkg.scripts.test, "node --test test/release-smoke.js");
  assert.deepEqual(result.pkg.dependencies, pkg.dependencies);
  assert.equal(result.lock.packages[""].devDependencies, undefined);
  assert.equal(
    result.lock.packages["node_modules/javascript-obfuscator"],
    undefined,
  );
  for (const [name, metadata] of Object.entries(lock.packages))
    if (!metadata.dev)
      assert.deepEqual(
        result.lock.packages[name].dependencies,
        metadata.dependencies,
      );
  assert.ok(
    pkg.devDependencies["javascript-obfuscator"],
    "source metadata is not mutated",
  );
});

test("CSP-safe browser protection preserves communication across separately loaded scripts", () => {
  const files = ["public/first.js", "public/second.js"];
  assert.notEqual(
    protectionOptions(files[0]).identifiersPrefix,
    protectionOptions(files[1]).identifiersPrefix,
  );
  const context = vm.createContext(
    {
      console,
      atob: (value) => Buffer.from(value, "base64").toString("binary"),
      btoa: (value) => Buffer.from(value, "binary").toString("base64"),
    },
    { codeGeneration: { strings: false, wasm: false } },
  );
  vm.runInContext(
    protect(
      "globalThis.MailWorkspace={read(value){return 'mailbox:'+value}};",
      files[0],
    ),
    context,
  );
  vm.runInContext(
    protect(
      "globalThis.result=globalThis.MailWorkspace.read('alice@example.com');",
      files[1],
    ),
    context,
  );
  assert.equal(context.result, "mailbox:alice@example.com");
  for (const file of files) {
    const options = protectionOptions(file);
    assert.equal(options.target, "browser-no-eval");
    assert.equal(options.debugProtection, false);
    assert.equal(options.disableConsoleOutput, false);
    assert.equal(options.renameGlobals, false);
  }
});

test("protection preserves ESM exports, dynamic imports and module Workers", async (t) => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "postoffice-protection-"),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(path.join(directory, "package.json"), '{"type":"module"}');
  await writeFile(
    path.join(directory, "dependency.js"),
    protect("export const value='mail-runtime';", "src/dependency.js"),
  );
  await writeFile(
    path.join(directory, "main.js"),
    protect(
      "export async function load(){return (await import('./dependency.js')).value;}",
      "src/main.js",
    ),
  );
  await writeFile(
    path.join(directory, "worker.js"),
    protect(
      "import{parentPort}from'node:worker_threads';import{value}from'./dependency.js';parentPort.postMessage(value);",
      "src/worker.js",
    ),
  );
  const imported = await import(pathToFileURL(path.join(directory, "main.js")));
  assert.equal(await imported.load(), "mail-runtime");
  const worker = new Worker(pathToFileURL(path.join(directory, "worker.js")));
  t.after(() => worker.terminate());
  assert.deepEqual(await once(worker, "message"), ["mail-runtime"]);
});

test("builder never reuses an existing output directory or writes inside source folders", async (t) => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "postoffice-protection-refuse-"),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  await assert.rejects(
    buildProtected({ out: directory }),
    /EEXIST/,
  );
  const source = fileURLToPath(new URL("..", import.meta.url));
  await assert.rejects(
    buildProtected({
      out: path.join(source, "src", "protected-unsafe"),
    }),
    /source or runtime/,
  );
});
