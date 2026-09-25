"""Argument parsing and orchestration for the Docker-only Launcher."""

import argparse
import json
import os
import shutil
import sys
from dataclasses import asdict
from pathlib import Path

from .checkpoint_import import import_checkpoint
from .checkpoint_registry import (
    CheckpointValidationError,
    find_registration,
    read_registrations,
    remove_registration,
)
from .clip_models import DEFAULT_MODEL_ID, ModelRegistry, checkpoint_root_for
from .launcher_assets import prepare_datasets
from .launcher_common import (
    EXIT_CONFIRMATION,
    EXIT_OK,
    EXIT_PREPARATION,
    EXIT_PREPARATION_FAILED,
    EXIT_PREREQUISITE,
    EXIT_USAGE,
    RuntimeLayout,
)
from .launcher_doctor import (
    doctor,
    optional_model_capacity_available,
    preparation_vram_mib,
    print_human,
)
from .launcher_lifecycle import (
    RESET_PATHS,
    LauncherBusyError,
    mutation_lock,
    render_busy,
    reset_assets,
    update_state,
)
from .launcher_runtime import prepared_missing, runtime_passthrough, start_runtime
from .preparation_state import model_preparation


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
    prepare.add_argument(
        "--model-id",
        action="append",
        dest="model_ids",
    )
    prepare.add_argument("--checkpoint", action="append", type=Path, default=[])
    prepare.add_argument("--label")
    prepare.add_argument("--reference-metrics", type=Path)
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
    checkpoint = commands.add_parser("checkpoint")
    checkpoint_commands = checkpoint.add_subparsers(dest="checkpoint_command", required=True)
    checkpoint_list = checkpoint_commands.add_parser("list")
    checkpoint_list.add_argument("--json", action="store_true")
    checkpoint_remove = checkpoint_commands.add_parser("remove")
    checkpoint_remove.add_argument("model_id")
    checkpoint_remove.add_argument("--yes", action="store_true")
    return parser, reset


def _prepare(layout: RuntimeLayout, args: argparse.Namespace) -> int:
    from .preparation import PreparationError, PreparationPaths, prepare_model_index

    checkpoints = args.checkpoint
    requested_model_ids = list(args.model_ids or [])
    model_ids = list(requested_model_ids)
    if not checkpoints and not model_ids:
        model_ids = [DEFAULT_MODEL_ID]
    checkpoint_root = checkpoint_root_for(PreparationPaths(layout.root).model_cache)
    if not checkpoints:
        try:
            for model_id in model_ids:
                PreparationPaths(layout.root).for_model(model_id)
        except ValueError as error:
            print(str(error), file=sys.stderr)
            return EXIT_USAGE
    try:
        with mutation_lock(layout, "prepare"):
            if os.getenv("GODS_EYE_USE_FIXTURES") == "true":
                from .fixture_preparation import prepare_fixture

                layout.initialize()
                prepare_fixture(layout.root, layout.state_path, model_ids=model_ids)
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
            imported = []
            for source in checkpoints:
                try:
                    result = import_checkpoint(
                        source,
                        checkpoint_root=checkpoint_root,
                        label=args.label,
                        reference_metrics=args.reference_metrics,
                    )
                except (CheckpointValidationError, OSError) as error:
                    print(str(error), file=sys.stderr)
                    return EXIT_PREPARATION
                registration = result.registration
                imported.append(registration)
                print(f"Checkpoint {registration.model_id}: {registration.label}")

            for registration in imported:
                model_ids.extend((registration.paired_baseline_id, registration.model_id))
            model_ids = list(dict.fromkeys(model_ids))
            if not model_ids:
                model_ids = [DEFAULT_MODEL_ID]
            try:
                registry = ModelRegistry(checkpoint_root)
                for model_id in model_ids:
                    registry.get(model_id)
            except ValueError as error:
                print(str(error), file=sys.stderr)
                return EXIT_USAGE

            optional_count = 0
            for model_id in model_ids:
                if model_id != DEFAULT_MODEL_ID:
                    optional_count += 1
                    optional_model_capacity_available(layout, optional_count)
                prepare_model_index(
                    layout.root,
                    layout.state_path,
                    vram_mib=preparation_vram_mib(),
                    batch_override=args.batch_size,
                    model_id=model_id,
                )
    except LauncherBusyError as error:
        return render_busy(error)
    except (PreparationError, ValueError) as error:
        print(str(error), file=sys.stderr)
        return EXIT_PREPARATION
    return EXIT_OK


