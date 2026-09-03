"""Argument parsing and orchestration for the Docker-only Launcher."""

import argparse
import json
import os
import sys
from dataclasses import asdict
from pathlib import Path

from .launcher_assets import prepare_datasets
from .launcher_common import (
    EXIT_OK,
    EXIT_PREPARATION,
    EXIT_PREPARATION_FAILED,
    EXIT_PREREQUISITE,
    EXIT_USAGE,
    RuntimeLayout,
)
from .launcher_doctor import doctor, preparation_vram_mib, print_human
from .launcher_lifecycle import (
    RESET_PATHS,
    LauncherBusyError,
    mutation_lock,
    render_busy,
    reset_assets,
    update_state,
)
from .launcher_runtime import prepared_missing, runtime_passthrough, start_runtime


class LauncherArgumentParser(argparse.ArgumentParser):
    def error(self, message: str) -> None:
        self.print_usage(sys.stderr)
        self.exit(EXIT_USAGE, f"{self.prog}: error: {message}\n")


def offer_preparation(layout: RuntimeLayout) -> int | None:
    missing = prepared_missing(layout)
    if not missing or not sys.stdin.isatty():
        return None
    print("Full Demo preparation is incomplete: " + ", ".join(missing) + ".")
    if input("Run './gods-eye prepare' now? [y/N] ").strip().lower() not in {"y", "yes"}:
        return EXIT_PREPARATION_FAILED
    result = main(["prepare"])
    return None if result == EXIT_OK else result


def _parser() -> tuple[LauncherArgumentParser, argparse.ArgumentParser]:
    parser = LauncherArgumentParser(prog="gods-eye")
    commands = parser.add_subparsers(dest="command", required=True)
    doctor_parser = commands.add_parser("doctor")
    doctor_parser.add_argument("--json", action="store_true")
    prepare = commands.add_parser("prepare")
    prepare.add_argument("--batch-size", type=int)
    prepare.add_argument("--yes", action="store_true")
    prepare.add_argument("--accept-data-terms", action="store_true")
    start = commands.add_parser("start")
    start.add_argument("--detach", action="store_true")
    start.add_argument("--offline", action="store_true")
    start.add_argument("--no-open", action="store_true")
    start.add_argument("--web-port", type=int, default=5173)
    start.add_argument("--api-port", type=int, default=8000)
    start.add_argument("--relocate-ports", action="store_true")
    for command in ("stop", "status", "logs"):
        commands.add_parser(command)
    reset = commands.add_parser("reset")
    for target in ("index", "model-cache", "installed-datasets", "archives", "all"):
        reset.add_argument(f"--{target}", action="store_true")
    reset.add_argument("--yes", action="store_true")
    reset.add_argument("--json", action="store_true")
    update = commands.add_parser("update")
    update.add_argument("--yes", action="store_true")
    update.add_argument("--json", action="store_true")
    return parser, reset


def _prepare(layout: RuntimeLayout, args: argparse.Namespace) -> int:
    from .preparation import PreparationError, prepare_model_index

    try:
        with mutation_lock(layout, "prepare"):
            if os.getenv("GODS_EYE_USE_FIXTURES") == "true":
                from .fixture_preparation import prepare_fixture

                layout.initialize()
                prepare_fixture(layout.root, layout.state_path)
                return EXIT_OK
            result = prepare_datasets(
                layout, accept_data_terms=args.accept_data_terms, assume_yes=args.yes
            )
            if result != EXIT_OK:
                return result
            acquisition = layout.read_state().get("preparation", {}).get("dataset_acquisition", {})
            if acquisition.get("status") != "verified":
                print(
                    "Dataset Acquisition must be verified before model and index preparation.",
                    file=sys.stderr,
                )
                return EXIT_PREPARATION_FAILED
            prepare_model_index(
                layout.root,
                layout.state_path,
                vram_mib=preparation_vram_mib(),
                batch_override=args.batch_size,
            )
    except LauncherBusyError as error:
        return render_busy(error)
    except (PreparationError, ValueError) as error:
        print(str(error), file=sys.stderr)
        return EXIT_PREPARATION
    return EXIT_OK


def main(argv: list[str] | None = None) -> int:
    parser, reset_parser = _parser()
    args = parser.parse_args(argv)
    layout = RuntimeLayout(Path(os.getenv("GODS_EYE_PROJECT_ROOT", "/workspace")))
    if args.command == "start":
        if (offered := offer_preparation(layout)) is not None:
            if offered == EXIT_PREPARATION_FAILED:
                print("Preparation was not started.", file=sys.stderr)
            return offered
        try:
            return start_runtime(
                layout,
                detach=args.detach,
                offline=args.offline,
                no_open=args.no_open,
                web_port=args.web_port,
                api_port=args.api_port,
                relocate_ports=args.relocate_ports,
            )
        except LauncherBusyError as error:
            return render_busy(error)
    if args.command in {"stop", "status", "logs"}:
        if args.command != "stop":
            return runtime_passthrough(layout, args.command)
        try:
            with mutation_lock(layout, "stop"):
                return runtime_passthrough(layout, args.command)
        except LauncherBusyError as error:
            return render_busy(error)
    if args.command == "prepare":
        return _prepare(layout, args)
    if args.command == "reset":
        targets = (
            list(RESET_PATHS)
            if args.all
            else [target for target in RESET_PATHS if getattr(args, target)]
        )
        if not targets:
            reset_parser.error(
                "Choose at least one reset target: --index, --model-cache, --installed-datasets, --archives, or --all"
            )
        try:
            return reset_assets(layout, targets, confirmed=args.yes, as_json=args.json)
        except LauncherBusyError as error:
            return render_busy(error, as_json=args.json)
    if args.command == "update":
        try:
            return update_state(layout, apply=args.yes, as_json=args.json)
        except LauncherBusyError as error:
            return render_busy(error, as_json=args.json)
    checks = doctor(layout)
    failed = any(check.status == "fail" for check in checks)
    if args.json:
        print(
            json.dumps(
                {
                    "status": "fail" if failed else "pass",
                    "checks": [asdict(check) for check in checks],
                },
                sort_keys=True,
            )
        )
    else:
        print_human(checks)
    return EXIT_PREREQUISITE if failed else EXIT_OK


if __name__ == "__main__":
    raise SystemExit(main())
