# Full Demo lifecycle and storage

The root `./gods-eye` Launcher is the supported operator interface. Its thin shell wrapper needs
only Docker; stateful orchestration runs in the launcher container. It writes project-local,
gitignored assets under `data/`, `.cache/huggingface/`, `indexes/`, and `.gods-eye/`.

`doctor` checks Linux amd64, Docker and Compose, NVIDIA driver and container GPU access, the 8 GiB
VRAM floor, writable storage, calculated free space, and default ports. It reports every failure
together and never installs packages.

`prepare` separates long-lived Demo Preparation from repeatable Demo Runtime startup. Its terms
acceptance is bound to the Dataset Registry version and selected sources. A source change requires
new acceptance; `--yes` alone never accepts terms. Downloads retain resumable `.part` files and
verified archives. Index batches retain compatible checkpoints. Detailed, redacted logs are in
`.gods-eye/logs/`.

`start` binds the API and web app to loopback, waits up to two minutes for health and search
readiness, and opens the reported URL unless `--no-open`, SSH, or a headless session applies. It is
foreground by default; use `--detach`, then `status`, `logs`, and `stop` when background operation is
useful. Stopping does not remove prepared assets.

Configuration normally remains internal to the Launcher. The underlying defaults are
`data/datasets`, `indexes`, `indexes/active`, `.cache/huggingface`, model
`openai/clip-vit-base-patch16`, batch size 32, API port 8000, and web port 5173. Advanced operators
can inspect `.env.example`; Compose still publishes only on `127.0.0.1`. Authentication and TLS are
not provided, so public exposure is unsupported.

| Variable | Default | Purpose |
| --- | --- | --- |
| `GODS_EYE_DATA_HOME` | `./data` | Host acquisition root used by Compose tooling |
| `GODS_EYE_DATASET_ROOT` | `./data/datasets` | verified Dataset Installation root |
| `GODS_EYE_INDEX_ROOT` | `indexes` | writable index/checkpoint root |
| `GODS_EYE_ACTIVE_INDEX` | `indexes/active` | active-version pointer |
| `GODS_EYE_MODEL_ID` | `openai/clip-vit-base-patch16` | Hugging Face model identity |
| `GODS_EYE_MODEL_REVISION` | unset | optional immutable Hub revision |
| `GODS_EYE_HF_CACHE` | Hugging Face default | prepared model cache |
| `GODS_EYE_OFFLINE` | `false` | refuse model network access |
| `GODS_EYE_DEVICE` | `auto` | `auto`, `cpu`, `cuda`, or CUDA device |
| `GODS_EYE_BATCH_SIZE` | `32` | image embedding batch size |
| `GODS_EYE_LOG_LEVEL` | `INFO` | operational log level |

The service container sees datasets at `/datasets` read-only, indexes at `/indexes` read-write, and
the model cache at `/models`. Images and research assets are excluded from build contexts and image
layers. `docker compose down` preserves the host assets.

`update` is explicit and previews which compatibility stages would be invalidated. `reset` requires
one or more named targets, displays the plan and size, and asks for confirmation. Use `--yes` only
after reviewing that plan; use `--json` where supported for automation.
