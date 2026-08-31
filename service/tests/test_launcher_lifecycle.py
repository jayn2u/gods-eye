import json
import os
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).parents[2]


def _fake_docker(bin_dir: Path) -> None:
    executable = bin_dir / "docker"
    executable.write_text(
        f"#!{sys.executable}\n"
        + """
import os
import subprocess
import sys

args = sys.argv[1:]
if args[:2] == ["compose", "version"]:
    print("2.32.4")
elif args[:2] == ["info", "--format"]:
    print("/plugins/docker-compose")
elif "build" in args and args[-1] == "launcher":
    raise SystemExit(0)
elif "run" in args and "launcher" in args:
    command = args[args.index("launcher") + 1 :]
    raise SystemExit(subprocess.call(
        [sys.executable, "-m", "gods_eye.launcher", *command], env=os.environ
    ))
else:
    raise SystemExit(97)
"""
    )
    executable.chmod(0o755)


def _run(root: Path, *args: str, input_text: str | None = None):
    bin_dir = root / ".test-bin"
    bin_dir.mkdir(exist_ok=True)
    _fake_docker(bin_dir)
    return subprocess.run(
        [str(ROOT / "gods-eye"), *args],
        cwd=ROOT,
        env={
            **os.environ,
            "PATH": f"{bin_dir}:{os.environ['PATH']}",
            "PYTHONPATH": str(ROOT / "service"),
            "GODS_EYE_PROJECT_ROOT": str(root),
        },
        input=input_text,
        text=True,
        capture_output=True,
        check=False,
    )


def test_reset_requires_an_explicit_target_and_never_deletes_by_default(tmp_path: Path) -> None:
    index = tmp_path / "indexes"
    index.mkdir()
    (index / "keep").write_text("safe")

    result = _run(tmp_path, "reset")

    assert result.returncode == 64
    assert "Choose at least one reset target" in result.stderr
    assert (index / "keep").is_file()


def test_reset_previews_sizes_and_requires_confirmation(tmp_path: Path) -> None:
    index = tmp_path / "indexes"
    index.mkdir()
    (index / "vectors.bin").write_bytes(b"12345")

    declined = _run(tmp_path, "reset", "--index", input_text="no\n")
    assert declined.returncode == 0
    assert "index (5 bytes)" in declined.stdout
    assert (index / "vectors.bin").is_file()

    accepted = _run(tmp_path, "reset", "--index", "--yes", "--json")
    assert accepted.returncode == 0, accepted.stderr
    assert json.loads(accepted.stdout) == {
        "deleted": ["index"],
        "status": "ok",
    }
    assert not index.exists()


def test_reset_all_keeps_terms_but_clears_preparation(tmp_path: Path) -> None:
    runtime = tmp_path / ".gods-eye"
    runtime.mkdir()
    state = {
        "schema_version": 1,
        "terms_acceptance": {
            "accepted_at": "2026-08-31T00:00:00Z",
            "registry_version": 1,
            "source_fingerprints": {"CUHK-PEDES": "a" * 64},
        },
        "preparation": {"dataset_acquisition": {"status": "verified"}},
    }
    (runtime / "state.json").write_text(json.dumps(state))
    for relative in ("indexes", ".cache/huggingface", "data/datasets", "data/archives"):
        path = tmp_path / relative
        path.mkdir(parents=True)
        (path / "asset").write_text("x")

    result = _run(tmp_path, "reset", "--all", "--yes")

    assert result.returncode == 0, result.stderr
    updated = json.loads((runtime / "state.json").read_text())
    assert updated["terms_acceptance"] == state["terms_acceptance"]
    assert updated["preparation"] == {}


