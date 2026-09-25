# Fine-tuned Checkpoint Comparison Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Import lab_clip CUHK-PEDES fine-tuned checkpoints into God's Eye and show their improvement over an equal-preprocessing zero-shot baseline through benchmark metrics, side-by-side comparison, and ground-truth rank examples.

**Architecture:** A dynamic model registry (built-in HF models + derived open_clip Paired Baselines + imported checkpoints) feeds the existing preparation pipeline (model → manifest → index → **evaluation** → smoke) and the runtime catalog. A new `OpenClipEmbedder` sits behind the existing embedder seam with ReID preprocessing ported to PIL/numpy. Benchmark evaluation and Benchmark Queries are computed during Demo Preparation, stored immutably, and served through new read-only API endpoints to new Compare and Benchmark screens.

**Tech Stack:** Python 3.11, FastAPI, numpy, faiss-cpu, torch, transformers, open_clip_torch 3.3.0, safetensors, huggingface_hub; React + Vite + Vitest + Playwright.

**Spec:** `docs/specs/fine-tuned-comparison.md`

## Global Constraints

- Branch `claude/fine-tuned-checkpoint-comparison`, one PR into `develop`; commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- `open_clip_torch==3.3.0` is added to the `clip` extra only. CI installs only `--extra indexing`: every module imported by non-integration tests must import torch/open_clip lazily.
- Baseline pretrained source for `ViT-B-16`/`openai`: repo `timm/vit_base_patch16_clip_224.openai`, file `open_clip_model.safetensors`, revision `977e3dd0ec55ab8da155f2fbeb6b5f54948b6e3d`.
- Checkpoint id: `labclip:cuhk-pedes:<12 hex>`; baseline id: `openclip/<model_name>@<pretrained>:<H>x<W>-<preprocess_mode>`.
- Checkpoint storage: `<hf_cache>/labclip-checkpoints/<64-hex weights sha256>/{model.safetensors,labclip_args.json,registration.json}`.
- Never unpickle at runtime; import uses `torch.load(..., weights_only=True)` once.
- Only Benchmark Query captions (48, test split) may appear in any API response. `/api/search` responses stay caption-free.
- Reference-metric warning threshold: |ΔR@1| > 0.5 percentage points.
- Default resident model capacity 4 (`GODS_EYE_RESIDENT_MODELS`).
- Run Python tests with `uv run --extra indexing pytest -q`; web tests with `corepack pnpm --dir web test`; lint with `uv run ruff check service scripts`.

## File Structure

| File | Responsibility |
|---|---|
| `service/gods_eye/reid_preprocess.py` (new) | Torch-free ReID image preprocessing identical to lab_clip eval transforms |
| `service/gods_eye/clip_models.py` (modify) | `ClipModelSpec` gains backend/group/arch fields; `OpenClipArch`; id derivation; pinned pretrained sources; `ModelRegistry` |
| `service/gods_eye/checkpoint_registry.py` (new) | Registration read/write/list/remove on disk; validation of lab_clip `args` |
| `service/gods_eye/checkpoint_import.py` (new, torch) | Weights-only load, strict build check, safetensors write |
| `service/gods_eye/openclip_embedder.py` (new, torch) | `OpenClipEmbedder` for baselines and checkpoints |
| `service/gods_eye/embedders.py` (new) | `create_embedder(...)` dispatch by backend |
| `service/gods_eye/benchmark.py` (new) | Test-caption loading, metrics (numpy port of lab_clip), Benchmark Query sampling, evaluation read/write |
| `service/gods_eye/preparation.py`, `preparation_state.py`, `preparation_worker.py` (modify) | Registry-aware paths, `sha256:` revisions, `evaluation` stage, new worker operations |
| `service/gods_eye/launcher_cli.py`, `gods-eye` (modify) | `prepare --checkpoint/--label/--reference-metrics`, `checkpoint list/remove`, host bind of import files |
| `service/gods_eye/model_runtime.py`, `retrieval.py`, `models.py`, `app.py`, `config.py` (modify) | Registry catalog, LRU residency, evaluation loading, benchmark endpoints, fixture pair |
| `web/src/*` (modify/new) | Mode switch, Compare screen, Benchmark screen, pure comparison helpers |
| `scripts/labclip_golden.py` (new) | Generates golden fixtures from lab_clip |
| `docs/adr/0003-*.md`, `CONTEXT.md`, `docs/setup/fine-tuned-checkpoints.md`, `acceptance.py` | Documentation and wording |

---

### Task 1: Torch-free ReID preprocessing with golden fixtures

**Files:**
- Create: `service/gods_eye/reid_preprocess.py`
- Create: `scripts/labclip_golden.py`
- Create: `service/tests/fixtures/openclip_golden/` (`images/*.png`, `preprocess.npz`, `embeddings.npz`, `README.md`)
- Test: `service/tests/test_reid_preprocess.py`

**Interfaces:**
- Produces: `CLIP_MEAN`, `CLIP_STD`, `reid_preprocess(image: PIL.Image.Image, *, height: int, width: int, mean=CLIP_MEAN, std=CLIP_STD, interpolation: str = "bilinear") -> np.ndarray` (float32, shape `(3, height, width)`), `batch_preprocess(images, **kw) -> np.ndarray (N,3,H,W)`.

- [ ] **Step 1: Write the golden generator** `scripts/labclip_golden.py`. It runs with the lab_clip interpreter (`/mnt/data/lab_clip/.venv/bin/python scripts/labclip_golden.py --labclip /mnt/data/lab_clip --out service/tests/fixtures/openclip_golden`). It creates four synthetic, non-dataset images deterministically (gradients/stripes of sizes 64x160, 128x384, 97x211, 300x300 in RGB, one saved as RGBA to exercise conversion), saves them as PNG, applies `clip_transforms.build_reid_transforms(img_height=384, img_width=128, aug=False, is_train=False)` and `model_reid` variant (mean/std/interp from `open_clip.get_model_preprocess_cfg`) after `.convert("RGB")`, and saves `preprocess.npz` with arrays `reid_<name>` and `model_reid_<name>`. It also builds the baseline via `clip_model.create_reid_model_and_transforms(model_name="ViT-B-16", pretrained="openai", device=cpu, img_height=384, img_width=128)`, encodes the four images and captions `["a woman in a red coat carrying a black bag", "a man wearing a white shirt and blue jeans", "person with a yellow backpack"]` in fp32 on CPU, L2-normalizes, and saves `embeddings.npz` (`image`, `text`). Record open_clip/torch versions and the command in `README.md`.

