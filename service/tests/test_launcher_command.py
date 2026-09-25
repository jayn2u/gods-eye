import json
import os
import shutil
import subprocess
import sys
import uuid
from pathlib import Path

import pytest
from gods_eye.launcher_doctor import required_capacity_bytes

ROOT = Path(__file__).parents[2]


def _checkpoint_registration(weights_character: str, label: str):
    from gods_eye.checkpoint_registry import Registration, checkpoint_model_id
    from gods_eye.clip_models import OpenClipArch

    weights_sha256 = weights_character * 64
    source_character = "c" if weights_character == "a" else "d"
    return Registration(
        model_id=checkpoint_model_id(weights_sha256),
        label=label,
        weights_sha256=weights_sha256,
        source_sha256=source_character * 64,
        source_filename=f"{label}.pt",
        arch=OpenClipArch("ViT-B-16", "openai", 384, 128, "reid"),
        verified=True,
        registered_at="2026-09-25T00:00:00+00:00",
        provenance={},
        reference_metrics=None,
    )


def _fake_docker(bin_dir: Path) -> None:
    executable = bin_dir / "docker"
    executable.write_text(
        f"#!{sys.executable}\n"
        + """
import os
import subprocess
import sys
from pathlib import Path

args = sys.argv[1:]
failures = set(os.getenv("GODS_EYE_FAKE_DOCKER_FAILURES", "").split(","))
docker_log = os.getenv("GODS_EYE_FAKE_DOCKER_LOG")
if docker_log:
    with Path(docker_log).open("a") as stream:
        stream.write(__import__("json").dumps(args) + "\\n")
if args == ["--version"]:
    print("Docker version 27.5.1")
elif args[:2] == ["info", "--format"] and "ClientInfo.Plugins" in args[2]:
    print("/plugins/docker-compose")
elif args[:1] == ["info"]:
    if "info" in failures:
        raise SystemExit(1)
    print("27.5.1")
elif args[:2] == ["compose", "version"]:
    if "compose" in failures:
        raise SystemExit(1)
    print("2.32.4")
elif "build" in args and args[-1] == "launcher":
    raise SystemExit(0)
elif args[:2] == ["image", "inspect"]:
    raise SystemExit(1 if os.getenv("GODS_EYE_FAKE_SERVICE_IMAGE_MISSING") == "1" else 0)
elif args[:1] == ["build"]:
    print(os.getenv("GODS_EYE_FAKE_SERVICE_BUILD_ERROR", ""), file=sys.stderr)
    raise SystemExit(int(os.getenv("GODS_EYE_FAKE_SERVICE_BUILD_EXIT", "0")))
elif args[:1] == ["run"] and "gods-eye-datasets" in args:
    if "--skip-manifest" not in args:
        raise SystemExit(98)
    project = Path(os.environ["GODS_EYE_PROJECT_ROOT"])
    marker = project / ".fake-installer-interrupted"
    part = project / "data/archives/CUHK-PEDES.zip.part"
    if os.getenv("GODS_EYE_FAKE_INSTALLER_INTERRUPT_ONCE") == "1" and not marker.exists():
        marker.write_text("interrupted")
        part.parent.mkdir(parents=True, exist_ok=True)
        part.write_bytes(b"resumable")
        raise SystemExit(130)
    if part.exists():
        part.unlink()
    print(os.getenv("GODS_EYE_FAKE_INSTALLER_OUTPUT", ""))
    raise SystemExit(int(os.getenv("GODS_EYE_FAKE_INSTALLER_EXIT", "0")))
elif args[:1] == ["run"]:
    if "gpu" in failures:
        raise SystemExit(1)
    print(os.getenv("GODS_EYE_FAKE_GPU", "NVIDIA RTX 4090, 24564, 555.42.02"))
elif "run" in args and "launcher" in args:
    command = args[args.index("launcher") + 1 :]
    raise SystemExit(subprocess.call(
        [sys.executable, "-m", "gods_eye.launcher", *command], env=os.environ
    ))
else:
    print(f"unexpected fake docker invocation: {args}", file=sys.stderr)
    raise SystemExit(97)
"""
    )
    executable.chmod(0o755)