def _checkpoint_rows(layout: RuntimeLayout) -> list[dict[str, object]]:
    from .preparation import PreparationPaths

    checkpoint_root = checkpoint_root_for(PreparationPaths(layout.root).model_cache)
    try:
        state = json.loads(layout.state_path.read_text())
    except FileNotFoundError:
        state = {}
    preparation = state.get("preparation", {})
    if not isinstance(preparation, dict):
        preparation = {}
    rows = []
    for registration, _directory in read_registrations(checkpoint_root):
        model_state = model_preparation(preparation, registration.model_id)
        smoke_test = model_state.get("smoke_test", {})
        evaluation = model_state.get("evaluation", {})
        prepared_status = (
            smoke_test.get("status", "not prepared")
            if isinstance(smoke_test, dict)
            else "not prepared"
        )
        evaluation_status = (
            evaluation.get("status", "not prepared")
            if isinstance(evaluation, dict)
            else "not prepared"
        )
        rows.append(
            {
                "model_id": registration.model_id,
                "label": registration.label,
                "verified": registration.verified,
                "paired_baseline_id": registration.paired_baseline_id,
                "registered_at": registration.registered_at,
                "prepared_status": prepared_status,
                "evaluation_status": evaluation_status,
            }
        )
    return rows


def _list_checkpoints(layout: RuntimeLayout, *, as_json: bool) -> int:
    rows = _checkpoint_rows(layout)
    if as_json:
        print(json.dumps(rows, sort_keys=True))
    else:

        def one_line(value: object) -> str:
            return " ".join(str(value).split())

        for row in rows:
            verified = "verified" if row["verified"] else "unverified"
            print(
                f"{one_line(row['model_id'])} | {one_line(row['label'])} | {verified} | "
                f"paired baseline: {one_line(row['paired_baseline_id'])} | "
                f"registered: {one_line(row['registered_at'])} | "
                f"prepared: {one_line(row['prepared_status'])} | "
                f"evaluation: {one_line(row['evaluation_status'])}"
            )
    return EXIT_OK


def _remove_path(path: Path) -> None:
    if path.is_symlink() or path.is_file():
        path.unlink(missing_ok=True)
    elif path.exists():
        shutil.rmtree(path)


def _remove_checkpoint(layout: RuntimeLayout, model_id: str, *, confirmed: bool) -> int:
    from .preparation import PreparationPaths

    checkpoint_root = checkpoint_root_for(PreparationPaths(layout.root).model_cache)
    with mutation_lock(layout, "checkpoint remove"):
        found = find_registration(checkpoint_root, model_id)
        if found is None:
            print(f"No checkpoint registration found for {model_id!r}.", file=sys.stderr)
            return EXIT_PREPARATION
        registration, _checkpoint_dir = found
        checkpoint_index = PreparationPaths(layout.root).for_model(model_id).index_root
        baseline_index = (
            PreparationPaths(layout.root).for_model(registration.paired_baseline_id).index_root
        )
        if not confirmed:
            if not sys.stdin.isatty():
                print(
                    "Checkpoint removal requires confirmation; rerun with --yes.", file=sys.stderr
                )
                return EXIT_CONFIRMATION
            try:
                answer = input(
                    f"Remove checkpoint {model_id} ({registration.label}) and its indexes? [y/N] "
                )
            except EOFError:
                answer = ""
            if answer.strip().lower() not in {"y", "yes"}:
                print("Checkpoint removal cancelled; no assets were deleted.")
                return EXIT_OK

        remove_registration(checkpoint_root, model_id)
        _remove_path(checkpoint_index)
        remaining = read_registrations(checkpoint_root)
        baseline_referenced = any(
            candidate.paired_baseline_id == registration.paired_baseline_id
            for candidate, _path in remaining
        )

        state = layout.read_state()
        preparation = state.setdefault("preparation", {})
        models = preparation.get("models", {})
        if isinstance(models, dict):
            models.pop(model_id, None)
            if not baseline_referenced:
                models.pop(registration.paired_baseline_id, None)
        if not baseline_referenced:
            _remove_path(baseline_index)
        layout.write_state(state)
    print(f"Removed checkpoint {model_id}.")
    return EXIT_OK


def main(argv: list[str] | None = None) -> int:
    parser, reset_parser = _parser()
    args = parser.parse_args(argv)
    if args.command == "prepare":
        checkpoint_count = len(args.checkpoint)
        if args.label is not None and checkpoint_count != 1:
            parser.error("--label requires exactly one --checkpoint")
        if args.reference_metrics is not None and checkpoint_count != 1:
            parser.error("--reference-metrics requires exactly one --checkpoint")
        if checkpoint_count and os.getenv("GODS_EYE_USE_FIXTURES") == "true":
            parser.error("--checkpoint cannot be used with fixture preparation")
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
    if args.command == "checkpoint":
        if args.checkpoint_command == "list":
            return _list_checkpoints(layout, as_json=args.json)
        try:
            return _remove_checkpoint(layout, args.model_id, confirmed=args.yes)
        except LauncherBusyError as error:
            return render_busy(error)
        except (CheckpointValidationError, OSError, ValueError) as error:
            print(str(error), file=sys.stderr)
            return EXIT_PREPARATION
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