- [ ] **Step 2: Run the generator** and commit the fixtures (they must total < 1 MB).

- [ ] **Step 3: Write the failing test**

```python
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

from gods_eye.reid_preprocess import batch_preprocess, reid_preprocess

GOLDEN = Path(__file__).parent / "fixtures" / "openclip_golden"
NAMES = sorted(p.stem for p in (GOLDEN / "images").glob("*.png"))


@pytest.mark.parametrize("name", NAMES)
def test_reid_preprocess_matches_labclip_eval_transform(name: str) -> None:
    expected = np.load(GOLDEN / "preprocess.npz")[f"reid_{name}"]
    with Image.open(GOLDEN / "images" / f"{name}.png") as image:
        actual = reid_preprocess(image.convert("RGB"), height=384, width=128)
    assert actual.dtype == np.float32 and actual.shape == (3, 384, 128)
    np.testing.assert_allclose(actual, expected, atol=1e-5)


def test_batch_preprocess_stacks_in_order() -> None:
    images = [Image.new("RGB", (10, 20), (255, 0, 0)), Image.new("RGB", (10, 20), (0, 0, 255))]
    batch = batch_preprocess(images, height=8, width=4)
    assert batch.shape == (2, 3, 8, 4)
    assert batch[0, 0].mean() > batch[1, 0].mean()
```

Add the `model_reid` variant test the same way using `interpolation="bicubic"` and the open_clip mean/std recorded in the npz (`model_reid_mean`, `model_reid_std`).

- [ ] **Step 4: Run** `uv run --extra indexing pytest service/tests/test_reid_preprocess.py -q` → FAIL (module missing).

- [ ] **Step 5: Implement**

```python
"""Torch-free port of lab_clip's evaluation-time ReID preprocessing."""

from __future__ import annotations

from collections.abc import Sequence

import numpy as np
from PIL import Image

CLIP_MEAN = (0.48145466, 0.4578275, 0.40821073)
CLIP_STD = (0.26862954, 0.26130258, 0.27577711)
_RESAMPLE = {"bilinear": Image.Resampling.BILINEAR, "bicubic": Image.Resampling.BICUBIC}


def reid_preprocess(
    image: Image.Image,
    *,
    height: int,
    width: int,
    mean: Sequence[float] = CLIP_MEAN,
    std: Sequence[float] = CLIP_STD,
    interpolation: str = "bilinear",
) -> np.ndarray:
    """Resize to (height, width) without cropping, scale to [0, 1], then normalize (CHW)."""
    resized = image.convert("RGB").resize((width, height), _RESAMPLE[interpolation])
    array = np.asarray(resized, dtype=np.float32) / np.float32(255.0)
    array = (array - np.asarray(mean, np.float32)) / np.asarray(std, np.float32)
    return np.ascontiguousarray(array.transpose(2, 0, 1), dtype=np.float32)


def batch_preprocess(images: Sequence[Image.Image], **options) -> np.ndarray:
    return np.stack([reid_preprocess(image, **options) for image in images])
```

(torchvision `Resize` on PIL input with `antialias=True` delegates to `PIL.Image.resize`, so this is bit-compatible; if the golden test shows a difference > 1e-5, inspect torchvision 0.23 `functional_pil.resize` and match it rather than loosening tolerance.)

- [ ] **Step 6: Run tests** → PASS. `uv run ruff check service scripts`.

- [ ] **Step 7: Commit** `feat(service): add torch-free ReID preprocessing with lab_clip golden fixtures`.

---

### Task 2: Model registry with open_clip architectures and checkpoint registrations

**Files:**
- Modify: `service/gods_eye/clip_models.py`
- Create: `service/gods_eye/checkpoint_registry.py`
- Test: `service/tests/test_clip_models.py` (extend), `service/tests/test_checkpoint_registry.py`

**Interfaces:**
- Produces in `clip_models.py`:

```python
Backend = Literal["hf", "openclip"]
ModelGroup = Literal["reference", "baseline", "fine-tuned"]

@dataclass(frozen=True, slots=True)
class OpenClipArch:
    model_name: str
    pretrained: str
    img_height: int
    img_width: int
    preprocess_mode: Literal["reid", "model_reid"]

    @property
    def baseline_model_id(self) -> str: ...   # "openclip/ViT-B-16@openai:384x128-reid"
    @property
    def baseline_storage_key(self) -> str: ... # "openclip-vit-b-16-openai-384x128-reid"
    @property
    def baseline_label(self) -> str: ...       # "ViT-B/16 zero-shot · 384×128 ReID"

@dataclass(frozen=True, slots=True)
class PretrainedSource:
    repo_id: str
    filename: str
    revision: str   # 40-hex
    quick_gelu: bool

@dataclass(frozen=True, slots=True)
class ClipModelSpec:
    model_id: str
    label: str
    storage_key: str
    backend: Backend = "hf"
    group: ModelGroup = "reference"
    arch: OpenClipArch | None = None
    paired_baseline_id: str | None = None
    checkpoint_dir: Path | None = None
    verified: bool = True
    registered_at: str | None = None

PRETRAINED_SOURCES: Final[dict[tuple[str, str], PretrainedSource]]  # ("ViT-B-16","openai") only
VERIFIED_ARCHS: Final[frozenset[tuple[str, str]]] = frozenset({("ViT-B-16", "openai")})
CHECKPOINT_ID_PATTERN: Final = re.compile(r"labclip:cuhk-pedes:[0-9a-f]{12}")
BASELINE_ID_PATTERN: Final = re.compile(r"openclip/([A-Za-z0-9._-]+)@([A-Za-z0-9._-]+):(\d+)x(\d+)-(reid|model_reid)")

def parse_baseline_id(model_id: str) -> OpenClipArch: ...  # raises UnsupportedClipModelError
def is_known_model_id_shape(model_id: str) -> bool: ...    # builtin, baseline or checkpoint pattern

class ModelRegistry:
    def __init__(self, checkpoint_root: Path | None) -> None: ...
    def get(self, model_id: str) -> ClipModelSpec: ...  # raises UnsupportedClipModelError
    def all(self) -> tuple[ClipModelSpec, ...]: ...     # builtins, then baselines referenced by checkpoints, then checkpoints newest first

def checkpoint_root_for(cache_dir: Path) -> Path:  # cache_dir / "labclip-checkpoints"
```

