"""Stable Launcher entry point.

The command parser lives separately from the domain modules for diagnostics,
runtime, preparation/assets, and lifecycle state. Imports are retained here for
backwards compatibility with existing automation using this public seam.
"""

from __future__ import annotations

from . import launcher_cli as _cli
from .launcher_assets import prepare_datasets
from .launcher_common import (  # noqa: F401
    EXIT_BUSY,
    EXIT_CONFIRMATION,
    EXIT_OK,
    EXIT_PREPARATION,
    EXIT_PREPARATION_FAILED,
    EXIT_PREREQUISITE,
    EXIT_TERMS_REQUIRED,
    EXIT_USAGE,
    RuntimeLayout,
    current_compatibility,
)
from .launcher_doctor import doctor, required_capacity_bytes  # noqa: F401
from .launcher_lifecycle import (  # noqa: F401
    LauncherBusyError,
    compatibility_plan,
    mutation_lock,
    render_busy,
    reset_assets,
    update_state,
)
from .launcher_runtime import runtime_passthrough, start_runtime  # noqa: F401


def main(argv: list[str] | None = None) -> int:
    # Preserve the established monkeypatch seam while delegating parsing.
    _cli.prepare_datasets = prepare_datasets
    return _cli.main(argv)


if __name__ == "__main__":
    raise SystemExit(main())
