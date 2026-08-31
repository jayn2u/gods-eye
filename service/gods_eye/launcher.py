"""Stable Launcher entry point.

The command parser lives separately from the domain modules for diagnostics,
runtime, preparation/assets, and lifecycle state. Imports are retained here for
backwards compatibility with existing automation using this public seam.
"""

from __future__ import annotations

from . import launcher_cli as _cli
from .launcher_cli import (  # noqa: F401
    EXIT_BUSY,
    EXIT_CONFIRMATION,
    EXIT_OK,
    EXIT_PREPARATION,
    EXIT_PREPARATION_FAILED,
    EXIT_PREREQUISITE,
    EXIT_TERMS_REQUIRED,
    EXIT_USAGE,
    LauncherBusyError,
    RuntimeLayout,
    compatibility_plan,
    current_compatibility,
    doctor,
    mutation_lock,
    prepare_datasets,
    render_busy,
    required_capacity_bytes,
    reset_assets,
    runtime_passthrough,
    start_runtime,
    update_state,
)


def main(argv: list[str] | None = None) -> int:
    # Preserve the established monkeypatch seam while delegating parsing.
    _cli.prepare_datasets = prepare_datasets
    return _cli.main(argv)


if __name__ == "__main__":
    raise SystemExit(main())