`get_clip_model(model_id)` keeps returning only built-in HF specs (existing tests stay green). Baselines are resolvable by id alone (`parse_baseline_id`), even if no checkpoint references them, but `all()` lists only referenced ones.

- Produces in `checkpoint_registry.py`:

```python
REGISTRATION_SCHEMA_VERSION = 1

class CheckpointValidationError(ValueError): ...

@dataclass(frozen=True, slots=True)
class Registration:
    model_id: str
    label: str
    weights_sha256: str
    source_sha256: str
    source_filename: str
    arch: OpenClipArch
    verified: bool
    registered_at: str
    provenance: dict      # epoch, global_step, best_val_score, ema_enabled, train_split, val_split, eval_split, wandb (dict|None)
    reference_metrics: dict | None  # {"source": str, "metrics": {"top1":..,"top5":..,"top10":..,"mAP":..,"mINP":..}, "gallery": int, "queries": int}

    @property
    def paired_baseline_id(self) -> str: ...
    def to_spec(self, checkpoint_dir: Path) -> ClipModelSpec: ...

def validate_labclip_args(args: Mapping[str, object]) -> OpenClipArch: ...
def checkpoint_model_id(weights_sha256: str) -> str: ...     # "labclip:cuhk-pedes:" + sha[:12]
def default_label(registration_fields) -> str: ...           # "FT · <wandb run_id or file stem> · val R@1 78.0"
def write_registration(root: Path, registration: Registration) -> Path: ...  # atomic json
def read_registrations(root: Path) -> tuple[tuple[Registration, Path], ...]: ...  # skips unreadable dirs
def find_registration(root: Path, model_id: str) -> tuple[Registration, Path] | None: ...
def remove_registration(root: Path, model_id: str) -> Registration: ...
```

- [ ] **Step 1: Write failing tests** in `test_checkpoint_registry.py`:

```python
import pytest
from gods_eye.checkpoint_registry import CheckpointValidationError, checkpoint_model_id, validate_labclip_args

VALID = {"dataset": "cuhk-pedes", "train_split": "train", "val_split": "val", "eval_split": "val",
         "model_name": "ViT-B-16", "pretrained": "openai", "img_height": 384, "img_width": 128,
         "preprocess_mode": "reid"}


def test_valid_args_produce_arch() -> None:
    arch = validate_labclip_args(VALID)
    assert arch.baseline_model_id == "openclip/ViT-B-16@openai:384x128-reid"


@pytest.mark.parametrize(("key", "value", "message"), [
    ("dataset", "icfg-pedes", "cuhk-pedes"),
    ("train_split", "trainval", "train split"),
    ("val_split", "test", "selected on the test split"),
    ("eval_split", "test", "selected on the test split"),
    ("preprocess_mode", "model", "preprocess_mode"),
    ("img_height", 0, "image size"),
])
def test_invalid_args_are_rejected(key, value, message) -> None:
    with pytest.raises(CheckpointValidationError, match=message):
        validate_labclip_args({**VALID, key: value})


def test_missing_split_metadata_is_rejected() -> None:
    args = dict(VALID); del args["train_split"]
    with pytest.raises(CheckpointValidationError, match="train_split"):
        validate_labclip_args(args)


def test_checkpoint_model_id_uses_weights_digest_prefix() -> None:
    assert checkpoint_model_id("ab" * 32) == "labclip:cuhk-pedes:abababababab"
```

Plus round-trip tests: `write_registration` then `read_registrations`/`find_registration`/`remove_registration` in `tmp_path`; `ModelRegistry(tmp_path).all()` order (4 HF, then one baseline, then checkpoints newest first by `registered_at`); `ModelRegistry.get` for an unregistered but well-formed checkpoint id raises `UnsupportedClipModelError`; `parse_baseline_id` round-trips `OpenClipArch.baseline_model_id`; unknown `(model_name, pretrained)` without a `PRETRAINED_SOURCES` entry is rejected by `validate_labclip_args` with "no pinned pretrained source".

- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** both modules. Rules for `validate_labclip_args`: every key in `VALID` must exist; `dataset == "cuhk-pedes"`; `train_split == "train"`; `"test" not in {val_split, eval_split}`; `preprocess_mode in {"reid","model_reid"}`; `img_height, img_width` ints ≥ 1; `(model_name, pretrained) in PRETRAINED_SOURCES`. `verified = (model_name, pretrained) in VERIFIED_ARCHS`. Storage key of a checkpoint is `"labclip-" + sha[:12]`.
- [ ] **Step 4: Run** `pytest service/tests/test_clip_models.py service/tests/test_checkpoint_registry.py -q` → PASS.
- [ ] **Step 5: Commit** `feat(service): add model registry for open_clip baselines and imported checkpoints`.

---

### Task 3: OpenClipEmbedder, embedder dispatch, and batch text embedding

**Files:**
- Create: `service/gods_eye/openclip_embedder.py`, `service/gods_eye/embedders.py`
- Modify: `service/gods_eye/clip.py` (add `embed_texts`, `text_only`), `pyproject.toml` (`open_clip_torch==3.3.0`, `safetensors>=0.4`, `huggingface_hub>=0.25` in `clip` extra), `uv.lock`
- Modify: `service/gods_eye/retrieval.py` (`TextEmbedder` gains `embed_texts`; `EmbedderFactory` gains keyword `text_only: bool = False`)
- Test: `service/tests/test_embedders.py` (unit, torch-free via fakes), `service/tests/test_openclip_integration.py` (`@pytest.mark.integration`)

**Interfaces:**
- Consumes: `ModelRegistry`, `ClipModelSpec`, `PRETRAINED_SOURCES`, `batch_preprocess`.
- Produces:

