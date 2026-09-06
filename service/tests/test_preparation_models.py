import hashlib
import json
import subprocess
from pathlib import Path
from types import SimpleNamespace

import pytest
from gods_eye.clip_models import CLIP_MODELS
from gods_eye.preparation import (
    PreparationError,
    PreparationPaths,
    PreparationRunner,
    prepare_model_index,
)
from gods_eye.preparation_state import model_preparation, normalize_preparation_state
from gods_eye.preparation_worker import main as preparation_worker_main

MODEL_IDS = tuple(spec.model_id for spec in CLIP_MODELS)
REVISIONS = {model_id: f"{index:040x}" for index, model_id in enumerate(MODEL_IDS, 1)}


class FakeRunner:
    def __init__(self, root: Path, failures: list[tuple[str, str]] | None = None) -> None:
        self.calls: list[tuple[str, tuple[str, ...]]] = []
        self.failures = failures or []
        self.manifest_digest = "b" * 64

    def run(self, operation: str, *arguments: str) -> str:
        self.calls.append((operation, arguments))
        model_id = _option(arguments, "--model-id")
        if (failure := (operation, model_id or "")) in self.failures:
            self.failures.remove(failure)
            raise PreparationError(f"interrupted {operation}")
        if operation == "prepare-model":
            assert model_id is not None
            return json.dumps(
                {"model_id": model_id, "resolved_revision": REVISIONS[model_id]},
                separators=(",", ":"),
            )
        if operation == "verify-model":
            assert model_id is not None
            revision = _option(arguments, "--revision")
            if revision != REVISIONS[model_id]:
                raise PreparationError("stale model state")
            return json.dumps({"model_id": model_id, "resolved_revision": revision})
        if operation == "build-manifest":
            output = Path(_option(arguments, "--output") or "")
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_text('{"records":[]}\n')
            return str(output)
        if operation == "verify-manifest":
            return self.manifest_digest
        if operation == "build-index":
            versions = Path(_option(arguments, "--versions-dir") or "")
            version = versions / f"version-{model_id.rsplit('/', 1)[-1]}"
            version.mkdir(parents=True, exist_ok=True)
            return str(version)
        if operation == "activate-index":
            version = Path(arguments[0])
            active = Path(_option(arguments, "--active-pointer") or "")
            active.parent.mkdir(parents=True, exist_ok=True)
            active.write_text(version.relative_to(active.parent).as_posix() + "\n")
            return str(version)
        return arguments[0] if arguments else "ok"


def _option(arguments: tuple[str, ...], option: str) -> str | None:
    try:
        return arguments[arguments.index(option) + 1]
    except ValueError:
        return None


def _state_path(root: Path, preparation: dict | None = None) -> Path:
    state_path = root / ".gods-eye/state.json"
    state_path.parent.mkdir(parents=True)
    state_path.write_text(
        json.dumps({"schema_version": 1, "preparation": preparation or {}}) + "\n"
    )
    return state_path


def test_all_models_use_distinct_contained_paths_and_checkpoints(tmp_path: Path) -> None:
    paths = PreparationPaths(tmp_path)
    manifest_sha = "a" * 64
    storage_keys = {
        MODEL_IDS[0]: "clip-vit-b-32",
        MODEL_IDS[2]: "clip-vit-l-14",
        MODEL_IDS[3]: "clip-vit-l-14-336",
    }
    for model_id in MODEL_IDS:
        model_paths = paths.for_model(model_id)
        parent = tmp_path / "indexes"
        if model_id != MODEL_IDS[1]:
            parent = parent / "models" / storage_keys[model_id]
        signature = hashlib.sha256(
            f"{model_id}:{REVISIONS[model_id]}:{manifest_sha}".encode()
        ).hexdigest()[:20]
        assert model_paths.versions == parent / "versions"
        assert model_paths.active == parent / "active"
        assert model_paths.checkpoint(REVISIONS[model_id], manifest_sha) == (
            tmp_path / "indexes/.checkpoints" / signature
        )


