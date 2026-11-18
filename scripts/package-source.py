"""Build a source installer ZIP from an explicit runtime allowlist, without live data."""
import argparse
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import re
import zipfile


ROOT_FILES = {
    ".env.example", ".dockerignore", "Dockerfile", "compose.yaml", "package.json", "package-lock.json",
    "README.md", "FEATURE-PARITY.md", "LICENSE",
}
SCRIPT_FILES = {"backup.js", "check.js", "check-mail-listeners.js"}
DEPLOY_FILES = {
    "nginx.conf", "postoffice.service", "node-version.txt", "node-sha256.txt",
    "rspamd/dkim_signing.conf",
    "rspamd/postoffice-rspamd.conf", "rspamd/worker-controller.inc",
    "rspamd/worker-normal.inc", "rspamd/worker-proxy.inc",
}
GENERATED_FILES = {
    "DEPLOYMENT.md", "PROTECTED-RELEASE.md", "test/README.md",
    "test/release-smoke.js", "release-manifest.json",
}
FORBIDDEN = {
    ".env", "data", "backups", "certs", ".runtime", "node_modules",
    "test-results", ".git", ".agents", ".codex", ".aws", "__pycache__",
}
ASSET_SUFFIXES = {".js", ".html", ".css", ".svg", ".png", ".jpg", ".jpeg", ".webp", ".ico", ".woff", ".woff2"}
API_DOC_FILES = {"docs/api/README.md", "docs/api/openapi.json", "docs/api/openapi-mail.json",
                 "docs/api/examples/qingyou-tools.mjs", "docs/api/examples/requests.http"}
PRIVATE_KEY = re.compile(rb"(?m)^-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----\r?$")


def digest(content):
    return hashlib.sha256(content).hexdigest()


def allowed(name):
    parts = PurePosixPath(name).parts
    if not parts or "\\" in name or ":" in name or name.startswith("/"):
        return False
    if any(part.casefold() in FORBIDDEN or part in {".", ".."} for part in parts):
        return False
    if name in GENERATED_FILES:
        return True
    if len(parts) == 1:
        return name in ROOT_FILES
    if parts[0] == "docs":
        return name in API_DOC_FILES
    if parts[0] == "scripts":
        return len(parts) == 2 and parts[1] in SCRIPT_FILES
    if parts[0] == "deploy":
        return "/".join(parts[1:]) in DEPLOY_FILES
    return parts[0] in {"src", "public"} and not any(part.startswith(".") for part in parts) and PurePosixPath(name).suffix.lower() in ASSET_SUFFIXES


DEPLOYMENT_GUIDE = "部署、启动和停止方法见 [README.md](README.md)。\n"
PROTECTION_GUIDE = """# 发行版本说明

此包为可维护的普通源码安装版，JavaScript 源码保持可读，不含混淆构建工具。源码版与混淆版均无需运行时激活，使用条款见 LICENSE。

两种发行包均不包含运行数据库、环境配置、私钥、证书、账号密码或邮件。安装和升级说明见 [DEPLOYMENT.md](DEPLOYMENT.md)。
"""
SMOKE = """import test from 'node:test';
import assert from 'node:assert/strict';
import {access,readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {edition} from '../src/edition.js';
test('source installer includes complete mail, permission and deployment components', async()=>{
  assert.equal(edition.protected,false);
  for(const name of ['public/index.html','public/webmail.html','src/server.js','src/admin-permissions.js','src/domain-quota.js','src/code-rules-worker.js','compose.yaml','deploy/postoffice.service']) await access(new URL('../'+name,import.meta.url));
  const manifest=JSON.parse(await readFile(new URL('../release-manifest.json',import.meta.url),'utf8'));
  assert.equal(manifest.kind,'postoffice-source-release');
  for(const file of manifest.files){
    const bytes=await readFile(new URL('../'+file.path,import.meta.url));
    assert.equal(bytes.length,file.bytes,file.path);
    assert.equal(createHash('sha256').update(bytes).digest('hex'),file.sha256,file.path);
  }
});
"""


