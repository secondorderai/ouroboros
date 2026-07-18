"""Publish a staged Kaggle model with reliable resumable-upload restoration."""

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path
from typing import Any, Callable


def restore_resumable_upload(
    record: dict[str, Any],
    context: Any,
    *,
    request_type: Any,
    response_type: Any,
    upload_type: Any,
) -> Any:
    """Restore Kaggle 2.2 upload metadata using its generated SDK API correctly."""
    request = request_type.from_dict(record["start_blob_upload_request"])
    upload = upload_type(record["path"], request, context)
    upload.timestamp = record.get("timestamp")
    response = record.get("start_blob_upload_response")
    if response is not None:
        upload.start_blob_upload_response = response_type.from_dict(response)
        upload.upload_complete = bool(record.get("upload_complete"))
    return upload


def resumable_record_is_valid(
    current: Any,
    previous: Any,
    *,
    now: float,
    expiry_seconds: int,
) -> bool:
    return (
        previous.path == current.path
        and previous.start_blob_upload_request.to_dict()
        == current.start_blob_upload_request.to_dict()
        and previous.timestamp > now - expiry_seconds
    )


def install_resume_compatibility_patch() -> None:
    """Patch Kaggle CLI 2.2.3's generated-SDK restore and equality calls."""
    from kaggle.api.kaggle_api_extended import (  # type: ignore
        ApiStartBlobUploadRequest,
        ApiStartBlobUploadResponse,
        ResumableFileUpload,
    )

    def restore(record: dict[str, Any], context: Any) -> Any:
        return restore_resumable_upload(
            record,
            context,
            request_type=ApiStartBlobUploadRequest,
            response_type=ApiStartBlobUploadResponse,
            upload_type=ResumableFileUpload,
        )

    ResumableFileUpload.from_dict = staticmethod(restore)

    def previous_is_valid(current: Any, previous: Any) -> bool:
        return resumable_record_is_valid(
            current,
            previous,
            now=time.time(),
            expiry_seconds=ResumableFileUpload.RESUMABLE_UPLOAD_EXPIRY_SECONDS,
        )

    ResumableFileUpload._is_previous_valid = previous_is_valid


def recover_empty_json_response(response_type: Any, http_response: Any) -> Any:
    """Turn an empty successful response into an empty SDK response object."""
    http_response.raise_for_status()
    if not str(http_response.text).strip():
        return response_type()
    raise ValueError("Kaggle returned non-JSON content for a JSON response")


def install_empty_response_compatibility_patch() -> None:
    """Ensure empty 5xx responses are retried and empty 2xx responses are accepted."""
    from requests.exceptions import JSONDecodeError  # type: ignore
    from kagglesdk.kaggle_http_client import KaggleHttpClient  # type: ignore

    original = KaggleHttpClient._prepare_response

    def prepare(client: Any, response_type: Any, http_response: Any) -> Any:
        try:
            return original(client, response_type, http_response)
        except JSONDecodeError:
            print(
                "Kaggle returned an empty JSON response: "
                f"HTTP {http_response.status_code}"
            )
            return recover_empty_json_response(response_type, http_response)

    KaggleHttpClient._prepare_response = prepare


def instance_reference(metadata: dict[str, Any]) -> str:
    return "/".join(
        (
            str(metadata["ownerSlug"]),
            str(metadata["modelSlug"]),
            str(metadata["framework"]),
            str(metadata["instanceSlug"]),
        )
    )


def wait_for_instance(
    fetch: Callable[[str], Any],
    reference: str,
    *,
    attempts: int = 12,
    delay_seconds: float = 5.0,
) -> Any | None:
    for attempt in range(attempts):
        try:
            return fetch(reference)
        except Exception:
            if attempt + 1 < attempts:
                time.sleep(delay_seconds)
    return None


def publish(folder: Path, *, quiet: bool = False) -> str:
    metadata_path = folder / "model-instance-metadata.json"
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    reference = instance_reference(metadata)

    install_resume_compatibility_patch()
    install_empty_response_compatibility_patch()
    from kaggle.api.kaggle_api_extended import KaggleApi  # type: ignore

    api = KaggleApi()
    api.authenticate()
    try:
        response = api.model_instance_create(str(folder), quiet=quiet)
        if getattr(response, "error", ""):
            raise RuntimeError(str(response.error))
    except Exception as exc:
        # Kaggle occasionally returns an empty response after accepting a large
        # create request. Confirm server state before treating that as failure.
        instance = wait_for_instance(api.model_instance_get, reference)
        if instance is None:
            raise RuntimeError(f"Kaggle model publication failed: {exc}") from exc
    else:
        instance = wait_for_instance(api.model_instance_get, reference)
        if instance is None:
            raise RuntimeError(f"Kaggle did not expose the created model instance {reference}")

    print(f"Published Kaggle model instance: {reference}")
    return reference


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("folder", type=Path)
    parser.add_argument("--quiet", action="store_true")
    args = parser.parse_args()
    publish(args.folder, quiet=args.quiet)


if __name__ == "__main__":
    main()