def test_mutating_commands_refuse_a_concurrent_operation(tmp_path: Path) -> None:
    holder = subprocess.Popen(
        [
            sys.executable,
            "-c",
            (
                "import time; from pathlib import Path; "
                "from gods_eye.launcher import RuntimeLayout, mutation_lock; "
                f"layout=RuntimeLayout(Path({str(tmp_path)!r})); "
                "lock=mutation_lock(layout, 'prepare'); lock.__enter__(); time.sleep(10)"
            ),
        ],
        cwd=ROOT,
        env={**os.environ, "PYTHONPATH": str(ROOT / "service")},
    )
    try:
        lock_path = tmp_path / ".gods-eye/lock"
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            if lock_path.exists() and '"prepare"' in lock_path.read_text():
                break
            time.sleep(0.01)
        result = _run(tmp_path, "reset", "--index", "--yes", "--json")
    finally:
        holder.terminate()
        holder.wait(timeout=3)

    assert result.returncode == 75
    report = json.loads(result.stdout)
    assert report["status"] == "busy"
    assert report["active_operation"]["command"] == "prepare"


def test_update_reuses_compatible_assets_and_invalidates_only_dependents(tmp_path: Path) -> None:
    runtime = tmp_path / ".gods-eye"
    runtime.mkdir()
    state = {
        "schema_version": 1,
        "terms_acceptance": {"registry_version": 1},
        "compatibility": {
            "application": "0.1.0",
            "registry": "1",
            "model": "openai/clip-vit-base-patch16",
            "manifest_schema": "1",
            "index_schema": "1",
        },
        "preparation": {
            "dataset_acquisition": {"status": "verified"},
            "model": {"status": "verified"},
            "gallery_manifest": {"status": "verified"},
            "index": {"status": "verified"},
            "smoke_test": {"status": "verified"},
        },
    }
    (runtime / "state.json").write_text(json.dumps(state))

    env = os.environ.copy()
    os.environ["GODS_EYE_TARGET_MANIFEST_SCHEMA"] = "2"
    try:
        preview = _run(tmp_path, "update", "--json")
        applied = _run(tmp_path, "update", "--yes", "--json")
    finally:
        os.environ.clear()
        os.environ.update(env)

    assert preview.returncode == 0
    preview_report = json.loads(preview.stdout)
    assert preview_report["status"] == "planned"
    assert preview_report["invalidate"] == ["gallery_manifest", "index", "smoke_test"]
    assert applied.returncode == 0
    preparation = json.loads((runtime / "state.json").read_text())["preparation"]
    assert set(preparation) == {"dataset_acquisition", "model"}


def test_registry_update_requires_renewed_terms_acceptance(tmp_path: Path) -> None:
    runtime = tmp_path / ".gods-eye"
    runtime.mkdir()
    (runtime / "state.json").write_text(
        json.dumps(
            {
                "schema_version": 1,
                "terms_acceptance": {"registry_version": 1},
                "compatibility": {
                    "application": "0.1.0",
                    "model": "openai/clip-vit-base-patch16",
                    "manifest_schema": "1",
                    "index_schema": "1",
                    "registry": "old",
                },
                "preparation": {"dataset_acquisition": {"status": "verified"}},
            }
        )
    )

    result = _run(tmp_path, "update", "--yes", "--json")

    assert result.returncode == 0
    state = json.loads((runtime / "state.json").read_text())
    assert state["terms_acceptance"] is None
    assert "dataset_acquisition" not in state["preparation"]


def test_automation_confirmation_does_not_accept_data_terms(tmp_path: Path) -> None:
    result = _run(tmp_path, "update", "--yes", "--json")

    assert result.returncode == 0
    state = json.loads((tmp_path / ".gods-eye/state.json").read_text())
    assert state["terms_acceptance"] is None


def test_json_reset_requires_explicit_automation_confirmation(tmp_path: Path) -> None:
    result = _run(tmp_path, "reset", "--index", "--json")

    assert result.returncode == 3
    assert json.loads(result.stdout) == {"status": "confirmation_required"}


def test_operation_logs_redact_secrets_and_host_identity(tmp_path: Path) -> None:
    secret = "hf_super-secret-token"
    old = os.environ.get("HF_TOKEN")
    os.environ["HF_TOKEN"] = secret
    try:
        result = _run(tmp_path, "update", "--yes")
    finally:
        if old is None:
            os.environ.pop("HF_TOKEN", None)
        else:
            os.environ["HF_TOKEN"] = old

    assert result.returncode == 0
    logs = "".join(path.read_text() for path in (tmp_path / ".gods-eye/logs").iterdir())
    assert secret not in logs
    assert os.environ.get("USER", "value-that-cannot-match") not in logs