```python
class OpenClipEmbedder:
    dimension: int
    def __init__(self, spec: ClipModelSpec, *, revision: str | None, device: str = "auto",
                 offline: bool = False, cache_dir: Path | None = None, text_only: bool = False): ...
    def embed_text(self, text: str) -> np.ndarray: ...
    def embed_texts(self, texts: Sequence[str], batch_size: int = 256) -> np.ndarray: ...
    def embed_images(self, images: Sequence[Image.Image]) -> np.ndarray: ...
    def close(self) -> None: ...

def baseline_weights_path(arch: OpenClipArch, *, revision: str, cache_dir: Path | None, offline: bool) -> Path: ...
def create_embedder(model_id: str, *, revision: str | None, device: str, offline: bool,
                    cache_dir: Path | None, text_only: bool = False) -> RuntimeEmbedder: ...
```

Behavior:
- Build: `open_clip.create_model(arch.model_name, pretrained=None, force_image_size=(H, W), force_quick_gelu=source.quick_gelu)`.
- Baseline: `hf_hub_download(source.repo_id, source.filename, revision=revision or source.revision, cache_dir=cache_dir, local_files_only=offline)` then `open_clip.load_checkpoint(model, path)` (resizes positional embedding like lab_clip). The resolved revision is the snapshot directory name of the returned path; raise `ClipLoadError` if it differs from the requested revision.
- Checkpoint: `safetensors.torch.load_file(spec.checkpoint_dir / "model.safetensors")` then `model.load_state_dict(state, strict=True)`; if `revision` is `sha256:<hex>` verify the file digest first.
- Image preprocessing: `batch_preprocess(images, height=H, width=W, **mode_options)` where `reid` uses CLIP mean/std + bilinear, `model_reid` uses `open_clip.get_model_preprocess_cfg(model)` mean/std/interpolation.
- Text: `open_clip.get_tokenizer(arch.model_name)`; `encode_text` in `inference_mode`, fp32, L2 normalize.
- `text_only=True`: after loading set `model.visual = None` and free CUDA cache; `embed_images` raises `ClipLoadError`.
- `create_embedder`: resolve spec via `ModelRegistry(checkpoint_root_for(cache_dir) if cache_dir else None)`; `hf` → `HuggingFaceClipEmbedder(..., text_only=...)` (text_only drops `vision_model`), `openclip` → `OpenClipEmbedder`.
- All torch/open_clip imports live inside functions/constructors.

- [ ] **Step 1: Write failing unit tests** (`test_embedders.py`): monkeypatch `gods_eye.embedders.OpenClipEmbedder` and `HuggingFaceClipEmbedder` with recording fakes; assert `create_embedder("openclip/ViT-B-16@openai:384x128-reid", ...)` builds the OpenCLIP fake with the parsed arch, a registered checkpoint id (written with `write_registration` into `tmp_path/"labclip-checkpoints"`) builds it with `checkpoint_dir`, `openai/clip-vit-base-patch16` builds the HF fake, and an unknown id raises `UnsupportedClipModelError`.
- [ ] **Step 2: Write integration test** (`test_openclip_integration.py`, `pytestmark = pytest.mark.integration`, skipped unless `open_clip` is importable and the pinned snapshot exists in `GODS_EYE_HF_CACHE` or `~/.cache/huggingface/hub`): build the baseline `OpenClipEmbedder` on CPU, embed the golden images and captions from Task 1, and assert per-row cosine with `embeddings.npz` ≥ 0.9999.
- [ ] **Step 3: Run** → FAIL. **Step 4: Implement.** Add dependencies with `uv add --optional clip "open_clip_torch==3.3.0" "safetensors>=0.4" "huggingface_hub>=0.25"` (verify `uv.lock` updates and `uv sync --extra indexing` still works without torch).
- [ ] **Step 5: Run** unit tests (CI set) and `uv run --extra clip --extra indexing pytest -m integration service/tests/test_openclip_integration.py -q` locally → PASS.
- [ ] **Step 6: Commit** `feat(service): add open_clip embedder backend behind the embedder seam`.

---

### Task 4: Checkpoint import and removal

**Files:**
- Create: `service/gods_eye/checkpoint_import.py`
- Test: `service/tests/test_checkpoint_import.py` (`torch = pytest.importorskip("torch")`, `open_clip = pytest.importorskip("open_clip")`)

**Interfaces:**
- Consumes: `validate_labclip_args`, `checkpoint_model_id`, `write_registration`, `Registration`, `PRETRAINED_SOURCES`.
- Produces:

```python
@dataclass(frozen=True, slots=True)
class ImportResult:
    registration: Registration
    directory: Path
    reused: bool

def import_checkpoint(source: Path, *, checkpoint_root: Path, label: str | None = None,
                      reference_metrics: Path | None = None, now: datetime | None = None,
                      build_model: Callable[[OpenClipArch], "torch.nn.Module"] | None = None) -> ImportResult: ...
def load_reference_metrics(path: Path) -> dict: ...   # parses lab_clip *_test.json; requires dataset=="cuhk-pedes", split=="test", direction=="text-to-image"
```

Steps inside `import_checkpoint`:
1. `sha256` of the source file (streamed).
2. `torch.load(source, map_location="cpu", weights_only=True)`; any exception → `CheckpointValidationError("... cannot be read without unpickling code ...")`.
3. Require dict with `model_state_dict` (Mapping of tensors) and `args` (Mapping).
4. `arch = validate_labclip_args(args)`.
5. `model = (build_model or _build_openclip)(arch)`; `model.load_state_dict(state, strict=True)`; failure → `CheckpointValidationError("state dict does not match ...")`.
6. Write `model.safetensors` (contiguous CPU tensors via `safetensors.torch.save_file`) to a temp dir inside `checkpoint_root`, hash it → `weights_sha256`, final dir `checkpoint_root / weights_sha256`; if it already exists with a readable registration return `reused=True` (idempotent, label unchanged unless `label` given).
7. Read optional sibling `wandb_meta.json` (keys `run_id`, `project`, `entity`, `group`, `pipeline_result_uri`).
8. Write `labclip_args.json` (JSON-safe copy of `args`) and `registration.json`; `os.replace` the temp dir into place.

