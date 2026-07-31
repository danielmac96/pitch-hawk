"""Object storage with two interchangeable backends.

R2Store talks to Cloudflare R2 over the S3 API. LocalStore is a filesystem
implementation of the same protocol, which is what lets the ingest and query
modules be tested with no credentials and no network access.

Readers resolve keys through warehouse.manifest rather than listing the bucket.
Scoped R2 tokens can be created without LIST permission, and an explicit index
is what the prune step gates on in any case.
"""

from __future__ import annotations

from pathlib import Path
from typing import Protocol, runtime_checkable

from warehouse.config import R2Config


@runtime_checkable
class ObjectStore(Protocol):
    def put(self, key: str, data: bytes) -> None: ...
    def get(self, key: str) -> bytes: ...
    def exists(self, key: str) -> bool: ...
    def uri(self, key: str) -> str: ...


class LocalStore:
    """Filesystem-backed store. Used by tests and for dry runs."""

    def __init__(self, root: Path | str) -> None:
        self.root = Path(root)

    def _path(self, key: str) -> Path:
        return self.root / key

    def put(self, key: str, data: bytes) -> None:
        path = self._path(key)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)

    def get(self, key: str) -> bytes:
        return self._path(key).read_bytes()

    def exists(self, key: str) -> bool:
        return self._path(key).is_file()

    def uri(self, key: str) -> str:
        return str(self._path(key)).replace("\\", "/")

    def configure_duckdb(self, con) -> None:  # noqa: ANN001
        """No-op: DuckDB reads local paths without configuration."""
        return None


class R2Store:
    """Cloudflare R2 over the S3 API."""

    def __init__(self, cfg: R2Config) -> None:
        import boto3
        from botocore.config import Config

        self._cfg = cfg
        self.bucket = cfg.bucket
        self._s3 = boto3.client(
            "s3",
            endpoint_url=cfg.endpoint_url,
            aws_access_key_id=cfg.access_key_id,
            aws_secret_access_key=cfg.secret_access_key,
            # R2 ignores region but boto3 requires one.
            region_name="auto",
            config=Config(retries={"max_attempts": 5, "mode": "standard"}),
        )

    def put(self, key: str, data: bytes) -> None:
        self._s3.put_object(Bucket=self.bucket, Key=key, Body=data)

    def get(self, key: str) -> bytes:
        return self._s3.get_object(Bucket=self.bucket, Key=key)["Body"].read()

    def exists(self, key: str) -> bool:
        from botocore.exceptions import ClientError

        try:
            self._s3.head_object(Bucket=self.bucket, Key=key)
        except ClientError:
            return False
        return True

    def uri(self, key: str) -> str:
        return f"s3://{self.bucket}/{key}"

    def configure_duckdb(self, con) -> None:  # noqa: ANN001
        """Point a DuckDB connection at R2 so read_parquet('s3://…') works."""
        con.execute("install httpfs; load httpfs;")
        con.execute(
            f"set s3_endpoint = '{self._cfg.account_id}.r2.cloudflarestorage.com'")
        con.execute("set s3_region = 'auto'")
        con.execute("set s3_url_style = 'path'")
        con.execute(f"set s3_access_key_id = '{self._cfg.access_key_id}'")
        con.execute(
            f"set s3_secret_access_key = '{self._cfg.secret_access_key}'")
