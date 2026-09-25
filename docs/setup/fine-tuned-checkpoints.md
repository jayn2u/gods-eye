# Fine-tuned checkpoints and model comparison

Use this guide to import a lab_clip checkpoint into the local Full Demo and compare it with a matching zero-shot model. Retrieval results describe visual similarity for research; they do not establish identity.

## Import a checkpoint

Run `prepare` from the repository root. It accepts one or more `--checkpoint` paths, imports each supported checkpoint, prepares its Paired Baseline, and prepares both indexes. The root Launcher mounts checkpoint and reference-metrics files outside the checkout read-only, so the paths below can point into `/mnt/data/lab_clip`.

```bash
./gods-eye prepare \
  --checkpoint /mnt/data/lab_clip/artifacts/downloaded/val-kfold-test/cuhk-pedes/best_t2i_eval_compat.pt \
  --label "CUHK-PEDES lab_clip fine-tuned" \
  --reference-metrics /mnt/data/lab_clip/results/08-24/val-kfold-test/cuhk-pedes_test.json
```

`--label` and `--reference-metrics` each require exactly one `--checkpoint`. The reference file is optional. When supplied, it must identify the `cuhk-pedes` dataset, `test` split, and `text-to-image` direction. The normal Dataset Acquisition terms prompt still applies; `--yes` alone does not accept dataset terms.

The import validates that the source can be read with `torch.load(..., weights_only=True)`, contains a tensor `model_state_dict` and mapping-valued `args`, and matches a constructible OpenCLIP model with a pinned pretrained source and safetensors Hugging Face weights. Required `args` fields include `dataset`, `train_split`, `val_split`, `eval_split`, `model_name`, `pretrained`, `img_height`, `img_width`, and `preprocess_mode`. It requires `dataset=cuhk-pedes`, `train_split=train`, string validation/evaluation metadata that does not select `test`, positive image dimensions, and a supported `reid` or `model_reid` preprocessing mode. The state dictionary must match the OpenCLIP model strictly. Only the model weights are copied into the model cache as safetensors; the original `.pt` file remains at its import path and is not used at runtime. `ViT-B-16` with `openai` is the only equivalence-verified combination.

Each imported checkpoint is assigned a model ID of the form `labclip:cuhk-pedes:<first 12 hex characters of weights SHA-256>`. Its matching Paired Baseline is prepared automatically and shared with any checkpoint using the same architecture, pretrained source, image size, and preprocessing.

## Preparation and the web modes

For each requested model, Demo Preparation builds or reuses the model assets and Gallery Manifest, then builds and activates the index. Stage 7, **benchmark evaluation**, computes metrics from that active index using test-split captions and person-ID ground truth; it adds minutes to preparation. Stage 8 is the **real-search smoke test**. Checkpoint and Paired Baseline models need a successful evaluation to be ready for comparison.

The web app has three modes:

- **Search** ranks gallery images for a description you enter.
- **Compare** runs the same description against two prepared models, or compares them using one of the fixed Benchmark Queries. Benchmark Query comparisons include the ground-truth first-match rank and improved/same/worse outcomes.
- **Benchmark** shows retrieval metrics, change versus the Paired Baseline, any supplied lab_clip reference, and model provenance.

The Benchmark page's protocol line is: `CUHK-PEDES test split · text→image · person-ID ground truth · computed from God's Eye's active index`. Benchmark Evaluation uses test-split captions whose person IDs are represented in the active Gallery Manifest. The separate fixed sample of 48 Benchmark Queries is used for visible examples and ranks. Captions from the dataset are exposed through the API only as those 48 Benchmark Queries.

The metric values are displayed as percentages. R@1, R@5, and R@10 are the shares of test captions whose first matching person image appears within the top 1, 5, or 10 results. mAP averages precision over the ranked matching images. mINP averages the number of matching gallery images divided by the rank of the last matching image. The displayed deltas are percentage-point changes.

The Gallery Manifest contains 3,073 unique test-image records. The lab_clip reference metrics use 3,074 test images because the source has one exact duplicate; God's Eye keeps that duplicate as an alias of its image record. This small gallery-count difference can affect direct metric comparisons.

## List or remove checkpoints

List registrations and their preparation/evaluation status:

```bash
./gods-eye checkpoint list
./gods-eye checkpoint list --json
```

Remove one checkpoint by the model ID printed by `checkpoint list`:

```bash
./gods-eye checkpoint remove MODEL_ID
```

The command asks for confirmation; add `--yes` to skip the prompt. It removes that checkpoint's registration, weights, indexes, and evaluations. Its Paired Baseline index is also removed only if no remaining checkpoint refers to it; shared model-cache files are not removed. The original `.pt` file at the import path is not removed.

Imported checkpoints live under `<GODS_EYE_HF_CACHE>/labclip-checkpoints/<sha256>/` in the model cache. `./gods-eye reset --model-cache` deletes the whole model cache, including every imported checkpoint, and invalidates model preparation for all models; index files are not the reset target. Use `checkpoint remove MODEL_ID` for one checkpoint and its indexes/evaluations, plus its Paired Baseline index when unshared. The cache defaults to `.cache/huggingface` in the checkout and can be configured with `GODS_EYE_HF_CACHE`.

## Troubleshooting

- **`Checkpoint <path> cannot be read without unpickling code.`** The checkpoint is not compatible with the required weights-only loader. Use a lab_clip checkpoint that loads with `weights_only=True`; the Launcher does not fall back to unrestricted pickle loading.
- **`Validation and evaluation cannot be selected on the test split`** The checkpoint metadata selects `test` for `val_split` or `eval_split`. Use a checkpoint trained on `train` with validation/evaluation metadata that does not select the held-out test split.
- **A lab_clip reference warning appears in Benchmark.** The warning means the computed R@1 differs from the supplied reference by more than 0.5 percentage points. Check that the reference belongs to this checkpoint and uses the CUHK-PEDES test split and text-to-image direction. The reference's 3,074 gallery images differ from God's Eye's 3,073 de-duplicated records, so the metrics need not match exactly. The warning is a comparison signal, not an identity result.