- [ ] **Step 1: Write failing tests** with a tiny stand-in model: `build_model=lambda arch: torch.nn.Linear(2, 2)`; save fixture checkpoints with `torch.save({"model_state_dict": linear.state_dict(), "args": VALID_ARGS, "epoch": 9, "global_step": 302, "best_val_score": 0.78}, path)`. Cases: success writes three files and registration fields (model id prefix matches weights hash, provenance epoch 9, paired baseline id); re-import is `reused=True`; `args` with `eval_split="test"` rejected and nothing written; mismatched state dict (Linear(3,3)) rejected; a pickle containing a custom class (`torch.save({"x": _Custom()})`) rejected with the weights-only message; `wandb_meta.json` sibling captured; `reference_metrics` parsed from a copy of the lab_clip JSON structure (write a minimal JSON in the test: `{"dataset":"cuhk-pedes","split":"test","direction":"text-to-image","queries":6156,"gallery":3074,"metrics":{...}}`).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(service): import lab_clip checkpoints as weights-only safetensors registrations`.

---

### Task 5: Benchmark protocol — test captions, metrics, Benchmark Queries, evaluation files

**Files:**
- Create: `service/gods_eye/benchmark.py`
- Test: `service/tests/test_benchmark.py`

**Interfaces:**
- Produces:

```python
BENCHMARK_QUERY_COUNT = 48
BENCHMARK_QUERY_SEED = 20260925
EVALUATION_SCHEMA_VERSION = 1
REFERENCE_WARNING_PP = 0.5

@dataclass(frozen=True, slots=True)
class TestCaption:
    caption: str
    person_id: str
    relative_path: str

def load_test_captions(metadata: Path) -> tuple[TestCaption, ...]: ...
# rows with split == "test" and non-blank captions, one TestCaption per caption, file order

def gallery_person_ids(manifest: GalleryManifest) -> list[frozenset[str]]: ...
# per record: canonical source_person_id plus alias person ids

def retrieval_metrics(similarity: np.ndarray, query_person_ids: Sequence[str],
                      gallery_person_ids: Sequence[frozenset[str]]) -> dict[str, float]: ...
# top1/top5/top10/mAP/mINP exactly as lab_clip retrieval_metrics_from_similarity (stable descending sort)

def first_match_ranks(similarity: np.ndarray, query_person_ids, gallery_person_ids) -> np.ndarray: ...  # 1-based

@dataclass(frozen=True, slots=True)
class BenchmarkQuery:
    id: str          # "bq_" + sha256(f"{relative_path}\n{caption}")[:16]
    caption: str
    person_id: str

def sample_benchmark_queries(captions: Sequence[TestCaption], *, count=BENCHMARK_QUERY_COUNT,
                             seed=BENCHMARK_QUERY_SEED) -> tuple[BenchmarkQuery, ...]: ...
# sort unique person ids; random.Random(seed).sample(ids, count); for each id pick
# random.Random(f"{seed}:{pid}").choice(captions of that id in file order); keep sampled-id order

def write_benchmark_queries(path: Path, queries, *, manifest_sha256: str) -> None: ...
def read_benchmark_queries(path: Path, *, manifest_sha256: str | None = None) -> tuple[BenchmarkQuery, ...]: ...

@dataclass(frozen=True, slots=True)
class Evaluation:
    model_id: str
    index_version: str
    model_revision: str
    created_at: str
    query_count: int
    gallery_count: int
    metrics: dict[str, float]
    benchmark_query_ranks: dict[str, int]
    reference: dict | None     # {"source","metrics","gallery","queries","delta_top1_pp","warning": bool}

def evaluate(embed_texts: Callable[[Sequence[str]], np.ndarray], loaded: LoadedIndex,
             captions: Sequence[TestCaption], benchmark_queries: Sequence[BenchmarkQuery], *,
             model_id: str, model_revision: str, reference_metrics: dict | None,
             now: datetime) -> Evaluation: ...
def evaluation_path(index_root: Path, version_id: str) -> Path: ...  # index_root/"evaluations"/f"{version_id}.json"
def write_evaluation(path: Path, evaluation: Evaluation) -> None: ...   # refuses to overwrite a different payload
def read_evaluation(path: Path) -> Evaluation: ...
```

Query filtering in `evaluate`: keep captions whose `person_id` appears in some gallery record (lab_clip `keep_queries_with_gallery_match`); record the count.

- [ ] **Step 1: Write failing tests**:

```python
import numpy as np
from gods_eye.benchmark import retrieval_metrics, first_match_ranks

def test_metrics_match_labclip_definitions() -> None:
    similarity = np.array([[0.9, 0.8, 0.1], [0.2, 0.9, 0.8]], dtype=np.float32)
    queries = ["1", "2"]
    gallery = [frozenset({"1"}), frozenset({"2"}), frozenset({"2"})]
    metrics = retrieval_metrics(similarity, queries, gallery)
    assert metrics["top1"] == 1.0
    assert metrics["mAP"] == 1.0
    assert metrics["mINP"] == 1.0
    ranks = first_match_ranks(similarity[::-1].copy(), ["1", "2"], gallery)
    assert ranks.tolist() == [3, 2]
```

Add further hand-computed cases covering: a miss at rank 1 (top1 0.5), multiple positives (AP = mean of precision at each positive), mINP = positives / rank of last positive, an alias record matching two person ids, and ties resolved by stable order (lower index first). Also include a cross-check test that runs a random 20x30 case through a pure-Python reference implementation written in the test.

Also test: `load_test_captions` on a tiny `reid_raw.json` in `tmp_path` (train/val rows ignored, blank captions skipped); `sample_benchmark_queries` is deterministic, one per person id, count capped at number of ids, stable ids; `write/read_benchmark_queries` rejects a manifest digest mismatch; `evaluate` with a numpy `LoadedIndex` built through `index_store.build_index(..., backend="numpy")` over a fixture gallery (reuse helpers in `test_index_store.py`) and a deterministic `embed_texts` returns ranks for every benchmark query and a reference block with `warning` true when |Δ| > 0.5 pp; `write_evaluation` refuses to overwrite different content.

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** (vectorized numpy: `order = np.argsort(-similarity, axis=1, kind="stable")`; build `matches` by mapping each gallery row to the set membership of the query's person id via a `dict[str, np.ndarray[bool]]` cache per person id). **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(service): add benchmark protocol, metrics and Benchmark Queries`.

---

### Task 6: Preparation pipeline — registry-aware models, evaluation stage, worker operations

