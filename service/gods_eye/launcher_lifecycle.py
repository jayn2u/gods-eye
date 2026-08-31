"""Launcher locking, reset, compatibility migration, and operation audit logs."""

from __future__ import annotations

import datetime as dt
import fcntl
import json
import os
import shutil
import sys
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

from .launcher_common import (
    EXIT_BUSY,
    EXIT_CONFIRMATION,
    EXIT_OK,
    RuntimeLayout,
    current_compatibility,
    utc_now,
)


class LauncherBusyError(RuntimeError):
    def __init__(self, active_operation: dict):
        super().__init__("another state-changing Launcher command is active")
        self.active_operation = active_operation


def render_busy(error: LauncherBusyError, *, as_json: bool = False) -> int:
    if as_json:
        print(
            json.dumps(
                {"status": "busy", "active_operation": error.active_operation}, sort_keys=True
            )
        )
    else:
        command = error.active_operation.get("command", "unknown")
        print(f"Launcher is busy: {command} is already running.", file=sys.stderr)
    return EXIT_BUSY


@contextmanager
def mutation_lock(layout: RuntimeLayout, command: str) -> Iterator[None]:
    layout.initialize()
    operation = {"command": command, "pid": os.getpid(), "started_at": utc_now()}
    descriptor = os.open(layout.lock_path, os.O_RDWR | os.O_CREAT, 0o600)
    try:
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError as error:
        try:
            active = json.loads(layout.lock_path.read_text())
        except (OSError, json.JSONDecodeError):
            active = {"command": "unknown", "pid": None, "started_at": None}
        os.close(descriptor)
        raise LauncherBusyError(active) from error
    with os.fdopen(descriptor, "w") as stream:
        stream.seek(0)
        stream.truncate()
        json.dump(operation, stream)
        stream.flush()
        yield


def write_operation_log(layout: RuntimeLayout, command: str, detail: dict) -> None:
    layout.initialize()
    safe_detail = {
        key: value
        for key, value in detail.items()
        if key not in {"token", "query", "path", "user", "home"}
    }
    record = {"at": utc_now(), "command": command, "detail": safe_detail}
    timestamp = dt.datetime.now(dt.UTC).strftime("%Y%m%dT%H%M%S.%fZ")
    (layout.logs_dir / f"{timestamp}-{command}.log").write_text(
        json.dumps(record, sort_keys=True) + "\n"
    )


RESET_PATHS = {
    "index": Path("indexes"),
    "model_cache": Path(".cache/huggingface"),
    "installed_datasets": Path("data/datasets"),
    "archives": Path("data/archives"),
}
RESET_INVALIDATION = {
    "index": {"index", "smoke_test"},
    "model_cache": {"model", "index", "smoke_test"},
    "installed_datasets": {"dataset_acquisition", "gallery_manifest", "index", "smoke_test"},
    "archives": set(),
}


def _path_size(path: Path) -> int:
    if path.is_symlink() or path.is_file():
        return path.lstat().st_size
    if not path.exists():
        return 0
    return sum(item.lstat().st_size for item in path.rglob("*") if item.is_file())


def _remove_path(path: Path) -> None:
    if path.is_symlink() or path.is_file():
        path.unlink(missing_ok=True)
    elif path.exists():
        shutil.rmtree(path)


def reset_assets(
    layout: RuntimeLayout, targets: list[str], *, confirmed: bool, as_json: bool
) -> int:
    paths = {target: layout.root / RESET_PATHS[target] for target in targets}
    sizes = {target: _path_size(path) for target, path in paths.items()}
    if not as_json:
        print("Reset plan")
        for target in targets:
            print(f"- {target.replace('_', ' ')} ({sizes[target]} bytes)")
    if not confirmed:
        if as_json:
            print(json.dumps({"status": "confirmation_required"}, sort_keys=True))
            return EXIT_CONFIRMATION
        try:
            answer = input("Delete these local assets? [y/N] ")
        except EOFError:
            print("Reset requires confirmation; rerun with --yes.", file=sys.stderr)
            return EXIT_CONFIRMATION
        if answer.strip().lower() not in {"y", "yes"}:
            print("Reset cancelled; no assets were deleted.")
            return EXIT_OK
    with mutation_lock(layout, "reset"):
        state = layout.read_state()
        for path in paths.values():
            _remove_path(path)
        invalidated = set().union(*(RESET_INVALIDATION[target] for target in targets))
        preparation = state.setdefault("preparation", {})
        for stage in invalidated:
            preparation.pop(stage, None)
        layout.write_state(state)
        write_operation_log(layout, "reset", {"targets": targets, "sizes": sizes})
    if as_json:
        print(json.dumps({"deleted": targets, "status": "ok"}, sort_keys=True))
    else:
        print("Reset complete.")
    return EXIT_OK


COMPATIBILITY_INVALIDATION = {
    "application": set(),
    "registry": {"dataset_acquisition", "gallery_manifest", "index", "smoke_test"},
    "model": {"model", "index", "smoke_test"},
    "manifest_schema": {"gallery_manifest", "index", "smoke_test"},
    "index_schema": {"index", "smoke_test"},
}
STAGE_ORDER = ["dataset_acquisition", "model", "gallery_manifest", "index", "smoke_test"]


def compatibility_plan(state: dict) -> tuple[dict[str, str], list[str], list[str]]:
    target = current_compatibility()
    previous = state.get("compatibility")
    changed = list(target) if previous is None and state.get("preparation") else []
    if previous is not None:
        changed = [key for key, value in target.items() if previous.get(key) != value]
    invalidated = set().union(*(COMPATIBILITY_INVALIDATION[key] for key in changed))
    return target, changed, [stage for stage in STAGE_ORDER if stage in invalidated]


def update_state(layout: RuntimeLayout, *, apply: bool, as_json: bool) -> int:
    state = layout.read_state()
    target, changed, invalidated = compatibility_plan(state)
    report = {
        "status": "applied" if apply else "planned",
        "changes": changed,
        "invalidate": invalidated,
        "reuse": [stage for stage in state.get("preparation", {}) if stage not in invalidated],
        "target": target,
    }
    if apply:
        with mutation_lock(layout, "update"):
            state = layout.read_state()
            target, changed, invalidated = compatibility_plan(state)
            preparation = state.setdefault("preparation", {})
            for stage in invalidated:
                preparation.pop(stage, None)
            if "registry" in changed:
                state["terms_acceptance"] = None
            state["compatibility"] = target
            layout.write_state(state)
            write_operation_log(layout, "update", {"changes": changed, "invalidated": invalidated})
            report.update(
                changes=changed,
                invalidate=invalidated,
                reuse=[s for s in preparation if s not in invalidated],
            )
    if as_json:
        print(json.dumps(report, sort_keys=True))
    else:
        print("Migration applied" if apply else "Migration plan")
        print(f"Compatibility changes: {', '.join(changed) if changed else 'none'}")
        print(f"Rebuild required: {', '.join(invalidated) if invalidated else 'none'}")
        print(
            f"Verified stages reused: {', '.join(report['reuse']) if report['reuse'] else 'none'}"
        )
        if not apply:
            print("Run './gods-eye update --yes' to apply this plan.")
    return EXIT_OK
