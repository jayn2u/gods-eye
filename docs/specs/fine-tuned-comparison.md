# Fine-tuned checkpoint comparison

Status: accepted (grilling session, 2026-09-25)

## Goal

Serve lab_clip checkpoints fine-tuned on the CUHK-PEDES **train** split inside the Full Demo and
show how much they improve text-to-image person retrieval over an equal-preprocessing zero-shot
baseline — quantitatively (benchmark metrics), qualitatively (side-by-side results), and through
ground-truth rank examples. The audience is an internal research demo run through the local
Docker Launcher.

## Source facts

- lab_clip (`/mnt/data/lab_clip`) trains `open_clip` models (`ViT-B-16`, `pretrained=openai`,
  `force_quick_gelu=True`) with full backbone training, trainable-parameter EMA, and ReID
  preprocessing: resize to `img_height x img_width` (default 384x128, bilinear), no crop,
  CLIP mean/std normalization. Inference uses global embeddings and cosine similarity only.
- Checkpoints are `torch.save` dictionaries readable with `torch.load(weights_only=True)`:
  `model_state_dict` (EMA weights when EMA is enabled), `args`, `epoch`, `global_step`,
  `best_val_score`, and, for full checkpoints, optimizer/scheduler/raw state.
- The reference CUHK-PEDES checkpoint reports on the test split (6,156 captions, 3,074 images):
  R@1 70.1, R@5 87.9, R@10 92.7, mAP 63.9, mINP 48.4.
- The open_clip `ViT-B-16`/`openai` weights resolve to HF repo
  `timm/vit_base_patch16_clip_224.openai`, file `open_clip_model.safetensors`, revision
  `977e3dd0ec55ab8da155f2fbeb6b5f54948b6e3d`.
- The God's Eye gallery is the de-duplicated CUHK-PEDES test split (3,073 records; one exact
  content duplicate is an alias).

## Decisions

1. **Evidence**: benchmark metrics, side-by-side comparison, and ground-truth rank examples.
2. **Runtime**: new `OpenClipEmbedder` backend (`open_clip_torch==3.3.0`) behind the existing
   embedder seam; ReID preprocessing is ported to PIL/numpy.
3. **Paired Baseline**: every checkpoint is paired with the zero-shot open_clip model that shares
   its `(model_name, pretrained, img_height, img_width, preprocess_mode)`. It is prepared
   automatically and shared between checkpoints. Existing HF models remain as the "reference"
   group.
4. **Import**: operator command `./gods-eye prepare --checkpoint <file.pt> [--label TEXT]
   [--reference-metrics <lab_clip test json>]`. The file is read once with
   `weights_only=True`; only `model_state_dict` is persisted as safetensors. Web upload is out of
   scope. Stored under `<GODS_EYE_HF_CACHE>/labclip-checkpoints/<weights sha256>/`.
5. **Identifiers**: checkpoint `labclip:cuhk-pedes:<first 12 hex of weights sha256>`; baseline
   `openclip/<model_name>@<pretrained>:<H>x<W>-<preprocess_mode>`.
6. **Import validation** (reject on any failure): weights-only load with `model_state_dict` and
   `args`; `args.dataset == "cuhk-pedes"`; `args.train_split == "train"`; neither `val_split` nor
   `eval_split` is `test`; open_clip can build `(model_name, pretrained)` and has a safetensors HF
   source; strict `load_state_dict`; `preprocess_mode` in {`reid`, `model_reid`}. Only
   `ViT-B-16`/`openai` is marked equivalence-verified.
7. **Benchmark Evaluation**: computed by God's Eye from its own active index during Demo
   Preparation (all test captions as queries, person-ID ground truth, R@1/5/10, mAP, mINP with
   lab_clip's definitions) and stored immutably next to the index version. When reference
   metrics exist, a warning is recorded if |ΔR@1| > 0.5 pp. Checkpoint and Paired Baseline models
   need a successful evaluation to be ready; reference HF models stay searchable without one.
8. **Benchmark Queries**: 48 test captions, one per sampled test person ID, fixed seed,
   model-independent. They are the only captions exposed by the API. Train and validation
   captions are never exposed.
9. **UI**: Search (unchanged), Compare (two models, same query, side-by-side grids, ground-truth
   rank badge "baseline #37 → fine-tuned #1" for Benchmark Queries, improved/same/worse filter
   with counts), Benchmark (metrics table with Δ vs Paired Baseline, lab_clip reference delta,
   provenance, one grouped bar chart, fixed protocol note).
10. **Runtime residency**: LRU of up to `GODS_EYE_RESIDENT_MODELS` (default 4) text-only
    embedders.
11. **Removal**: `./gods-eye checkpoint remove <model_id>` deletes weights, indexes and
    evaluations; the Paired Baseline is removed only when no other checkpoint references it.
    `./gods-eye checkpoint list` prints registrations.
12. **Delivery**: one branch, one pull request.