**Files:**
- Modify: `service/gods_eye/preparation.py`, `preparation_state.py`, `preparation_worker.py`, `fixture_preparation.py`, `index_store.py` (build CLI dispatch uses `create_embedder`)
- Test: `service/tests/test_preparation_models.py` (extend), `service/tests/test_preparation_worker.py` (new, fakes)

**Interfaces:**
- Consumes: `ModelRegistry`, `create_embedder`, benchmark functions, `checkpoint_root_for`.
- Produces:
  - `MODEL_STAGES = ("model", "index", "evaluation", "smoke_test")`; `model_preparation/ensure_model_preparation` validate ids through `is_known_model_id_shape` instead of `get_clip_model`.
  - `PreparationPaths.for_model(model_id)` uses `ModelRegistry(checkpoint_root_for(self.model_cache)).get(model_id).storage_key`; new `PreparationPaths.benchmark_queries` = `root/"indexes"/"benchmark-queries.json"`; `ModelPreparationPaths.evaluations` = `index_root/"evaluations"`.
  - `_parse_model_receipt` accepts 40-hex commits or `sha256:<64 hex>`.
  - Stage 7 of 8 "benchmark evaluation" between index and smoke: ensures Benchmark Queries (worker `build-benchmark-queries --manifest --metadata --output`, reused when `manifest_sha256` matches), then worker `evaluate <active> --model-id --revision --cache-dir --dataset-root --metadata --benchmark-queries --output` where output is `evaluation_path(model_paths.index_root, version_id)`; reused when the stored evaluation matches index version + revision. For `group == "reference"` a failure is logged and stored as `{"status": "failed", "error": ...}` without aborting; for other groups it raises `PreparationError`.
  - Stage labels become "Stage N/8"; smoke is 8.
  - Worker: `prepare-model/verify-model` dispatch by backend: HF unchanged; openclip baseline downloads/validates the pinned file and prints `{"model_id", "resolved_revision": <40-hex snapshot>}`; checkpoint verifies `model.safetensors` sha256 and prints `resolved_revision: "sha256:<hex>"`. `build-index` and `smoke-search` use `create_embedder`. New ops `build-benchmark-queries` and `evaluate` (text embedding in batches of 256; OOM exit code preserved).
  - Metadata path for CUHK-PEDES: `dataset_root / "CUHK-PEDES" / "reid_raw.json"` (from `dataset_registry.json` `metadata`).
  - `fixture_preparation.prepare_fixture` writes a fixture evaluation stage record too.

- [ ] **Step 1: Write failing tests** following the existing `FakeRunner` pattern in `test_preparation_models.py`: (a) preparing a checkpoint id runs operations in order `prepare-model, verify-manifest/build-manifest, build-index, validate-index, activate-index, build-benchmark-queries, evaluate, smoke-search` and stores `evaluation` state with `status: verified`; (b) a reference HF model whose `evaluate` fails still completes smoke and records `evaluation.status == "failed"`; (c) a checkpoint whose `evaluate` fails raises `PreparationError`; (d) `sha256:` receipts are accepted, malformed ones rejected; (e) re-running reuses verified evaluation (no second `evaluate` call). In `test_preparation_worker.py` call `preparation_worker.main([...])` with monkeypatched `create_embedder` returning a deterministic fake and a numpy-backed index fixture to cover `build-benchmark-queries` and `evaluate` writing files.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** the whole suite → PASS (existing preparation/launcher tests must stay green; update expected "Stage N/7" strings to "/8" where asserted).
- [ ] **Step 5: Commit** `feat(service): add registry-aware preparation with benchmark evaluation stage`.

---

### Task 7: Launcher commands — `prepare --checkpoint`, `checkpoint list/remove`, host bind

**Files:**
- Modify: `service/gods_eye/launcher_cli.py`, `gods-eye` (root wrapper), `service/gods_eye/launcher_lifecycle.py` (only if reset paths must include `labclip-checkpoints` — they already sit under the model cache, so `reset --model-cache` removes them; document it)
- Test: `service/tests/test_launcher_command.py` (extend), `service/tests/test_root_launcher_image.py` (wrapper arg rewrite, non-integration part)

**Interfaces:**
- `prepare` options: `--checkpoint PATH` (repeatable), `--label TEXT` (only with exactly one `--checkpoint`), `--reference-metrics PATH` (only with exactly one `--checkpoint`); `--model-id` loses `choices` and is validated with `ModelRegistry` after imports.
- Order in `_prepare`: datasets → for each checkpoint `import_checkpoint(...)` (print model id + label) → model list = explicit `--model-id` values + for each imported checkpoint `[paired_baseline_id, checkpoint_id]` (deduplicated, first-seen) → default `[DEFAULT_MODEL_ID]` only when nothing else was requested → `prepare_model_index` for each.
- `checkpoint list [--json]`: prints model id, label, verified flag, paired baseline, registered_at, prepared/evaluation status from state.
- `checkpoint remove MODEL_ID [--yes]`: under `mutation_lock`; deletes `labclip-checkpoints/<sha>`, `indexes/models/<storage_key>`, `preparation.models[MODEL_ID]`; deletes the Paired Baseline's index/state only when no remaining registration references it. Without `--yes` on a TTY asks for confirmation; non-TTY without `--yes` exits `EXIT_CONFIRMATION`.
- Wrapper: when the first argument is `prepare`, rewrite each `--checkpoint X` / `--reference-metrics X` (both `--opt X` and `--opt=X` forms): if `X` resolves inside `SCRIPT_DIR`, replace with `/workspace/<relative>`; otherwise add `-v "<dirname X>:/import/<n>:ro"` to the `docker compose run` invocation and replace with `/import/<n>/<basename>`. Missing files fail fast in the wrapper with exit 2.

