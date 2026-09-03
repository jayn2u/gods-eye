"""Dataset terms and Dataset Acquisition stage for Demo Preparation."""

import datetime as dt
import hashlib
import json
import os
import re
import shlex
import sys
import time
from pathlib import Path

from .launcher_common import (
    EXIT_OK,
    EXIT_PREPARATION_FAILED,
    EXIT_PREREQUISITE,
    EXIT_TERMS_REQUIRED,
    RuntimeLayout,
    run,
    utc_now,
)
from .launcher_doctor import doctor, print_human, required_capacity_bytes


def _registry() -> dict[str, object]:
    return json.loads(Path(__file__).with_name("dataset_registry.json").read_text())


def _source_fingerprints(registry: dict[str, object]) -> dict[str, str]:
    return {
        source["name"]: hashlib.sha256(
            json.dumps(source, sort_keys=True, separators=(",", ":")).encode()
        ).hexdigest()
        for source in registry["sources"]
    }


def _print_dataset_terms(registry: dict[str, object]) -> None:
    print("Dataset terms acknowledgement")
    for source in registry["sources"]:
        print(f"- {source['name']} ({source['size'] / 1024**3:.2f} GiB)")
        print(f"  Official source: {source['official_source']}")
        print(f"  Terms/license: {source['terms_url']}")
        print(f"  Mirror: Google Drive file {source['drive_id']}")
        print(f"  Restriction: {source['usage_restrictions']}")
    print(
        "Sensitive-data warning: these person-image research datasets may contain identifiable people."
    )


def _stage(number: int, label: str, started: float, estimate: str) -> None:
    print(
        f"Stage {number}/7 — {label} (elapsed {time.monotonic() - started:.1f}s; estimated {estimate})"
    )


def _safe_log_output(value: str) -> str:
    value = re.sub(
        r"(?i)(token|access_token|api_key)=([^\s&]+)",
        lambda match: f"{match.group(1)}=[REDACTED]",
        value,
    )
    return re.sub(r"(?i)Bearer\s+\S+", "Bearer [REDACTED]", value)


def _preparation_log_path(layout: RuntimeLayout) -> Path:
    return layout.logs_dir / f"prepare-{dt.datetime.now(dt.UTC).strftime('%Y%m%dT%H%M%S%fZ')}.log"


def prepare_datasets(layout: RuntimeLayout, *, accept_data_terms: bool, assume_yes: bool) -> int:
    started = time.monotonic()
    _stage(1, "Preflight and storage calculation", started, "under 1 minute")
    print(f"Calculated storage requirement: {required_capacity_bytes()} bytes")
    checks = doctor(layout)
    if any(check.status == "fail" for check in checks):
        print_human(checks)
        return EXIT_PREREQUISITE
    registry = _registry()
    _stage(2, "Dataset terms acknowledgement", started, "operator decision")
    _print_dataset_terms(registry)
    state = layout.read_state()
    expected = {
        "registry_version": registry["schema_version"],
        "source_fingerprints": _source_fingerprints(registry),
    }
    saved = state.get("terms_acceptance") or {}
    compatible = all(saved.get(key) == value for key, value in expected.items())
    if saved and not compatible:
        preparation = state.setdefault("preparation", {})
        for stage in ("dataset_acquisition", "gallery_manifest", "index", "smoke_test"):
            preparation.pop(stage, None)
        layout.write_state(state)
    if compatible:
        accept_data_terms = True
        print("Using dataset terms acceptance for the unchanged Dataset Registry sources.")
    if not accept_data_terms and not assume_yes and sys.stdin.isatty():
        accept_data_terms = (
            input("Type 'yes' to accept the displayed dataset terms: ").strip().lower() == "yes"
        )
    if not accept_data_terms:
        print(
            "Dataset terms require explicit acceptance; rerun with --accept-data-terms.",
            file=sys.stderr,
        )
        return EXIT_TERMS_REQUIRED
    if not compatible:
        state["terms_acceptance"] = {"accepted_at": utc_now(), **expected}
        layout.write_state(state)
    _stage(3, "Dataset Acquisition", started, "depends on network throughput")
    state["preparation"].pop("dataset_acquisition", None)
    layout.write_state(state)
    host_root = Path(os.getenv("GODS_EYE_HOST_PROJECT_ROOT", str(layout.root)))
    build_root = layout.root
    service_image = os.getenv("GODS_EYE_SERVICE_IMAGE", "gods-eye-service:local")
    if run("docker", "image", "inspect", service_image).returncode != 0:
        build_command = (
            "docker",
            "build",
            "--file",
            str(build_root / "Dockerfile.service"),
            "--tag",
            service_image,
            str(build_root),
        )
        build = run(*build_command)
        if build.returncode != 0:
            log_path = _preparation_log_path(layout)
            log_path.write_text(
                "Stage 3/7 — Dataset Acquisition service image build\n"
                + f"Command: {_safe_log_output(shlex.join(build_command))}\n"
                + _safe_log_output(build.stdout)
                + _safe_log_output(build.stderr)
                + f"Service image build failed with exit code {build.returncode}\n"
            )
            print(
                f"Could not build the local service image for Dataset Acquisition. Log: {log_path}",
                file=sys.stderr,
            )
            return EXIT_PREPARATION_FAILED
    result = run(
        "docker",
        "run",
        "--rm",
        "--entrypoint",
        "gods-eye-datasets",
        "--volume",
        f"{host_root / 'data'}:/data:rw",
        "--volume",
        f"{host_root / 'indexes'}:/indexes:rw",
        service_image,
        "--data-root",
        "/data",
        "--index-root",
        "/indexes",
        "install",
        "--accept-data-terms",
        "--skip-manifest",
    )
    log_path = _preparation_log_path(layout)
    log_path.write_text(
        "Stage 3/7 — Dataset Acquisition\n"
        + _safe_log_output(result.stdout)
        + _safe_log_output(result.stderr)
        + (
            "Dataset Acquisition completed\n"
            if result.returncode == 0
            else "Dataset Acquisition interrupted\n"
        )
    )
    if result.returncode != 0:
        print(
            f"Dataset Acquisition did not complete; rerun prepare to resume. Log: {log_path}",
            file=sys.stderr,
        )
        return result.returncode if result.returncode > 0 else EXIT_PREPARATION_FAILED
    state = layout.read_state()
    state["preparation"]["dataset_acquisition"] = {
        "status": "verified",
        "registry_version": registry["schema_version"],
        "selected_sources": [source["name"] for source in registry["sources"]],
        "completed_at": utc_now(),
    }
    layout.write_state(state)
    print(f"Dataset Acquisition completed. Detailed log: {log_path}")
    return EXIT_OK
