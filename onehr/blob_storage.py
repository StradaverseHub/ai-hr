"""Azure Blob Storage helper for Performance Management KPI attachments.

Same convention as mailer.py/ai_draft.py: stdlib-only at import time, gated
on an env var, callers always use the qualified form (blob_storage.upload(),
never `from blob_storage import upload`). azure.* imports are deferred into
function bodies so `import blob_storage` in app.py never fails to import in
an environment where azure-storage-blob/azure-identity aren't installed --
only a real Blob call touches azure.*, and only once actually configured.
"""
import os

DEFAULT_CONTAINER = "attachments"
_client = None


class BlobStorageError(RuntimeError):
    """A Blob upload/download call failed for a reason other than not-found."""


def _account():
    return os.environ.get("PM_BLOB_ACCOUNT_NAME")


def _container():
    return os.environ.get("PM_BLOB_CONTAINER") or DEFAULT_CONTAINER


def is_configured():
    return bool(_account())


def config_status():
    return {"configured": is_configured(), "account": _account() or "",
            "container": _container()}


def get_client():
    """Cached process-wide BlobServiceClient, or None if PM_BLOB_ACCOUNT_NAME
    isn't set. Module-level singleton (NOT g-memoized like active_cycle()):
    BlobServiceClient/DefaultAzureCredential are documented thread-safe and
    meant to be reused for the process lifetime -- no per-request variance
    to justify g-caching here. Tests monkeypatch this exact name to inject a
    fake client -- keep this the single seam; callers must always say
    blob_storage.get_client()."""
    global _client
    if not is_configured():
        return None
    if _client is None:
        from azure.identity import DefaultAzureCredential
        from azure.storage.blob import BlobServiceClient
        _client = BlobServiceClient(
            account_url=f"https://{_account()}.blob.core.windows.net",
            credential=DefaultAzureCredential())
    return _client


def blob_name(period_id, kpi_target_id, ext):
    """<period_id>/<kpi_target_id>/<uuid>.<ext> -- same shape as
    PM_UPLOAD_DIR's local hierarchy, so a future backfill is a pure rename."""
    import uuid
    return f"{period_id}/{kpi_target_id}/{uuid.uuid4().hex}{ext}"


def _content_settings(content_type):
    """Lazily build an azure.storage.blob.ContentSettings, or None if no
    content_type was given. A second, separate seam from get_client() --
    tests monkeypatch this too (e.g. to a passthrough lambda), since the
    real SDK's ContentSettings class isn't something a fake BlobClient can
    intercept just by having get_client() return a fake service object."""
    if not content_type:
        return None
    from azure.storage.blob import ContentSettings
    return ContentSettings(content_type=content_type)


def upload(name, data, content_type=None):
    client = get_client()
    if client is None:
        raise BlobStorageError("upload() called but Blob is not configured")
    bc = client.get_blob_client(container=_container(), blob=name)
    try:
        bc.upload_blob(data, overwrite=True, content_settings=_content_settings(content_type))
    except Exception as e:
        raise BlobStorageError(f"Blob upload failed for {name}: {e}") from e


def download(name):
    """Bytes, or None if not found. Raises BlobStorageError for any other
    failure (auth, network, throttling, etc.)."""
    client = get_client()
    if client is None:
        raise BlobStorageError("download() called but Blob is not configured")
    bc = client.get_blob_client(container=_container(), blob=name)
    try:
        return bc.download_blob().readall()
    except Exception as e:
        if getattr(e, "status_code", None) == 404:
            return None
        raise BlobStorageError(f"Blob download failed for {name}: {e}") from e