- [ ] **Step 1: Write failing tests** for parser behavior (`--label` with two checkpoints → usage error `EXIT_USAGE`), `_prepare` ordering with monkeypatched `import_checkpoint`/`prepare_model_index`, `checkpoint remove` shared-baseline retention, and the wrapper rewrite (run the wrapper's rewrite in isolation by extracting it into a POSIX function `gods_eye_rewrite_import_args` and testing through `sh -c '. ./gods-eye-lib.sh; ...'` — if extracting a lib file is needed, create `scripts/launcher-args.sh` sourced by `gods-eye` and include it in the source fingerprint).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** full suite → PASS.
- [ ] **Step 5: Commit** `feat(launcher): import and remove fine-tuned checkpoints from the Launcher`.

---

### Task 8: Runtime — registry catalog, LRU residency, evaluations, benchmark API

**Files:**
- Modify: `service/gods_eye/config.py` (`resident_models: int = 4`), `retrieval.py`, `model_runtime.py`, `models.py`, `app.py`
- Test: `service/tests/test_model_runtime.py`, `service/tests/test_api.py`, `service/tests/test_benchmark_api.py` (new)

**Interfaces:**
- `retrieval.py`: `IndexedRetrievalEngine.rank_all(query) -> tuple[np.ndarray, np.ndarray]` (scores, rows over the whole gallery); `RuntimeModelAvailability` gains `group: str = "reference"`, `paired_baseline_id: str | None = None`, `verified: bool = True`, `registered_at: str | None = None`, `evaluation_ready: bool = False`.
- `models.py`:

```python
class ModelAvailability(BaseModel):  # add
    group: Literal["reference", "baseline", "fine-tuned"] = "reference"
    paired_baseline_id: str | None = None
    verified: bool = True
    registered_at: str | None = None
    evaluation_ready: bool = False

class SearchRequest:  # model_id validator now uses is_known_model_id_shape (unknown shapes → 422)

class BenchmarkMetrics(BaseModel): top1: float; top5: float; top10: float; mAP: float; mINP: float
class BenchmarkReference(BaseModel): source: str; metrics: BenchmarkMetrics; gallery: int; queries: int; delta_top1_pp: float; warning: bool
class ModelBenchmark(BaseModel):
    model_id: str; label: str; group: str; paired_baseline_id: str | None; verified: bool
    index_version: str | None; metrics: BenchmarkMetrics | None
    delta_vs_baseline_pp: BenchmarkMetrics | None; reference: BenchmarkReference | None
    provenance: dict[str, str | int | float | None] | None
    benchmark_query_ranks: dict[str, int]
class BenchmarkProtocol(BaseModel): dataset: str = "CUHK-PEDES"; split: str = "test"; direction: str = "text-to-image"; ground_truth: str = "person-id"; query_count: int | None; gallery_count: int | None
class BenchmarkResponse(BaseModel): protocol: BenchmarkProtocol; models: list[ModelBenchmark]
class BenchmarkQueryItem(BaseModel): id: str; caption: str
class BenchmarkQueriesResponse(BaseModel): queries: list[BenchmarkQueryItem]
class BenchmarkSearchRequest(BaseModel): query_id: str; model_id: str; top_k: int = Field(24, ge=1, le=100)
class BenchmarkSearchResult(SearchResult): is_match: bool
class BenchmarkSearchResponse(BaseModel): query_id: str; caption: str; model_id: str; active_index_version: str; first_match_rank: int; results: list[BenchmarkSearchResult]
```

- `ModelRuntimeManager`: builds `ModelRegistry(checkpoint_root_for(self._hf_cache))`, scans `registry.all()`; asset checks per backend (HF snapshot dir; openclip baseline pinned snapshot file; checkpoint `model.safetensors` present); for `group != "reference"` the model is ready only if an evaluation exists for the active version (`guidance="Benchmark evaluation is missing; rerun './gods-eye prepare --model-id …'."`). Loads `benchmark-queries.json` (manifest digest must match the active manifest). Residency: `OrderedDict[str, RuntimeEmbedder]` capped by `resident_models`, factory called with `text_only=True`, least-recently-used embedder closed on overflow; a failure evicts only that model. Default `embedder_factory=create_embedder`.
- New methods: `benchmark() -> BenchmarkResponse`, `benchmark_queries() -> tuple[BenchmarkQuery, ...]`, `benchmark_search(model_id, query_id, top_k) -> BenchmarkSearchResponse`.
- `app.py`: `GET /api/benchmark`, `GET /api/benchmark/queries`, `POST /api/benchmark/search` (404 unknown query id, 409/503 like `/api/search`, logging never includes caption text). `ModelRuntime` protocol and `_RetrievalRuntimeAdapter` get the three methods (adapter returns empty benchmark / 404).
- `FixtureModelRuntime`: adds `openclip/ViT-B-16@openai:384x128-reid` (baseline) and `labclip:cuhk-pedes:0123456789ab` (fine-tuned, label "FT · fixture · val R@1 78.0") with synthetic evaluations (e.g. baseline top1 0.31, fine-tuned 0.70), three synthetic Benchmark Queries with invented captions (not dataset text), deterministic ranks giving one improved, one same, one worse.

- [ ] **Step 1: Write failing tests**: LRU (capacity 2, search A, B, A, C → B closed, A resident; factory called with `text_only=True`); checkpoint model without evaluation is not ready; benchmark response computes `delta_vs_baseline_pp` = (ft − baseline)·100 per metric; `/api/benchmark/queries` returns only ids+captions of the stored sample; `/api/benchmark/search` marks `is_match` and `first_match_rank` using manifest person ids (use fixture `GalleryManifest` + numpy index from `test_index_store` helpers with the fake embedder); `/api/search` body still contains no "caption"; the benchmark endpoints never return a caption that is not in the sample (write a train-split caption into the fixture metadata and assert its absence); unknown model id shape → 422; well-formed but unregistered checkpoint id → 409.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** full suite → PASS.
- [ ] **Step 5: Commit** `feat(service): serve checkpoints with LRU residency and benchmark endpoints`.

---

### Task 9: Web — Search/Compare/Benchmark modes

**Files:**
- Modify: `web/src/types.ts` (`ModelId = string`, new response types), `web/src/api.ts` (`fetchBenchmark`, `fetchBenchmarkQueries`, `searchBenchmark`), `web/src/main.tsx` (mode switch), `web/src/styles.css`
- Create: `web/src/compare.ts` (pure helpers), `web/src/CompareScreen.tsx`, `web/src/BenchmarkScreen.tsx`, `web/src/BenchmarkChart.tsx`
- Test: `web/src/compare.test.ts`, `web/src/api.test.ts` (extend), `web/e2e/compare.spec.ts`

**Interfaces:**
- `compare.ts`:

```ts
export type Outcome = 'improved' | 'same' | 'worse'
export function outcome(baselineRank: number, candidateRank: number): Outcome
export function outcomeCounts(ranksA: Record<string, number>, ranksB: Record<string, number>): Record<Outcome, number>
export function defaultComparePair(models: readonly ModelAvailability[]): { left: string | null; right: string | null }
// right = newest ready fine-tuned by registered_at; left = its paired_baseline_id if ready, else first ready baseline, else default HF model
export function formatDelta(pp: number): string // "+38.9 pp" / "−1.2 pp" / "±0.0 pp"
```

- Mode switch in the masthead: `Search` (existing flow untouched), `Compare`, `Benchmark` — `role="tablist"`, keyboard accessible, remembered in `localStorage` inside try/catch.
- Compare: two model selects (ready models only, grouped by `group` with optgroup labels "Fine-tuned", "Paired baseline", "Reference (HF 224 center-crop)"), a source toggle "Free text" / "Benchmark Query"; Benchmark Query picker lists captions filtered by outcome chips "Improved n / Same n / Worse n / All" computed with `outcomeCounts` from `/api/benchmark` ranks; runs both searches in parallel (`Promise.all`, abortable); two result grids side by side (top-k 12 default); in Benchmark Query mode each grid header shows `Ground truth first appears at #r`, matching cards get a "Match" badge, and a summary badge `Baseline #37 → Fine-tuned #1` sits above the grids.
- Benchmark: protocol note (fixed text: "CUHK-PEDES test split · text→image · person-ID ground truth · computed from God's Eye's active index"); table columns Model, Group, R@1, R@5, R@10, mAP, mINP, Δ R@1 vs paired baseline, lab_clip ref (R@1 and Δ with a warning icon when `warning`), Provenance (W&B run, epoch, EMA, verified badge); one grouped bar chart (`BenchmarkChart`, inline SVG) of R@1/R@5/R@10/mAP for the selected fine-tuned model and its paired baseline. Load the `dataviz` skill before writing the chart.

- [ ] **Step 1: Write failing Vitest tests** for `outcome`, `outcomeCounts` (only ids present in both), `defaultComparePair` (newest fine-tuned wins; falls back when baseline not ready), `formatDelta`, and API helpers (mock `fetch`, assert request bodies and error mapping reuse `errorMessage`).
- [ ] **Step 2: Run** `corepack pnpm --dir web test` → FAIL. **Step 3: Implement** helpers and components.
- [ ] **Step 4: Write Playwright spec** `web/e2e/compare.spec.ts` against the fixture service: Compare tab defaults to fixture baseline vs fixture fine-tuned; choosing a Benchmark Query shows the rank badge and "Match" badges; outcome chips show 1/1/1; Benchmark tab shows the table with `+39.0 pp` and the chart has an accessible title. Keep existing `search.spec.ts` passing (update its mocked catalog type only if needed).
- [ ] **Step 5: Run** unit + `corepack pnpm --dir web test:e2e` + `corepack pnpm --dir web build` → PASS.
- [ ] **Step 6: Commit** `feat(web): add Compare and Benchmark modes`.

---

### Task 10: Documentation and wording

**Files:**
- Create: `docs/adr/0003-fine-tuned-checkpoint-import-and-benchmark-exposure.md`, `docs/setup/fine-tuned-checkpoints.md`
- Modify: `CONTEXT.md`, `docs/setup/model-and-index.md` (link + Stage 8 wording), `README.md` (one-paragraph pointer), `service/gods_eye/acceptance.py:116` scope text, `service/tests/test_acceptance.py` if it asserts the text

**Content:**
- ADR 0003: context (need to show fine-tuning gains; lab_clip checkpoint format), decision (weights-only import → safetensors; test-selected checkpoints rejected; Paired Baseline; evaluation computed from the active index; captions exposed only as Benchmark Queries), consequences (model cache holds checkpoints; `reset --model-cache` removes them; evaluation stage adds minutes; caption exposure narrowed but not zero).
- `CONTEXT.md` terms (with _Avoid_ lines): **Fine-tuned Checkpoint**, **Paired Baseline**, **Benchmark Evaluation**, **Benchmark Query**; amend **Gallery Manifest**: "Captions are never exposed except as Benchmark Queries."
- Setup guide: import command examples with `/mnt/data/lab_clip/artifacts/downloaded/val-kfold-test/cuhk-pedes/best_t2i_eval_compat.pt` and `--reference-metrics /mnt/data/lab_clip/results/08-24/val-kfold-test/cuhk-pedes_test.json`; what gets validated; list/remove; the 3,073 vs 3,074 gallery note; troubleshooting (weights-only failure, test-selected rejection, reference warning).
- `acceptance.py`: scope becomes "qualitative research acceptance; benchmark metrics are reported separately by Benchmark Evaluation and are not biometric identification accuracy".

- [ ] **Step 1: Write/modify docs.** **Step 2: Run** full suite + ruff. **Step 3: Commit** `docs: record fine-tuned checkpoint comparison decisions and operator guide`.

---

### Task 11: Live verification and pull request

- [ ] **Step 1:** Build and prepare for real: `./gods-eye prepare --checkpoint /mnt/data/lab_clip/artifacts/downloaded/val-kfold-test/cuhk-pedes/best_t2i_eval_compat.pt --reference-metrics /mnt/data/lab_clip/results/08-24/val-kfold-test/cuhk-pedes_test.json --yes`. Confirm manifest is rebuilt test-only (3,073 records), baseline and checkpoint indexes are active, evaluations exist.
- [ ] **Step 2:** Compare the checkpoint evaluation to lab_clip (R@1 70.1): expect |Δ| ≤ 0.5 pp; if larger, stop and debug with superpowers:systematic-debugging (preprocessing, tokenizer, EMA weights, alias handling) before continuing.
- [ ] **Step 3:** `./gods-eye start`, exercise Compare (free text and Benchmark Query) and Benchmark in the browser; capture screenshots for the PR.
- [ ] **Step 4:** `./gods-eye checkpoint list`; re-run prepare to confirm reuse; do not remove the real checkpoint.
- [ ] **Step 5:** Full verification: `uv run --extra indexing pytest -q -rs`, `uv run ruff check service scripts`, web unit/e2e/build, integration tests for open_clip.
- [ ] **Step 6:** Push and open one PR into `develop` summarizing decisions, measured baseline vs fine-tuned metrics, lab_clip delta, and screenshots; body ends with the Claude Code attribution line.
