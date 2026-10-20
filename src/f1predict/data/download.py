"""Download a pinned F1DB release (CSV bundle) and verify its checksum."""

from __future__ import annotations

import hashlib
import io
import zipfile
from pathlib import Path

import requests

from f1predict.config import F1DB_VERSION, RAW_DIR

RELEASE_URL = "https://github.com/f1db/f1db/releases/download/{version}/{asset}"
LATEST_API = "https://api.github.com/repos/f1db/f1db/releases/latest"
ASSET = "f1db-csv.zip"


def latest_version(timeout: float = 30) -> str:
    resp = requests.get(LATEST_API, timeout=timeout)
    resp.raise_for_status()
    return resp.json()["tag_name"]


def f1db_dir(version: str = F1DB_VERSION) -> Path:
    return RAW_DIR / "f1db" / version


def download_f1db(version: str = F1DB_VERSION, force: bool = False, timeout: float = 120) -> Path:
    """Fetch the CSV bundle for `version` into data/raw/f1db/<version>/ and return that directory.

    The archive's SHA-256 is checked against the release's published checksums file
    before anything is extracted.
    """
    target = f1db_dir(version)
    if target.exists() and any(target.glob("f1db-*.csv")) and not force:
        return target

    sums = requests.get(RELEASE_URL.format(version=version, asset="checksums_sha256.txt"), timeout=timeout)
    sums.raise_for_status()
    expected = {name: digest for digest, name in (line.split() for line in sums.text.splitlines() if line.strip())}
    if ASSET not in expected:
        raise RuntimeError(f"{ASSET} missing from checksums of F1DB {version}")

    blob = requests.get(RELEASE_URL.format(version=version, asset=ASSET), timeout=timeout)
    blob.raise_for_status()
    digest = hashlib.sha256(blob.content).hexdigest()
    if digest != expected[ASSET]:
        raise RuntimeError(f"checksum mismatch for F1DB {version}: {digest} != {expected[ASSET]}")

    target.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(io.BytesIO(blob.content)) as zf:
        for member in zf.namelist():
            # The bundle is flat; refuse anything that would escape the target directory.
            name = Path(member).name
            if not name.endswith(".csv") or name != member:
                continue
            (target / name).write_bytes(zf.read(member))
    (target / "SHA256").write_text(f"{digest}  {ASSET}\n")
    return target
