import argparse
import json
import os
import platform
import shutil
import socket
import subprocess
import sys
from dataclasses import asdict, dataclass
from pathlib import Path

EXIT_OK = 0
EXIT_PREREQUISITE = 2
EXIT_USAGE = 64
EXIT_PREPARATION = 1
STATE_SCHEMA_VERSION = 1
MINIMUM_VRAM_MIB = 8 * 1024
MODEL_RESERVE_BYTES = 2 * 1024**3
INDEX_RESERVE_BYTES = 2 * 1024**3
SAFETY_RESERVE_BYTES = 2 * 1024**3


@dataclass(frozen=True)
class Check:
    name: str
    status: str
    detail: str
    guidance: str | None = None


@dataclass(frozen=True)
class RuntimeLayout:
    root: Path

    @property
    def runtime_dir(self) -> Path:
        return self.root / ".gods-eye"

    @property
    def logs_dir(self) -> Path:
        return self.runtime_dir / "logs"

    @property
    def state_path(self) -> Path:
        return self.runtime_dir / "state.json"

    def initialize(self) -> None:
        self.logs_dir.mkdir(parents=True, exist_ok=True)
        if not self.state_path.exists():
            self.state_path.write_text(
                json.dumps(
                    {
                        "schema_version": STATE_SCHEMA_VERSION,
                        "terms_acceptance": None,
                        "preparation": {},
                    },
                    indent=2,
                )
                + "\n"
            )


class LauncherArgumentParser(argparse.ArgumentParser):
    def error(self, message: str) -> None:
        self.print_usage(sys.stderr)
        self.exit(EXIT_USAGE, f"{self.prog}: error: {message}\n")


