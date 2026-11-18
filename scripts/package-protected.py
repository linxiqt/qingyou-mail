"""Verify and ZIP a completed formal protected release without private data."""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
import zipfile


SERVER = "https://authorize.lxya.cc"
FORBIDDEN = {".env", "data", "backups", "certs", ".runtime", "node_modules",
             "test-results", ".git", ".agents", ".codex", ".aws"}
ROOT_FILES = {
    ".env.example", ".dockerignore", "Dockerfile", "compose.yaml", "package.json", "package-lock.json",
    "README.md", "FEATURE-PARITY.md", "LICENSE",
    "DEPLOYMENT.md", "PROTECTED-RELEASE.md", "release-manifest.json",
}
DEPLOY_FILES = {"nginx.conf", "postoffice.service", "node-version.txt", "node-sha256.txt",
                "keydock-offline-public.pem", "rspamd/dkim_signing.conf",
                "rspamd/postoffice-rspamd.conf", "rspamd/worker-controller.inc",
                "rspamd/worker-normal.inc", "rspamd/worker-proxy.inc"}


def allowed(name):
    parts = PurePosixPath(name).parts
    if not parts or any(p in FORBIDDEN or p in (".", "..") for p in parts):
        return False
    if len(parts) == 1:
        return name in ROOT_FILES
    if parts[0] == "docs":
        return name in {"docs/api/README.md", "docs/api/openapi.json", "docs/api/openapi-mail.json",
                        "docs/api/examples/qingyou-tools.mjs", "docs/api/examples/requests.http"}
    if parts[0] == "deploy":
        return "/".join(parts[1:]) in DEPLOY_FILES
    if parts[0] == "test":
        return name in {"test/release-smoke.js", "test/README.md"}
    if parts[0] == "scripts":
        return parts[-1] in {"backup.js", "check.js", "check-mail-listeners.js"} and len(parts) == 2
    return parts[0] in {"src", "public"} and Path(name).suffix.lower() in {
        ".js", ".html", ".css", ".svg", ".png", ".jpg", ".jpeg", ".webp", ".ico", ".woff", ".woff2"}


def verify_release(source, node):
    manifest_file = source / "release-manifest.json"
    manifest = json.loads(manifest_file.read_text(encoding="utf-8"))
    if manifest.get("schemaVersion") != 1 or manifest.get("kind") != "postoffice-protected-release":
        raise ValueError("Unsupported or incomplete release manifest")
    if manifest.get("qa") is not False or manifest.get("licenseServer") != SERVER:
        raise ValueError("QA builds and non-production authorization servers cannot be packaged")
    product = manifest.get("productId", "")
    if not re.fullmatch(r"app_[A-Za-z0-9_-]{1,76}", product) or product == "app_postoffice_qa":
        raise ValueError("A real KeyDock product ID is required")
    records = {}
    for record in manifest.get("files", []):
        name = record["path"]
        if "\\" in name or PurePosixPath(name).is_absolute() or not allowed(name) or name in records:
            raise ValueError(f"Unsafe, duplicate or unexpected release file: {name}")
        records[name] = record
    actual = set()
    for filename in source.rglob("*"):
        if filename.is_symlink():
            raise ValueError(f"Symlink not permitted: {filename}")
        if filename.is_file():
            actual.add(filename.relative_to(source).as_posix())
    if actual != set(records) | {"release-manifest.json"}:
        raise ValueError("Build contains missing or unlisted files; do not package a live installation")
    for name, record in records.items():
        content = (source / name).read_bytes()
        if len(content) != record["bytes"] or hashlib.sha256(content).hexdigest() != record["sha256"]:
            raise ValueError(f"Manifest verification failed: {name}")
        if name.endswith(".js") and record.get("role") != "obfuscated-js":
            raise ValueError(f"JavaScript was not protected: {name}")
        if name.endswith(".sh") and b"\r" in content:
            raise ValueError(f"Shell script must use LF line endings: {name}")
        if name.endswith(".ps1") and not content.startswith(b"\xef\xbb\xbf"):
            raise ValueError("Windows launcher lost its UTF-8 BOM")
        if name.endswith(".pem") and b"PRIVATE KEY" in content:
            raise ValueError("Private keys may not enter the release")
    required = {"LICENSE", "src/edition.js", "src/license.js", "public/license-tools.js", "public/webmail.html",
                "deploy/keydock-offline-public.pem", "compose.yaml", "deploy/postoffice.service", "test/release-smoke.js"}
    if not required.issubset(records):
        raise ValueError("Release is missing required mail, installer or license components")
    code = ("import {pathToFileURL} from 'node:url';"
            "const {edition}=await import(pathToFileURL(process.argv[1]));"
            "console.log(JSON.stringify(edition));")
    env = dict(os.environ)
    env.pop("NODE_OPTIONS", None)
    result = subprocess.run([node, "--input-type=module", "--eval", code, str(source / "src/edition.js")],
                            check=True, capture_output=True, text=True, encoding="utf-8", env=env, timeout=30)
    edition = json.loads(result.stdout)
    if edition != {"protected": True, "required": True, "product": product, "server": SERVER}:
        raise ValueError("Embedded edition binding differs from the formal manifest")
    pkg = json.loads((source / "package.json").read_text(encoding="utf-8"))
    if pkg.get("devDependencies"):
        raise ValueError("Build and maintenance dependencies must not enter runtime metadata")
    return manifest, sorted(actual)


def package(source, output, node="node"):
    source, output = Path(source).resolve(strict=True), Path(output).absolute()
    if not source.is_dir() or output.suffix.lower() != ".zip":
        raise ValueError("Use a completed build directory and a new .zip output path")
    if source == output or source in output.parents:
        raise ValueError("ZIP output must be outside the build directory")
    if output.exists() or Path(str(output) + ".sha256").exists():
        raise ValueError("Refusing to overwrite an existing ZIP or checksum")
    manifest, names = verify_release(source, node)
    with zipfile.ZipFile(output, "x", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for name in names:
            metadata = zipfile.ZipInfo.from_file(source / name, arcname=name)
            metadata.compress_type = zipfile.ZIP_DEFLATED
            metadata.create_system = 3
            metadata.external_attr = ((0o100755 if name.endswith(".sh") else 0o100644) << 16)
            archive.writestr(metadata, (source / name).read_bytes())
    with zipfile.ZipFile(output) as archive:
        if archive.testzip() is not None or sorted(archive.namelist()) != names:
            raise ValueError("ZIP integrity or file inventory check failed")
        for name in names:
            if archive.read(name) != (source / name).read_bytes():
                raise ValueError(f"ZIP byte verification failed: {name}")
    sha = hashlib.sha256(output.read_bytes()).hexdigest()
    Path(str(output) + ".sha256").write_text(f"{sha}  {output.name}\n", encoding="utf-8")
    return {"archive": str(output), "sha256": sha, "files": len(names),
            "buildId": manifest["buildId"], "productId": manifest["productId"]}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--node", default="node")
    args = parser.parse_args()
    try:
        print(json.dumps(package(args.source, args.out, args.node), ensure_ascii=False, indent=2))
    except (OSError, ValueError, KeyError, subprocess.SubprocessError) as error:
        parser.exit(1, f"Protected packaging failed: {error}\n")
