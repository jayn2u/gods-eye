import json
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).parents[2]


def _fake_docker(bin_dir: Path) -> Path:
    log = bin_dir / "docker.jsonl"
    executable = bin_dir / "docker"
    executable.write_text(
        f"#!{sys.executable}\n"
        + """
import json, os, subprocess, sys
args = sys.argv[1:]
with open(os.environ['FAKE_DOCKER_LOG'], 'a') as stream:
    stream.write(json.dumps(args) + '\\n')
if args[:2] == ['compose', 'version']:
    print('2.32.4')
elif args[:2] == ['info', '--format']:
    print('/plugins/docker-compose')
elif 'build' in args and args[-1] == 'launcher':
    raise SystemExit(0)
elif 'run' in args and 'launcher' in args:
    command = args[args.index('launcher') + 1:]
    raise SystemExit(subprocess.call([sys.executable, '-m', 'gods_eye.launcher', *command], env=os.environ))
elif 'compose' in args and 'exec' in args:
    if os.environ.get('FAKE_READY') == '1':
        print(json.dumps({'ready': True, 'gallery_count': 3}))
    else:
        print('search readiness failed', file=sys.stderr)
        raise SystemExit(1)
elif 'compose' in args and 'ps' in args:
    print(json.dumps([{'Service': 'service', 'State': 'running'}, {'Service': 'web', 'State': 'running'}]))
elif 'compose' in args and 'logs' in args:
    print('service | ready')
elif 'compose' in args and ('up' in args or 'down' in args):
    pass
else:
    raise SystemExit(97)
"""
    )
    executable.chmod(0o755)
    return log


def _prepared(root: Path) -> None:
    root.mkdir(parents=True, exist_ok=True)
    runtime = root / ".gods-eye"
    runtime.mkdir()
    (runtime / "state.json").write_text(
        json.dumps(
            {
                "schema_version": 1,
                "terms_acceptance": {},
                "compatibility": {},
                "preparation": {
                    "dataset_acquisition": {"status": "verified"},
                    "model": {"status": "verified"},
                    "gallery_manifest": {"status": "verified"},
                    "index": {"status": "active"},
                    "smoke_test": {"status": "verified"},
                },
            }
        )
    )


def _offline_assets(root: Path) -> None:
    for name in ("CUHK-PEDES", "ICFG-PEDES", "RSTPReid"):
        (root / "data/datasets" / name).mkdir(parents=True, exist_ok=True)
        receipt = root / "data/install-state" / f"{name}.json"
        receipt.parent.mkdir(parents=True, exist_ok=True)
        receipt.write_text("{}")
    model = root / ".cache/huggingface/model.ready"
    model.parent.mkdir(parents=True, exist_ok=True)
    model.write_text("ok")
    manifest = root / "indexes/gallery-manifest.json"
    manifest.parent.mkdir(parents=True, exist_ok=True)
    manifest.write_text("{}")
    (root / "indexes/active").mkdir()


def _run(root: Path, *arguments: str, prepared: bool = True, extra_env=None, input_text=None):
    if prepared:
        _prepared(root)
    bin_dir = root / "bin"
    bin_dir.mkdir()
    log = _fake_docker(bin_dir)
    env = {
        **os.environ,
        "PATH": f"{bin_dir}:{os.environ['PATH']}",
        "PYTHONPATH": str(ROOT / "service"),
        "GODS_EYE_PROJECT_ROOT": str(root),
        "GODS_EYE_HOST_PROJECT_ROOT": str(root),
        "GODS_EYE_COMPOSE_FILE": "/workspace/compose.yaml:/workspace/compose.release.yaml",
        "FAKE_DOCKER_LOG": str(log),
        "FAKE_READY": "1",
        "GODS_EYE_RUNTIME_PORTS_AVAILABLE": "1",
    }
    env.update(extra_env or {})
    result = subprocess.run(
        [str(ROOT / "gods-eye"), *arguments],
        cwd=ROOT,
        env=env,
        input=input_text,
        text=True,
        capture_output=True,
        check=False,
    )
    calls = [json.loads(line) for line in log.read_text().splitlines()]
    return result, calls


def test_detached_start_waits_for_search_readiness_and_reports_actual_loopback_url(tmp_path):
    result, calls = _run(tmp_path, "start", "--detach", "--no-open", "--web-port", "6123")

    assert result.returncode == 0, result.stderr
    assert "http://127.0.0.1:6123" in result.stdout
    assert any("compose" in call and "up" in call and "-d" in call for call in calls)
    assert any("compose" in call and "exec" in call for call in calls)
    assert all("0.0.0.0" not in " ".join(call) for call in calls)


def test_start_never_prepares_silently_and_noninteractive_use_fails(tmp_path):
    result, calls = _run(tmp_path, "start", "--detach", prepared=False)

    assert result.returncode == 4
    assert "./gods-eye prepare" in result.stderr
    assert not any("compose" in call and "up" in call for call in calls)


def test_offline_start_inherits_release_compose_files_and_adds_network_isolation(tmp_path):
    _offline_assets(tmp_path)
    result, calls = _run(
        tmp_path,
        "start",
        "--detach",
        "--offline",
        "--no-open",
        extra_env={"COMPOSE_FILE": "/workspace/compose.yaml:/workspace/compose.release.yaml"},
    )

    assert result.returncode == 0, result.stderr
    up = next(call for call in calls if "compose" in call and "up" in call)
    command = " ".join(up)
    assert "/workspace/compose.yaml" in command
    assert "/workspace/compose.release.yaml" in command
    assert "/workspace/compose.offline.yaml" in command


def test_offline_start_reports_each_missing_local_asset_without_starting_compose(tmp_path):
    result, calls = _run(tmp_path, "start", "--detach", "--offline", "--no-open")

    assert result.returncode == 4
    assert "Dataset Installation: CUHK-PEDES" in result.stderr
    assert "CLIP ViT-B/16 model cache" in result.stderr
    assert "Gallery Manifest: indexes/gallery-manifest.json" in result.stderr
    assert "active retrieval index: indexes/active" in result.stderr
    assert "No network access or downloads were attempted" in result.stderr
    assert not any("compose" in call and "up" in call for call in calls)


def test_readiness_failure_stops_runtime_and_prints_recovery_guidance(tmp_path):
    result, calls = _run(
        tmp_path,
        "start",
        "--detach",
        "--no-open",
        extra_env={"FAKE_READY": "0", "GODS_EYE_READINESS_TIMEOUT_SECONDS": "0"},
    )

    assert result.returncode == 4
    assert "readiness" in result.stderr.lower()
    assert "logs" in result.stderr.lower()
    assert any("compose" in call and "down" in call for call in calls)


def test_status_logs_and_stop_are_launcher_commands(tmp_path):
    status, _ = _run(tmp_path / "status", "status")
    logs, _ = _run(tmp_path / "logs", "logs")
    stop, calls = _run(tmp_path / "stop", "stop")

    assert status.returncode == 0 and "service" in status.stdout
    assert logs.returncode == 0 and "service | ready" in logs.stdout
    assert stop.returncode == 0
    assert any("compose" in call and "down" in call for call in calls)