def _fake_preparation_runner(bin_dir: Path) -> Path:
    executable = bin_dir / "prepare-runner"
    executable.write_text(
        f"#!{sys.executable}\n"
        + """
import json
import os
from pathlib import Path
import sys

args = sys.argv[1:]
log = Path(os.environ["GODS_EYE_FAKE_PREPARE_LOG"])
with log.open("a") as stream:
    stream.write(json.dumps(args) + "\\n")
operation = args[0]
root = Path(os.environ["GODS_EYE_PROJECT_ROOT"])
plan = Path(os.getenv("GODS_EYE_FAKE_PREPARE_PLAN", ""))
failures = json.loads(plan.read_text()) if plan.is_file() else {}
remaining = failures.get(operation, [])
if remaining:
    outcome = remaining.pop(0)
    failures[operation] = remaining
    # Persist outcomes because each invocation is a fresh process.
    plan.write_text(json.dumps(failures))
    if outcome == "oom":
        print("CUDA out of memory", file=sys.stderr)
        raise SystemExit(75)
    if outcome == "fail":
        print("terminal adapter failure", file=sys.stderr)
        raise SystemExit(1)
if operation == "prepare-model":
    model_id = args[args.index("--model-id") + 1]
    path = root / ".cache/huggingface" / (model_id.rsplit("/", 1)[-1] + ".ready")
elif operation == "verify-model":
    model_id = args[args.index("--model-id") + 1]
    path = root / ".cache/huggingface" / (model_id.rsplit("/", 1)[-1] + ".ready")
elif operation == "build-manifest":
    path = root / "indexes/gallery-manifest.json"
elif operation == "verify-manifest":
    path = Path(args[1])
elif operation == "build-index":
    path = Path(args[args.index("--versions-dir") + 1]) / "test-version"
elif operation == "validate-index":
    path = Path(args[1])
elif operation == "activate-index":
    path = Path(args[args.index("--active-pointer") + 1])
elif operation == "verify-index":
    path = Path(args[1])
elif operation == "smoke-search":
    path = Path(args[1])
elif operation == "build-benchmark-queries":
    path = Path(args[args.index("--output") + 1])
elif operation == "evaluate":
    path = Path(args[args.index("--output") + 1])
else:
    raise SystemExit(64)
if operation == "build-index":
    path.mkdir(parents=True, exist_ok=True)
elif operation in {"validate-index", "verify-index", "verify-model", "verify-manifest", "smoke-search"}:
    if not path.exists():
        raise SystemExit(1)
else:
    path.parent.mkdir(parents=True, exist_ok=True)
    if operation == "activate-index":
        path.write_text(str(Path(args[1]).relative_to(path.parent)) + "\\n")
    elif operation == "build-benchmark-queries":
        path.write_text(json.dumps({"manifest_sha256": "b" * 64, "queries": []}) + "\\n")
    elif operation == "evaluate":
        from gods_eye.benchmark import Evaluation, write_evaluation

        active = Path(args[1])
        version_id = (active.parent / active.read_text().strip()).name
        write_evaluation(
            path,
            Evaluation(
                model_id=args[args.index("--model-id") + 1],
                index_version=version_id,
                model_revision=args[args.index("--revision") + 1],
                created_at="2026-09-25T00:00:00+00:00",
                query_count=1,
                gallery_count=1,
                metrics={"top1": 1.0, "top5": 1.0, "top10": 1.0, "mAP": 1.0, "mINP": 1.0},
                benchmark_query_ranks={},
                reference=None,
            ),
        )
    else:
        path.write_text("ok")
if operation in {"prepare-model", "verify-model"}:
    print(json.dumps({"model_id": model_id, "resolved_revision": "a" * 40}, separators=(",", ":")))
elif operation == "verify-manifest":
    print("b" * 64)
elif operation == "verify-index":
    print((path.parent / path.read_text().strip()).name)
else:
    print(path)
"""
    )
    executable.chmod(0o755)
    return executable


def _prepare_env(tmp_path: Path) -> tuple[dict[str, str], Path]:
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    _fake_docker(bin_dir)
    runner = _fake_preparation_runner(bin_dir)
    project_dir = tmp_path / "project"
    project_dir.mkdir()
    log = tmp_path / "prepare-calls.jsonl"
    env = {
        **os.environ,
        "PATH": f"{bin_dir}:{os.environ['PATH']}",
        "PYTHONPATH": str(ROOT / "service"),
        "GODS_EYE_PROJECT_ROOT": str(project_dir),
        "GODS_EYE_PREPARATION_RUNNER": str(runner),
        "GODS_EYE_FAKE_PREPARE_LOG": str(log),
        "GODS_EYE_GPU_VRAM_MIB": "24564",
        "GODS_EYE_DOCTOR_SYSTEM": "Linux",
        "GODS_EYE_DOCTOR_MACHINE": "x86_64",
        "GODS_EYE_DOCTOR_FREE_BYTES": str(40 * 1024**3),
        "GODS_EYE_DOCTOR_PORTS_AVAILABLE": "1",
    }
    return env, log


def test_prepare_label_requires_exactly_one_checkpoint(capsys: pytest.CaptureFixture[str]) -> None:
    from gods_eye.launcher_cli import main

    with pytest.raises(SystemExit) as error:
        main(
            [
                "prepare",
                "--checkpoint",
                "first.pt",
                "--checkpoint",
                "second.pt",
                "--label",
                "candidate",
            ]
        )

    assert error.value.code == 64
    assert "exactly one --checkpoint" in capsys.readouterr().err