def collect(source):
    source = Path(source).resolve(strict=True)
    if not source.is_dir():
        raise ValueError("Source must be a project directory")
    snapshots = {}
    files = {}

    def read(name):
        if not allowed(name):
            raise ValueError(f"Unexpected runtime file: {name}")
        filename = source / name
        if filename.is_symlink() or filename.resolve(strict=True) != filename or not filename.is_file():
            raise ValueError(f"Not a regular in-project file: {name}")
        if filename.stat().st_size > 20 * 1024 * 1024:
            raise ValueError(f"Review oversized runtime file: {name}")
        content = filename.read_bytes()
        snapshots[name] = digest(content)
        if PRIVATE_KEY.search(content):
            raise ValueError(f"Private key found in runtime file: {name}")
        if name.endswith(".sh"):
            content = content.decode("utf-8-sig").replace("\r\n", "\n").replace("\r", "\n").encode("utf-8")
        if name.endswith(".ps1") and not content.startswith(b"\xef\xbb\xbf"):
            content = b"\xef\xbb\xbf" + content
        files[name] = content

    def walk(directory, prefix):
        if directory.is_symlink() or directory.resolve(strict=True) != directory:
            raise ValueError(f"Runtime directory cannot be a symlink or junction: {prefix}")
        for child in sorted(directory.iterdir()):
            name = f"{prefix}/{child.name}"
            if child.is_symlink() or child.resolve(strict=True) != child:
                raise ValueError(f"Runtime link is forbidden: {name}")
            if child.is_dir():
                if child.name.casefold() in FORBIDDEN or child.name.startswith("."):
                    raise ValueError(f"Runtime directory contains private data: {name}")
                walk(child, name)
            else:
                read(name)

    for name in sorted(ROOT_FILES):
        read(name)
    for name in sorted(SCRIPT_FILES):
        read("scripts/" + name)
    for name in sorted(DEPLOY_FILES):
        read("deploy/" + name)
    for name in ("src", "public"):
        walk(source / name, name)

    example = files[".env.example"].decode("utf-8-sig")
    for key in ("LICENSE_KEY", "RELAY_PASSWORD", "RELAY_USER", "TLS_KEY_PATH", "DKIM_PRIVATE_KEY_PATH"):
        if re.search(rf"(?m)^[ \t]*{key}[ \t]*=[ \t]*[^\s#]", example):
            raise ValueError(f"Environment example contains a configured secret/path: {key}")
    if not re.search(rb"protected\s*:\s*false", files["src/edition.js"]):
        raise ValueError("Use the protected packager for protected source trees")
    pkg = json.loads(files["package.json"])
    lock = json.loads(files["package-lock.json"])
    if lock.get("lockfileVersion") != 3 or pkg.get("version") != lock.get("version"):
        raise ValueError("Package version/lockfile does not match")
    # This is an installable source snapshot; maintenance-only build tools and
    # full regression suites are deliberately kept out of distribution.
    pkg["scripts"] = {
        "start": "node --env-file-if-exists=.env src/server.js",
        "dev": "node --env-file-if-exists=.env --watch src/server.js",
        "test": "node --test test/release-smoke.js",
        "check": "node scripts/check.js",
        "backup": "node --env-file-if-exists=.env scripts/backup.js",
    }
    files["package.json"] = (json.dumps(pkg, ensure_ascii=False, indent=2) + "\n").encode()
    readme = files["README.md"].decode("utf-8-sig")
    readme = re.sub(r"本项目在[^\n]*?见 \[DEPLOYMENT\.md\]\(DEPLOYMENT\.md\)。", "通用部署说明见 [DEPLOYMENT.md](DEPLOYMENT.md)。", readme)
    files["README.md"] = readme.encode()
    files["DEPLOYMENT.md"] = DEPLOYMENT_GUIDE.encode()
    files["PROTECTED-RELEASE.md"] = PROTECTION_GUIDE.encode()
    files["test/README.md"] = "此目录只含发行包完整性冒烟检查；完整回归测试保留在维护工作区。\n".encode()
    files["test/release-smoke.js"] = SMOKE.encode()
    inventory = [{"path": name, "bytes": len(content), "sha256": digest(content)} for name, content in sorted(files.items())]
    manifest = {
        "schemaVersion": 1,
        "kind": "postoffice-source-release",
        "version": pkg["version"],
        "buildId": f"source-{pkg['version']}-{digest(json.dumps(inventory, sort_keys=True).encode())[:12]}",
        "files": inventory,
    }
    files["release-manifest.json"] = (json.dumps(manifest, ensure_ascii=False, indent=2) + "\n").encode()
    return source, files, snapshots, manifest


def package(source, output):
    output = Path(output).absolute()
    checksum = Path(str(output) + ".sha256")
    if output.suffix.lower() != ".zip" or not output.parent.is_dir():
        raise ValueError("Choose a .zip output in an existing directory")
    if output.exists() or output.is_symlink() or checksum.exists() or checksum.is_symlink():
        raise ValueError("Refusing to overwrite an existing archive or checksum")
    source, files, snapshots, manifest = collect(source)
    if output.parent != source and source in output.parents:
        raise ValueError("Output may be at project root, but not in a runtime subdirectory")
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for name, content in sorted(files.items()):
            if not allowed(name):
                raise ValueError(f"Unexpected generated file: {name}")
            metadata = zipfile.ZipInfo(name)
            metadata.compress_type = zipfile.ZIP_DEFLATED
            metadata.create_system = 3
            metadata.external_attr = ((0o100755 if name.endswith(".sh") else 0o100644) << 16)
            archive.writestr(metadata, content)
    content = buffer.getvalue()
    with zipfile.ZipFile(io.BytesIO(content)) as archive:
        if archive.testzip() is not None or archive.namelist() != sorted(files):
            raise ValueError("Archive CRC or file inventory verification failed")
        for name, expected in files.items():
            if archive.read(name) != expected:
                raise ValueError(f"Archive byte verification failed: {name}")
    # Do not silently package an inconsistent snapshot while another editor is
    # changing files. Original source files are never rewritten by this script.
    for name, sha in snapshots.items():
        if digest((source / name).read_bytes()) != sha:
            raise ValueError(f"Source changed while packaging; retry: {name}")
    sha = digest(content)
    with output.open("xb") as destination:
        destination.write(content)
    if digest(output.read_bytes()) != sha:
        raise ValueError("Saved ZIP digest verification failed")
    with checksum.open("x", encoding="utf-8", newline="\n") as destination:
        destination.write(f"{sha}  {output.name}\n")
    return {"archive": str(output), "sha256": sha, "files": len(files), "bytes": len(content), "buildId": manifest["buildId"], "version": manifest["version"]}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    try:
        print(json.dumps(package(args.source, args.out), ensure_ascii=False, indent=2))
    except (OSError, ValueError, KeyError, zipfile.BadZipFile) as error:
        parser.exit(1, f"Source packaging failed: {error}\n")