def test_legacy_schema_1_b16_is_normalized_without_losing_unpinned_provenance() -> None:
    legacy_model = {
        "status": "verified",
        "model_id": MODEL_IDS[1],
        "revision": None,
    }
    legacy_index = {
        "status": "active",
        "model_id": MODEL_IDS[1],
        "model_revision": None,
        "version_path": "indexes/versions/legacy",
    }
    legacy_smoke = {"status": "verified", "model_revision": None}
    state = {
        "schema_version": 1,
        "preparation": {
            "model": legacy_model,
            "index": legacy_index,
            "smoke_test": legacy_smoke,
            "gallery_manifest": {"status": "verified"},
        },
    }

    normalized = normalize_preparation_state(state)
    record = model_preparation(normalized["preparation"], MODEL_IDS[1])

    assert normalized["schema_version"] == 2
    assert record == {
        "model": {**legacy_model, "resolved_revision": None, "legacy_revision_unresolved": True},
        "index": {**legacy_index, "legacy_revision_unresolved": True},
        "smoke_test": {**legacy_smoke, "legacy_revision_unresolved": True},
    }
    assert normalized["preparation"]["model"] == legacy_model
    assert state["schema_version"] == 1


def test_all_models_reuse_shared_manifest_and_their_own_verified_state(tmp_path: Path) -> None:
    state_path = _state_path(tmp_path)
    runner = FakeRunner(tmp_path)

    for model_id in MODEL_IDS:
        prepare_model_index(
            tmp_path, state_path, vram_mib=24 * 1024, runner=runner, model_id=model_id
        )
    first_call_count = len(runner.calls)
    for model_id in MODEL_IDS:
        prepare_model_index(
            tmp_path, state_path, vram_mib=24 * 1024, runner=runner, model_id=model_id
        )

    state = json.loads(state_path.read_text())
    original_manifest_completed_at = state["preparation"]["gallery_manifest"]["completed_at"]
    assert state["schema_version"] == 2
    assert set(state["preparation"]["models"]) == set(MODEL_IDS)
    assert [operation for operation, _ in runner.calls].count("build-manifest") == 1
    assert [operation for operation, _ in runner.calls[first_call_count:]] == [
        operation
        for _ in MODEL_IDS
        for operation in ("verify-model", "verify-manifest", "verify-index", "smoke-search")
    ]
    for model_id in MODEL_IDS:
        record = state["preparation"]["models"][model_id]
        assert record["model"]["resolved_revision"] == REVISIONS[model_id]
        assert record["index"]["model_revision"] == REVISIONS[model_id]
        assert record["smoke_test"]["model_revision"] == REVISIONS[model_id]
    for stage in ("model", "index", "smoke_test"):
        assert state["preparation"][stage] == state["preparation"]["models"][MODEL_IDS[1]][stage]
    for operation, arguments in runner.calls:
        model_id = _option(arguments, "--model-id")
        if model_id is not None and operation not in {"prepare-model", "activate-index"}:
            assert _option(arguments, "--revision") == REVISIONS[model_id]
        if operation == "activate-index":
            assert _option(arguments, "--revision") == REVISIONS[model_id]
    runner.manifest_digest = "c" * 64
    calls_before_change = len(runner.calls)
    prepare_model_index(
        tmp_path, state_path, vram_mib=24 * 1024, runner=runner, model_id=MODEL_IDS[0]
    )
    changed_calls = runner.calls[calls_before_change:]
    build_arguments = next(
        arguments for operation, arguments in changed_calls if operation == "build-index"
    )
    signature = hashlib.sha256(
        f"{MODEL_IDS[0]}:{REVISIONS[MODEL_IDS[0]]}:{runner.manifest_digest}".encode()
    ).hexdigest()[:20]
    assert _option(build_arguments, "--checkpoint-dir") == str(
        tmp_path / "indexes/.checkpoints" / signature
    )
    changed_state = json.loads(state_path.read_text())
    assert changed_state["preparation"]["gallery_manifest"]["manifest_sha256"] == "c" * 64
    assert (
        changed_state["preparation"]["gallery_manifest"]["completed_at"]
        != original_manifest_completed_at
    )
    assert (
        changed_state["preparation"]["models"][MODEL_IDS[0]]["index"]["gallery_manifest_sha256"]
        == "c" * 64
    )