def _run(*command: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(command, text=True, capture_output=True, check=False)


def _check_platform() -> Check:
    system = os.getenv("GODS_EYE_DOCTOR_SYSTEM", platform.system())
    machine = os.getenv("GODS_EYE_DOCTOR_MACHINE", platform.machine())
    supported = system == "Linux" and machine in {"x86_64", "amd64"}
    return Check(
        "platform",
        "pass" if supported else "fail",
        f"{system} {machine}",
        None if supported else "Use an Ubuntu/Linux amd64 workstation.",
    )


def _check_docker() -> tuple[Check, Check]:
    daemon = _run("docker", "info", "--format", "{{.ServerVersion}}")
    daemon_ok = daemon.returncode == 0
    daemon_check = Check(
        "docker-daemon",
        "pass" if daemon_ok else "fail",
        daemon.stdout.strip() if daemon_ok else "Docker daemon is unavailable",
        None if daemon_ok else "Start Docker Engine and ensure your user can access it.",
    )
    compose_version = os.getenv("GODS_EYE_HOST_COMPOSE_VERSION")
    if compose_version is None:
        compose = _run("docker", "compose", "version", "--short")
        compose_version = compose.stdout.strip() if compose.returncode == 0 else ""
    compose_ok = bool(compose_version)
    compose_check = Check(
        "compose",
        "pass" if compose_ok else "fail",
        compose_version if compose_ok else "Docker Compose v2 is unavailable",
        None if compose_ok else "Install the Docker Compose v2 plugin.",
    )
    return daemon_check, compose_check


def _check_gpu() -> tuple[Check, Check, Check]:
    image = os.getenv("GODS_EYE_LAUNCHER_IMAGE", "gods-eye-launcher:local")
    result = _run(
        "docker",
        "run",
        "--rm",
        "--gpus",
        "all",
        "--pull",
        "never",
        "--entrypoint",
        "nvidia-smi",
        image,
        "--query-gpu=name,memory.total,driver_version",
        "--format=csv,noheader,nounits",
    )
    if result.returncode != 0:
        guidance = "Install a compatible NVIDIA driver and NVIDIA Container Toolkit."
        return (
            Check("nvidia-driver", "fail", "NVIDIA driver unavailable", guidance),
            Check("container-gpu", "fail", "Docker cannot access an NVIDIA GPU", guidance),
            Check("vram", "fail", "GPU memory could not be measured", guidance),
        )

    rows = [line.strip() for line in result.stdout.splitlines() if line.strip()]
    parsed: list[tuple[str, int, str]] = []
    try:
        for row in rows:
            name, memory, driver = (part.strip() for part in row.rsplit(",", 2))
            parsed.append((name, int(memory), driver))
    except (ValueError, TypeError):
        parsed = []
    if not parsed:
        guidance = "Verify nvidia-smi works inside a Docker container."
        return (
            Check("nvidia-driver", "fail", "NVIDIA driver details are unreadable", guidance),
            Check("container-gpu", "fail", "No NVIDIA GPU was reported", guidance),
            Check("vram", "fail", "GPU memory could not be measured", guidance),
        )
    name, memory, driver = max(parsed, key=lambda item: item[1])
    enough_memory = memory >= MINIMUM_VRAM_MIB
    return (
        Check("nvidia-driver", "pass", f"driver {driver}"),
        Check("container-gpu", "pass", name),
        Check(
            "vram",
            "pass" if enough_memory else "fail",
            f"{memory} MiB available; {MINIMUM_VRAM_MIB} MiB required",
            None if enough_memory else "Use an NVIDIA GPU with at least 8 GB VRAM.",
        ),
    )


def required_capacity_bytes() -> int:
    registry = json.loads(Path(__file__).with_name("dataset_registry.json").read_text())
    archive_bytes = sum(source["size"] for source in registry["sources"])
    return archive_bytes * 3 + MODEL_RESERVE_BYTES + INDEX_RESERVE_BYTES + SAFETY_RESERVE_BYTES


def _check_storage(layout: RuntimeLayout) -> tuple[Check, Check]:
    try:
        layout.initialize()
        probe = layout.runtime_dir / ".write-probe"
        probe.write_text("ok")
        probe.unlink()
        writable = True
    except OSError:
        writable = False
    writable_check = Check(
        "storage-writable",
        "pass" if writable else "fail",
        str(layout.runtime_dir),
        None if writable else "Make the project directory writable by the current user.",
    )
    required = required_capacity_bytes()
    override = os.getenv("GODS_EYE_DOCTOR_FREE_BYTES")
    free = int(override) if override is not None else shutil.disk_usage(layout.root).free
    enough = free >= required
    capacity_check = Check(
        "storage-capacity",
        "pass" if enough else "fail",
        f"{free} bytes free; {required} bytes required",
        None if enough else "Free project-disk space, then rerun doctor.",
    )
    return writable_check, capacity_check


def _check_port(name: str, port: int) -> Check:
    override = os.getenv("GODS_EYE_DOCTOR_PORTS_AVAILABLE")
    if override is not None:
        available = override == "1"
        return Check(
            name,
            "pass" if available else "warn",
            f"127.0.0.1:{port} is {'available' if available else 'occupied'}",
            None if available else "The Launcher will select another loopback port at start.",
        )
    probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        probe.bind(("127.0.0.1", port))
        available = True
    except OSError:
        available = False
    finally:
        probe.close()
    return Check(
        name,
        "pass" if available else "warn",
        f"127.0.0.1:{port} is {'available' if available else 'occupied'}",
        None if available else "The Launcher will select another loopback port at start.",
    )


def doctor(layout: RuntimeLayout) -> list[Check]:
    checks = [_check_platform()]
    checks.extend(_check_docker())
    checks.extend(_check_gpu())
    checks.extend(_check_storage(layout))
    checks.extend((_check_port("web-port", 5173), _check_port("api-port", 8000)))
    return checks


def _preparation_vram_mib() -> int:
    override = os.getenv("GODS_EYE_GPU_VRAM_MIB")
    if override is not None:
        return int(override)
    check = _check_gpu()[2]
    if check.status != "pass":
        raise ValueError(check.detail)
    return int(check.detail.split()[0])


def _print_human(checks: list[Check]) -> None:
    print("God's Eye Full Demo doctor")
    print("STATUS  CHECK               DETAILS")
    for check in checks:
        print(f"{check.status.upper():<7} {check.name:<19} {check.detail}")
        if check.guidance:
            print(f"        Fix: {check.guidance}")


def main(argv: list[str] | None = None) -> int:
    parser = LauncherArgumentParser(prog="gods-eye")
    subparsers = parser.add_subparsers(dest="command", required=True)
    doctor_parser = subparsers.add_parser("doctor")
    doctor_parser.add_argument("--json", action="store_true")
    prepare_parser = subparsers.add_parser("prepare")
    prepare_parser.add_argument("--batch-size", type=int)
    args = parser.parse_args(argv)
    root = Path(os.getenv("GODS_EYE_PROJECT_ROOT", "/workspace"))
    layout = RuntimeLayout(root)
    if args.command == "prepare":
        from .preparation import PreparationError, prepare_model_index

        layout.initialize()
        try:
            prepare_model_index(
                root,
                layout.state_path,
                vram_mib=_preparation_vram_mib(),
                batch_override=args.batch_size,
            )
        except (PreparationError, ValueError) as exc:
            print(str(exc), file=sys.stderr)
            return EXIT_PREPARATION
        return EXIT_OK
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
        _print_human(checks)
    return EXIT_PREREQUISITE if failed else EXIT_OK


if __name__ == "__main__":
    sys.exit(main())