def test_prepare_imports_before_preparing_deduplicated_requested_models(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    from types import SimpleNamespace

    import gods_eye.launcher_cli as launcher
    from gods_eye.checkpoint_registry import write_registration
    from gods_eye.clip_models import DEFAULT_MODEL_ID, checkpoint_root_for

    registration = _checkpoint_registration("a", "candidate A")
    project = tmp_path / "project"
    source = tmp_path / "candidate.pt"
    source.write_bytes(b"checkpoint fixture")
    monkeypatch.setenv("GODS_EYE_PROJECT_ROOT", str(project))
    monkeypatch.delenv("GODS_EYE_USE_FIXTURES", raising=False)
    events: list[str] = []

    def prepare_datasets(layout, **_kwargs):
        events.append("datasets")
        state = layout.read_state()
        state.setdefault("preparation", {})["dataset_acquisition"] = {"status": "verified"}
        layout.write_state(state)
        return launcher.EXIT_OK

    def import_checkpoint(source_path, *, checkpoint_root, **_kwargs):
        events.append(f"import:{source_path.name}")
        write_registration(checkpoint_root, registration)
        return SimpleNamespace(registration=registration)

    def prepare_model_index(_root, _state_path, *, model_id, **_kwargs):
        events.append(f"prepare:{model_id}")

    monkeypatch.setattr(launcher, "prepare_datasets", prepare_datasets)
    monkeypatch.setattr(launcher, "import_checkpoint", import_checkpoint, raising=False)
    monkeypatch.setattr("gods_eye.preparation.prepare_model_index", prepare_model_index)
    monkeypatch.setattr(launcher, "optional_model_capacity_available", lambda *_args: None)
    monkeypatch.setattr(launcher, "preparation_vram_mib", lambda: 16384)

    result = launcher.main(
        [
            "prepare",
            "--checkpoint",
            str(source),
            "--model-id",
            registration.model_id,
            "--model-id",
            registration.paired_baseline_id,
            "--model-id",
            DEFAULT_MODEL_ID,
        ]
    )

    assert result == launcher.EXIT_OK
    assert events == [
        "datasets",
        "import:candidate.pt",
        f"prepare:{registration.model_id}",
        f"prepare:{registration.paired_baseline_id}",
        f"prepare:{DEFAULT_MODEL_ID}",
    ]
    output = capsys.readouterr().out
    assert registration.model_id in output
    assert registration.label in output
    assert checkpoint_root_for(project / ".cache" / "huggingface").is_dir()


def test_prepare_rejects_checkpoint_import_in_fixture_mode(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    from gods_eye.launcher_cli import EXIT_USAGE, main

    source = tmp_path / "candidate.pt"
    source.write_bytes(b"checkpoint fixture")
    monkeypatch.setenv("GODS_EYE_USE_FIXTURES", "true")
    monkeypatch.setenv("GODS_EYE_PROJECT_ROOT", str(tmp_path / "project"))

    with pytest.raises(SystemExit) as error:
        main(["prepare", "--checkpoint", str(source)])

    assert error.value.code == EXIT_USAGE
    assert "fixture" in capsys.readouterr().err.lower()
    assert not (tmp_path / "project" / ".gods-eye" / "state.json").exists()


def test_prepare_import_error_stops_before_model_preparation(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    import gods_eye.launcher_cli as launcher

    project = tmp_path / "project"
    source = tmp_path / "invalid.pt"
    source.write_bytes(b"invalid")
    monkeypatch.setenv("GODS_EYE_PROJECT_ROOT", str(project))
    monkeypatch.delenv("GODS_EYE_USE_FIXTURES", raising=False)
    events: list[str] = []

    def prepare_datasets(layout, **_kwargs):
        state = layout.read_state()
        state.setdefault("preparation", {})["dataset_acquisition"] = {"status": "verified"}
        layout.write_state(state)
        events.append("datasets")
        return launcher.EXIT_OK

    def import_checkpoint(*_args, **_kwargs):
        events.append("import")
        raise OSError("checkpoint file could not be read")

    def prepare_model_index(*_args, **_kwargs):
        events.append("prepare")

    monkeypatch.setattr(launcher, "prepare_datasets", prepare_datasets)
    monkeypatch.setattr(launcher, "import_checkpoint", import_checkpoint, raising=False)
    monkeypatch.setattr("gods_eye.preparation.prepare_model_index", prepare_model_index)

    result = launcher.main(["prepare", "--checkpoint", str(source)])

    assert result == launcher.EXIT_PREPARATION
    assert events == ["datasets", "import"]
    assert "checkpoint file could not be read" in capsys.readouterr().err


def test_checkpoint_list_json_and_human_output_show_preparation_status(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    from gods_eye.checkpoint_registry import write_registration
    from gods_eye.clip_models import checkpoint_root_for
    from gods_eye.launcher_cli import EXIT_OK, main

    registration = _checkpoint_registration("a", "candidate\nA")
    project = tmp_path / "project"
    checkpoint_root = checkpoint_root_for(project / ".cache" / "huggingface")
    write_registration(checkpoint_root, registration)
    state_path = project / ".gods-eye" / "state.json"
    state_path.parent.mkdir(parents=True)
    state_path.write_text(
        json.dumps(
            {
                "schema_version": 2,
                "preparation": {
                    "models": {
                        registration.model_id: {
                            "smoke_test": {"status": "verified"},
                            "evaluation": {"status": "verified"},
                        }
                    }
                },
            }
        )
    )
    monkeypatch.setenv("GODS_EYE_PROJECT_ROOT", str(project))

    assert main(["checkpoint", "list", "--json"]) == EXIT_OK
    rows = json.loads(capsys.readouterr().out)
    assert rows == [
        {
            "model_id": registration.model_id,
            "label": registration.label,
            "verified": True,
            "paired_baseline_id": registration.paired_baseline_id,
            "registered_at": registration.registered_at,
            "prepared_status": "verified",
            "evaluation_status": "verified",
        }
    ]

    assert main(["checkpoint", "list"]) == EXIT_OK
    lines = capsys.readouterr().out.splitlines()
    assert len(lines) == 1
    assert registration.model_id in lines[0]
    assert "candidate A" in lines[0]
    assert registration.paired_baseline_id in lines[0]


def test_checkpoint_list_without_registrations_prints_empty_array_without_state(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    from gods_eye.launcher_cli import EXIT_OK, main

    project = tmp_path / "project"
    monkeypatch.setenv("GODS_EYE_PROJECT_ROOT", str(project))

    assert main(["checkpoint", "list", "--json"]) == EXIT_OK

    assert capsys.readouterr().out == "[]\n"
    assert not (project / ".gods-eye" / "state.json").exists()


def test_checkpoint_remove_preserves_shared_baseline_until_last_reference(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from gods_eye.checkpoint_registry import find_registration, write_registration
    from gods_eye.clip_models import ModelRegistry, checkpoint_root_for
    from gods_eye.launcher_cli import EXIT_OK, main

    project = tmp_path / "project"
    checkpoint_root = checkpoint_root_for(project / ".cache" / "huggingface")
    registrations = (
        _checkpoint_registration("a", "candidate A"),
        _checkpoint_registration("b", "candidate B"),
    )
    for registration in registrations:
        write_registration(checkpoint_root, registration)

    first, second = registrations
    baseline = ModelRegistry(checkpoint_root).get(first.paired_baseline_id)
    checkpoint_indexes = {
        registration.model_id: project
        / "indexes"
        / "models"
        / registration.to_spec(checkpoint_root / registration.weights_sha256).storage_key
        for registration in registrations
    }
    baseline_index = project / "indexes" / "models" / baseline.storage_key
    for index_root in (*checkpoint_indexes.values(), baseline_index):
        (index_root / "evaluations").mkdir(parents=True)
        (index_root / "evaluations" / "result.json").write_text("{}")
    hf_snapshot = project / ".cache" / "huggingface" / "models--keep-me" / "snapshots" / "abc"
    hf_snapshot.mkdir(parents=True)
    (hf_snapshot / "config.json").write_text("{}")

    state_path = project / ".gods-eye" / "state.json"
    state_path.parent.mkdir(parents=True)
    state_path.write_text(
        json.dumps(
            {
                "schema_version": 2,
                "preparation": {
                    "models": {
                        first.model_id: {"evaluation": {"status": "verified"}},
                        second.model_id: {"evaluation": {"status": "verified"}},
                        first.paired_baseline_id: {"evaluation": {"status": "verified"}},
                    }
                },
            }
        )
    )
    monkeypatch.setenv("GODS_EYE_PROJECT_ROOT", str(project))

    assert main(["checkpoint", "remove", first.model_id, "--yes"]) == EXIT_OK
    state = json.loads(state_path.read_text())
    assert find_registration(checkpoint_root, first.model_id) is None
    assert not checkpoint_indexes[first.model_id].exists()
    assert (checkpoint_indexes[second.model_id] / "evaluations" / "result.json").is_file()
    assert (baseline_index / "evaluations" / "result.json").is_file()
    assert first.model_id not in state["preparation"]["models"]
    assert first.paired_baseline_id in state["preparation"]["models"]
    assert (hf_snapshot / "config.json").is_file()

    assert main(["checkpoint", "remove", second.model_id, "--yes"]) == EXIT_OK
    state = json.loads(state_path.read_text())
    assert not baseline_index.exists()
    assert first.paired_baseline_id not in state["preparation"]["models"]
    assert (hf_snapshot / "config.json").is_file()


def test_checkpoint_remove_requires_confirmation_in_non_tty(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    from types import SimpleNamespace

    import gods_eye.launcher_cli as launcher
    from gods_eye.checkpoint_registry import find_registration, write_registration
    from gods_eye.clip_models import checkpoint_root_for

    registration = _checkpoint_registration("a", "candidate A")
    project = tmp_path / "project"
    checkpoint_root = checkpoint_root_for(project / ".cache" / "huggingface")
    write_registration(checkpoint_root, registration)
    monkeypatch.setenv("GODS_EYE_PROJECT_ROOT", str(project))
    monkeypatch.setattr(launcher.sys, "stdin", SimpleNamespace(isatty=lambda: False))

    result = launcher.main(["checkpoint", "remove", registration.model_id])

    assert result == launcher.EXIT_CONFIRMATION
    assert find_registration(checkpoint_root, registration.model_id) is not None
    assert "--yes" in capsys.readouterr().err


def test_checkpoint_remove_prompts_on_tty_and_keeps_assets_when_cancelled(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    from types import SimpleNamespace

    import gods_eye.launcher_cli as launcher
    from gods_eye.checkpoint_registry import find_registration, write_registration
    from gods_eye.clip_models import checkpoint_root_for

    registration = _checkpoint_registration("a", "candidate A")
    project = tmp_path / "project"
    checkpoint_root = checkpoint_root_for(project / ".cache" / "huggingface")
    write_registration(checkpoint_root, registration)
    monkeypatch.setenv("GODS_EYE_PROJECT_ROOT", str(project))
    monkeypatch.setattr(launcher.sys, "stdin", SimpleNamespace(isatty=lambda: True))
    prompts: list[str] = []
    monkeypatch.setattr("builtins.input", lambda prompt: prompts.append(prompt) or "no")

    result = launcher.main(["checkpoint", "remove", registration.model_id])

    assert result == launcher.EXIT_OK
    assert len(prompts) == 1
    assert registration.model_id in prompts[0]
    assert find_registration(checkpoint_root, registration.model_id) is not None
    assert "cancelled" in capsys.readouterr().out


def test_prepare_requires_separate_dataset_terms_acceptance(tmp_path: Path) -> None:
    env, log = _prepare_env(tmp_path)

    result = subprocess.run(
        [str(ROOT / "gods-eye"), "prepare", "--yes"],
        cwd=ROOT,
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 3
    assert "official source" in result.stdout.lower()
    assert "mirror" in result.stdout.lower()
    assert "sensitive" in result.stdout.lower()
    assert "--accept-data-terms" in result.stderr
    assert not log.exists()


def test_prepare_acquires_datasets_without_building_the_manifest(tmp_path: Path) -> None:
    env, log = _prepare_env(tmp_path)

    result = subprocess.run(
        [str(ROOT / "gods-eye"), "prepare", "--yes", "--accept-data-terms"],
        cwd=ROOT,
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    state = json.loads((Path(env["GODS_EYE_PROJECT_ROOT"]) / ".gods-eye/state.json").read_text())
    assert state["preparation"]["dataset_acquisition"]["status"] == "verified"
    assert state["preparation"]["gallery_manifest"]["status"] == "verified"
    assert state["preparation"]["smoke_test"]["status"] == "verified"
    operations = [json.loads(line)[0] for line in log.read_text().splitlines()]
    assert operations[-1] == "smoke-search"
    assert "Stage 3/8" in result.stdout
    assert log.exists()


def test_prepare_builds_from_container_project_and_mounts_host_storage(tmp_path: Path) -> None:
    env, _ = _prepare_env(tmp_path)
    docker_log = tmp_path / "docker-calls.jsonl"
    host_root = ROOT
    env.update(
        GODS_EYE_FAKE_DOCKER_LOG=str(docker_log),
        GODS_EYE_FAKE_SERVICE_IMAGE_MISSING="1",
    )

    result = subprocess.run(
        [str(ROOT / "gods-eye"), "prepare", "--yes", "--accept-data-terms"],
        cwd=ROOT,
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    calls = [json.loads(line) for line in docker_log.read_text().splitlines()]
    service_build = next(call for call in calls if call[:1] == ["build"])
    container_root = Path(env["GODS_EYE_PROJECT_ROOT"])
    assert service_build == [
        "build",
        "--file",
        str(container_root / "Dockerfile.service"),
        "--tag",
        "gods-eye-service:local",
        str(container_root),
    ]
    acquisition = next(call for call in calls if "gods-eye-datasets" in call)
    assert f"{host_root / 'data'}:/data:rw" in acquisition
    assert f"{host_root / 'indexes'}:/indexes:rw" in acquisition


def test_prepare_service_build_failure_preserves_safe_diagnostic_log(tmp_path: Path) -> None:
    env, _ = _prepare_env(tmp_path)
    secret = "hf_private-value"
    env.update(
        GODS_EYE_FAKE_SERVICE_IMAGE_MISSING="1",
        GODS_EYE_FAKE_SERVICE_BUILD_EXIT="9",
        GODS_EYE_FAKE_SERVICE_BUILD_ERROR=f"access_token={secret} build context rejected",
    )

    result = subprocess.run(
        [str(ROOT / "gods-eye"), "prepare", "--yes", "--accept-data-terms"],
        cwd=ROOT,
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 4
    assert "Log:" in result.stderr
    logs = list((Path(env["GODS_EYE_PROJECT_ROOT"]) / ".gods-eye/logs").glob("prepare-*.log"))
    assert len(logs) == 1
    diagnostic = logs[0].read_text()
    assert "docker build" in diagnostic
    assert "build context rejected" in diagnostic
    assert "[REDACTED]" in diagnostic
    assert secret not in diagnostic


@pytest.mark.integration
def test_real_launcher_builds_service_from_container_project_path() -> None:
    if os.getenv("RUN_PREPARATION_BUILD_SMOKE") != "1":
        pytest.skip("set RUN_PREPARATION_BUILD_SMOKE=1 to build through the Launcher container")
    if shutil.which("docker") is None:
        pytest.skip("Docker CLI is not installed")
    identity = uuid.uuid4().hex
    image = f"gods-eye-service:path-smoke-{identity}"
    container = f"gods-eye-path-smoke-{identity}"
    try:
        result = subprocess.run(
            [
                "docker",
                "compose",
                "--profile",
                "tools",
                "run",
                "--rm",
                "--no-deps",
                "--name",
                container,
                "--entrypoint",
                "docker",
                "launcher",
                "build",
                "--file",
                "/workspace/Dockerfile.service",
                "--tag",
                image,
                "/workspace",
            ],
            cwd=ROOT,
            text=True,
            capture_output=True,
            check=False,
            timeout=600,
        )
        assert result.returncode == 0, result.stderr
    finally:
        subprocess.run(
            ["docker", "rm", "-f", container], check=False, capture_output=True, text=True
        )
        subprocess.run(
            ["docker", "image", "rm", "-f", image],
            check=False,
            capture_output=True,
            text=True,
        )


def test_prepare_does_not_declare_prepared_when_real_search_smoke_fails(tmp_path: Path) -> None:
    env, log = _prepare_env(tmp_path)
    plan = tmp_path / "plan.json"
    plan.write_text(json.dumps({"smoke-search": ["fail"]}))
    env["GODS_EYE_FAKE_PREPARE_PLAN"] = str(plan)

    result = subprocess.run(
        [str(ROOT / "gods-eye"), "prepare", "--yes", "--accept-data-terms"],
        cwd=ROOT,
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )

    state = json.loads((Path(env["GODS_EYE_PROJECT_ROOT"]) / ".gods-eye/state.json").read_text())
    assert result.returncode == 1
    assert "smoke" in result.stderr.lower() or "adapter failure" in result.stderr.lower()
    assert "smoke_test" not in state["preparation"]
    assert json.loads(log.read_text().splitlines()[-1])[0] == "smoke-search"


def test_cancelled_dataset_acquisition_resumes_with_saved_acceptance(tmp_path: Path) -> None:
    env, _ = _prepare_env(tmp_path)
    env["GODS_EYE_FAKE_INSTALLER_INTERRUPT_ONCE"] = "1"

    interrupted = subprocess.run(
        [str(ROOT / "gods-eye"), "prepare", "--yes", "--accept-data-terms"],
        cwd=ROOT,
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )
    assert interrupted.returncode == 130
    project = Path(env["GODS_EYE_PROJECT_ROOT"])
    assert (project / "data/archives/CUHK-PEDES.zip.part").read_bytes() == b"resumable"

    resumed = subprocess.run(
        [str(ROOT / "gods-eye"), "prepare", "--yes"],
        cwd=ROOT,
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )
    assert resumed.returncode == 0, resumed.stderr
    assert "Using dataset terms acceptance" in resumed.stdout
    assert not (project / "data/archives/CUHK-PEDES.zip.part").exists()


def test_prepare_does_not_run_downstream_without_verified_acquisition(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from gods_eye import launcher

    project = tmp_path / "project"
    project.mkdir()
    runner_log = tmp_path / "runner.log"
    monkeypatch.setenv("GODS_EYE_PROJECT_ROOT", str(project))
    monkeypatch.setenv("GODS_EYE_FAKE_PREPARE_LOG", str(runner_log))
    monkeypatch.setattr(launcher, "prepare_datasets", lambda *args, **kwargs: launcher.EXIT_OK)

    result = launcher.main(["prepare", "--yes", "--accept-data-terms"])

    assert result == launcher.EXIT_PREPARATION_FAILED
    assert not runner_log.exists()


def test_operator_can_verify_a_supported_workstation_as_json(tmp_path: Path) -> None:
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    _fake_docker(bin_dir)
    project_dir = tmp_path / "project"
    project_dir.mkdir()
    env = {
        **os.environ,
        "PATH": f"{bin_dir}:{os.environ['PATH']}",
        "PYTHONPATH": str(ROOT / "service"),
        "GODS_EYE_PROJECT_ROOT": str(project_dir),
        "GODS_EYE_DOCTOR_SYSTEM": "Linux",
        "GODS_EYE_DOCTOR_MACHINE": "x86_64",
        "GODS_EYE_DOCTOR_FREE_BYTES": str(40 * 1024**3),
        "GODS_EYE_DOCTOR_PORTS_AVAILABLE": "1",
    }

    result = subprocess.run(
        [str(ROOT / "gods-eye"), "doctor", "--json"],
        cwd=ROOT,
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    report = json.loads(result.stdout)
    assert report["status"] == "pass"
    assert {check["name"] for check in report["checks"]} == {
        "platform",
        "docker-daemon",
        "compose",
        "nvidia-driver",
        "container-gpu",
        "vram",
        "storage-writable",
        "storage-capacity",
        "web-port",
        "api-port",
    }
    assert not (project_dir / ".gods-eye").exists()


def test_doctor_reports_a_missing_project_root_instead_of_crashing(tmp_path: Path) -> None:
    """Doctor is what an operator runs when things are broken; it must not crash."""

    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    _fake_docker(bin_dir)
    # A root the Launcher cannot create, mirroring a container-only path such
    # as /workspace when the Launcher runs outside its container.
    blocker = tmp_path / "not-a-directory"
    blocker.write_text("")
    env = {
        **os.environ,
        "PATH": f"{bin_dir}:{os.environ['PATH']}",
        "PYTHONPATH": str(ROOT / "service"),
        "GODS_EYE_PROJECT_ROOT": str(blocker / "root"),
    }
    env.pop("GODS_EYE_DOCTOR_FREE_BYTES", None)

    result = subprocess.run(
        [sys.executable, "-m", "gods_eye.launcher", "doctor", "--json"],
        cwd=ROOT,
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )

    assert "Traceback" not in result.stderr, result.stderr
    report = json.loads(result.stdout)
    capacity = next(check for check in report["checks"] if check["name"] == "storage-capacity")
    assert capacity["status"] == "fail"
    assert capacity["guidance"]


def test_doctor_reports_all_prerequisite_failures_with_guidance(tmp_path: Path) -> None:
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    _fake_docker(bin_dir)
    project_dir = tmp_path / "project"
    project_dir.mkdir()
    env = {
        **os.environ,
        "PATH": f"{bin_dir}:{os.environ['PATH']}",
        "PYTHONPATH": str(ROOT / "service"),
        "GODS_EYE_PROJECT_ROOT": str(project_dir),
        "GODS_EYE_DOCTOR_SYSTEM": "Darwin",
        "GODS_EYE_DOCTOR_MACHINE": "arm64",
        "GODS_EYE_DOCTOR_FREE_BYTES": "1",
        "GODS_EYE_DOCTOR_PORTS_AVAILABLE": "0",
        "GODS_EYE_FAKE_DOCKER_FAILURES": "info,compose,gpu",
    }

    result = subprocess.run(
        [str(ROOT / "gods-eye"), "doctor"],
        cwd=ROOT,
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 2
    for check_name in (
        "platform",
        "docker-daemon",
        "compose",
        "nvidia-driver",
        "container-gpu",
        "vram",
        "storage-capacity",
        "web-port",
        "api-port",
    ):
        assert check_name in result.stdout
    assert result.stdout.count("Fix:") >= 7


def test_doctor_does_not_create_or_migrate_launcher_state(tmp_path: Path) -> None:
    env, _ = _prepare_env(tmp_path)
    project = Path(env["GODS_EYE_PROJECT_ROOT"])

    result = subprocess.run(
        [str(ROOT / "gods-eye"), "doctor", "--json"],
        cwd=ROOT,
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    assert not (project / ".gods-eye/state.json").exists()


def test_doctor_enforces_the_eight_gibibyte_vram_floor(tmp_path: Path) -> None:
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    _fake_docker(bin_dir)
    project_dir = tmp_path / "project"
    project_dir.mkdir()
    env = {
        **os.environ,
        "PATH": f"{bin_dir}:{os.environ['PATH']}",
        "PYTHONPATH": str(ROOT / "service"),
        "GODS_EYE_PROJECT_ROOT": str(project_dir),
        "GODS_EYE_DOCTOR_SYSTEM": "Linux",
        "GODS_EYE_DOCTOR_MACHINE": "x86_64",
        "GODS_EYE_DOCTOR_FREE_BYTES": str(40 * 1024**3),
        "GODS_EYE_DOCTOR_PORTS_AVAILABLE": "1",
        "GODS_EYE_FAKE_GPU": "NVIDIA RTX A2000, 6144, 555.42.02",
    }

    result = subprocess.run(
        [str(ROOT / "gods-eye"), "doctor", "--json"],
        cwd=ROOT,
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 2
    checks = {check["name"]: check for check in json.loads(result.stdout)["checks"]}
    assert checks["container-gpu"]["status"] == "pass"
    assert checks["nvidia-driver"]["status"] == "pass"
    assert checks["vram"] == {
        "name": "vram",
        "status": "fail",
        "detail": "6144 MiB available; 8192 MiB required",
        "guidance": "Use an NVIDIA GPU with at least 8 GB VRAM.",
    }


def test_launcher_uses_a_stable_exit_code_for_an_unknown_command(tmp_path: Path) -> None:
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    _fake_docker(bin_dir)
    env = {
        **os.environ,
        "PATH": f"{bin_dir}:{os.environ['PATH']}",
        "PYTHONPATH": str(ROOT / "service"),
        "GODS_EYE_PROJECT_ROOT": str(tmp_path),
    }

    result = subprocess.run(
        [str(ROOT / "gods-eye"), "unknown-command"],
        cwd=ROOT,
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 64
    assert "invalid choice" in result.stderr


def test_prepare_builds_and_reuses_compatible_model_manifest_and_index(tmp_path: Path) -> None:
    env, call_log = _prepare_env(tmp_path)

    first = subprocess.run(
        [str(ROOT / "gods-eye"), "prepare", "--accept-data-terms"],
        cwd=ROOT,
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )
    second = subprocess.run(
        [str(ROOT / "gods-eye"), "prepare"],
        cwd=ROOT,
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )

    assert first.returncode == 0, first.stderr
    assert "Stage 4/8 — CLIP ViT-B/16 model preparation (elapsed" in first.stdout
    assert "Stage 5/8 — Gallery Manifest generation (elapsed" in first.stdout
    assert "Stage 6/8 — GPU index build and atomic activation (elapsed" in first.stdout
    assert "Stage 7/8 — benchmark evaluation (elapsed" in first.stdout
    assert "Stage 8/8 — real-search smoke test (elapsed" in first.stdout
    assert "estimate measuring" in first.stdout
    assert "Detailed preparation log:" in first.stdout
    assert second.returncode == 0, second.stderr
    assert second.stdout.count("reused (verified)") == 5
    calls = [json.loads(line) for line in call_log.read_text().splitlines()]
    first_build = next(call for call in calls if call[0] == "build-index")
    assert first_build[first_build.index("--batch-size") + 1] == "64"
    assert [call[0] for call in calls] == [
        "prepare-model",
        "build-manifest",
        "verify-manifest",
        "build-index",
        "validate-index",
        "activate-index",
        "build-benchmark-queries",
        "evaluate",
        "smoke-search",
        "verify-model",
        "verify-manifest",
        "verify-index",
        "smoke-search",
    ]
    state = json.loads((Path(env["GODS_EYE_PROJECT_ROOT"]) / ".gods-eye/state.json").read_text())
    assert state["preparation"]["model"]["model_id"] == "openai/clip-vit-base-patch16"
    assert state["preparation"]["gallery_manifest"]["status"] == "verified"
    assert state["preparation"]["index"]["status"] == "active"
    detailed_logs = list(
        (Path(env["GODS_EYE_PROJECT_ROOT"]) / ".gods-eye/logs").glob("prepare-model-index-*.log")
    )
    assert len(detailed_logs) == 2
    assert "raw natural-language" not in detailed_logs[0].read_text()


def test_prepare_halves_batch_after_gpu_oom_and_reuses_checkpoint(tmp_path: Path) -> None:
    env, call_log = _prepare_env(tmp_path)
    plan = tmp_path / "failures.json"
    plan.write_text(json.dumps({"build-index": ["oom"]}))
    env["GODS_EYE_FAKE_PREPARE_PLAN"] = str(plan)

    result = subprocess.run(
        [
            str(ROOT / "gods-eye"),
            "prepare",
            "--batch-size",
            "64",
            "--accept-data-terms",
        ],
        cwd=ROOT,
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    calls = [json.loads(line) for line in call_log.read_text().splitlines()]
    builds = [call for call in calls if call[0] == "build-index"]
    assert [call[call.index("--batch-size") + 1] for call in builds] == ["64", "32"]
    assert (
        builds[0][builds[0].index("--checkpoint-dir") + 1]
        == builds[1][builds[1].index("--checkpoint-dir") + 1]
    )
    assert "GPU memory exhausted; retrying index stage with batch size 32" in result.stdout


def test_prepare_reports_terminal_index_failure_without_activation(tmp_path: Path) -> None:
    env, call_log = _prepare_env(tmp_path)
    plan = tmp_path / "failures.json"
    plan.write_text(json.dumps({"build-index": ["fail"]}))
    env["GODS_EYE_FAKE_PREPARE_PLAN"] = str(plan)

    result = subprocess.run(
        [str(ROOT / "gods-eye"), "prepare", "--accept-data-terms"],
        cwd=ROOT,
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 1
    assert "terminal adapter failure" in result.stderr
    calls = [json.loads(line) for line in call_log.read_text().splitlines()]
    assert "activate-index" not in [call[0] for call in calls]


def test_prepare_model_id_deduplicates_in_first_seen_order(tmp_path: Path) -> None:
    env, call_log = _prepare_env(tmp_path)

    result = subprocess.run(
        [
            str(ROOT / "gods-eye"),
            "prepare",
            "--accept-data-terms",
            "--model-id",
            "openai/clip-vit-base-patch32",
            "--model-id",
            "openai/clip-vit-base-patch16",
            "--model-id",
            "openai/clip-vit-base-patch32",
        ],
        cwd=ROOT,
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    calls = [json.loads(line) for line in call_log.read_text().splitlines()]
    prepared = [call[call.index("--model-id") + 1] for call in calls if call[0] == "prepare-model"]
    assert prepared == [
        "openai/clip-vit-base-patch32",
        "openai/clip-vit-base-patch16",
    ]


def test_prepare_unknown_model_id_exits_usage_before_mutation(tmp_path: Path) -> None:
    env, call_log = _prepare_env(tmp_path)
    project = Path(env["GODS_EYE_PROJECT_ROOT"])

    result = subprocess.run(
        [str(ROOT / "gods-eye"), "prepare", "--yes", "--model-id", "community/model"],
        cwd=ROOT,
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 64
    assert "Unsupported CLIP model ID" in result.stderr
    assert not (project / ".gods-eye/state.json").exists()
    assert not call_log.exists()


def test_prepare_model_id_partial_failure_resumes_completed_model(tmp_path: Path) -> None:
    env, call_log = _prepare_env(tmp_path)
    plan = tmp_path / "model-plan.json"
    plan.write_text(json.dumps({"build-index": ["ok", "fail"]}))
    env["GODS_EYE_FAKE_PREPARE_PLAN"] = str(plan)
    command = [
        str(ROOT / "gods-eye"),
        "prepare",
        "--accept-data-terms",
        "--model-id",
        "openai/clip-vit-base-patch32",
        "--model-id",
        "openai/clip-vit-large-patch14",
    ]

    failed = subprocess.run(command, cwd=ROOT, env=env, text=True, capture_output=True, check=False)
    resumed = subprocess.run(
        command[0:2] + command[3:], cwd=ROOT, env=env, text=True, capture_output=True, check=False
    )

    assert failed.returncode == 1
    assert resumed.returncode == 0, resumed.stderr
    calls = [json.loads(line) for line in call_log.read_text().splitlines()]
    prepared = [call[call.index("--model-id") + 1] for call in calls if call[0] == "prepare-model"]
    assert prepared == [
        "openai/clip-vit-base-patch32",
        "openai/clip-vit-large-patch14",
    ]
    builds = [call[call.index("--model-id") + 1] for call in calls if call[0] == "build-index"]
    assert builds == [
        "openai/clip-vit-base-patch32",
        "openai/clip-vit-large-patch14",
        "openai/clip-vit-large-patch14",
    ]


def test_prepare_optional_model_capacity_failure_keeps_completed_default(tmp_path: Path) -> None:
    env, _ = _prepare_env(tmp_path)
    env["GODS_EYE_DOCTOR_FREE_BYTES"] = str(required_capacity_bytes() + 2 * 1024**3)

    result = subprocess.run(
        [
            str(ROOT / "gods-eye"),
            "prepare",
            "--accept-data-terms",
            "--model-id",
            "openai/clip-vit-base-patch16",
            "--model-id",
            "openai/clip-vit-large-patch14",
        ],
        cwd=ROOT,
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 1
    assert "additional 4 GiB" in result.stderr
    state = json.loads((Path(env["GODS_EYE_PROJECT_ROOT"]) / ".gods-eye/state.json").read_text())
    default = state["preparation"]["models"]["openai/clip-vit-base-patch16"]
    assert default["smoke_test"]["status"] == "verified"
    assert "openai/clip-vit-large-patch14" not in state["preparation"]["models"]