def test_partial_failure_preserves_first_model_and_resumes_only_unfinished_work(
    tmp_path: Path,
) -> None:
    state_path = _state_path(tmp_path)
    runner = FakeRunner(tmp_path, [("build-index", MODEL_IDS[2])] * 2)
    prepare_model_index(
        tmp_path, state_path, vram_mib=24 * 1024, runner=runner, model_id=MODEL_IDS[0]
    )
    first_active = PreparationPaths(tmp_path).for_model(MODEL_IDS[0]).active.read_text()

    with pytest.raises(PreparationError, match="interrupted build-index"):
        prepare_model_index(
            tmp_path, state_path, vram_mib=24 * 1024, runner=runner, model_id=MODEL_IDS[2]
        )
    for _ in range(2):
        calls_before_resume = len(runner.calls)
        try:
            prepare_model_index(
                tmp_path, state_path, vram_mib=24 * 1024, runner=runner, model_id=MODEL_IDS[2]
            )
        except PreparationError:
            continue
        break

    resumed = [operation for operation, _ in runner.calls[calls_before_resume:]]
    assert resumed == [
        "verify-model",
        "verify-manifest",
        "build-index",
        "validate-index",
        "activate-index",
        "smoke-search",
    ]
    assert PreparationPaths(tmp_path).for_model(MODEL_IDS[0]).active.read_text() == first_active


def test_stale_state_and_misleading_files_are_verified_before_reuse(tmp_path: Path) -> None:
    state_path = _state_path(
        tmp_path,
        {
            "models": {
                MODEL_IDS[0]: {
                    "model": {
                        "status": "verified",
                        "model_id": MODEL_IDS[0],
                        "requested_revision": None,
                        "resolved_revision": "f" * 40,
                    }
                }
            }
        },
    )
    runner = FakeRunner(tmp_path)

    prepare_model_index(
        tmp_path, state_path, vram_mib=24 * 1024, runner=runner, model_id=MODEL_IDS[0]
    )

    assert [operation for operation, _ in runner.calls[:2]] == ["verify-model", "prepare-model"]
    state = json.loads(state_path.read_text())
    assert (
        model_preparation(state["preparation"], MODEL_IDS[0])["model"]["resolved_revision"]
        == REVISIONS[MODEL_IDS[0]]
    )


@pytest.mark.parametrize(
    "payload",
    ["not-json", "{}", '{"model_id":"wrong","resolved_revision":"' + "a" * 40 + '"}'],
)
def test_malformed_or_misleading_prepare_model_receipt_fails_closed(
    tmp_path: Path, payload: str
) -> None:
    class ReceiptRunner(FakeRunner):
        def run(self, operation: str, *arguments: str) -> str:
            if operation == "prepare-model":
                return payload
            return super().run(operation, *arguments)

    state_path = _state_path(tmp_path)

    with pytest.raises(PreparationError, match="receipt"):
        prepare_model_index(
            tmp_path,
            state_path,
            vram_mib=24 * 1024,
            runner=ReceiptRunner(tmp_path),
            model_id=MODEL_IDS[0],
        )

    state = json.loads(state_path.read_text())
    assert model_preparation(state["preparation"], MODEL_IDS[0]) == {}


def test_hung_worker_is_reported_as_preparation_failure(monkeypatch: pytest.MonkeyPatch) -> None:
    def timeout(*args: str, **kwargs: str) -> subprocess.CompletedProcess[str]:
        raise subprocess.TimeoutExpired(cmd=["worker"], timeout=30)

    monkeypatch.setattr(subprocess, "run", timeout)

    with pytest.raises(PreparationError, match="timed out"):
        PreparationRunner("worker", timeout_seconds=30).run("prepare-model")


def test_worker_prints_one_machine_readable_resolved_revision_receipt(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str], tmp_path: Path
) -> None:
    revision = REVISIONS[MODEL_IDS[0]]
    embedder = SimpleNamespace(model=SimpleNamespace(config=SimpleNamespace(_commit_hash=revision)))
    monkeypatch.setattr(
        "gods_eye.preparation_worker.HuggingFaceClipEmbedder.from_config",
        lambda config: embedder,
    )

    result = preparation_worker_main(
        [
            "prepare-model",
            "--model-id",
            MODEL_IDS[0],
            "--cache-dir",
            str(tmp_path),
        ]
    )

    assert result == 0
    assert capsys.readouterr().out == (
        f'{{"model_id":"{MODEL_IDS[0]}","resolved_revision":"{revision}"}}\n'
    )
