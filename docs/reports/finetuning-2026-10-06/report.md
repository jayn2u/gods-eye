# First Fine-tuning Experiment: Presentation Handoff

Prepared on 2026-10-06 for the agent creating the God's Eye experiment-report PPT.

## 1. Presentation scope and reading order

The main experiment is **full-parameter CLIP fine-tuning with in-batch InfoNCE**, W&B run [`5aec09de`](https://wandb.ai/tonychoi179-jayn2u/labclip/runs/5aec09de). This run uses FP32, disables EMA and gradient checkpointing, and retains ordinary image augmentation. Its confirmed headline result is **70.2663% text-to-image validation R@1 at epoch 57**.

Read this report first, then [the complete per-epoch appendix](epoch-history.md). Use the supplied CSVs to build editable charts. The main experiment's independent official-test result and its deployment in God's Eye have not been established by the collected evidence.

The saved God's Eye comparisons belong to a **different Fine-tuned Checkpoint**, run `5zouq9g8`, which uses AMP, EMA, and gradient checkpointing. They are useful supplementary demonstration evidence, with their run ID and test split visible. They do not measure the main FP32 run.

Recommended preparation sequence:

1. Build the main slides from the configuration, epoch-57 validation metrics, and all 60 epochs of the primary run.
2. Use the visualization specifications below to regenerate charts from the CSVs; keep their labels and units.
3. Add the separate demo comparison and other datasets only in a clearly identified supplementary section.
4. Use the example-image inventory to obtain original images from the external collection when making qualitative slides.
5. Check every performance slide against its run ID, split, epoch, and source file before exporting the deck.

## 2. Main experiment: verified configuration

Source: [captured W&B API response](evidence/pure_probe.json) and [configuration CSV](data/pure_run_config.csv). The API capture was taken at **2026-10-06 01:49:40 UTC**, using the configured account's API key. Credentials are excluded from the documentation.

| Item | Verified value |
|---|---|
| W&B project | `tonychoi179-jayn2u/labclip` |
| Run ID / name | `5aec09de` / `infonce_in_batch_seed42` |
| State | `finished` |
| Run creation time | `2026-08-03T12:50:39Z` |
| Dataset | CUHK-PEDES |
| Model | OpenCLIP `ViT-B-16` |
| Pretrained source | `openai` |
| Trainable backbone | Full backbone; `freeze_backbone=false` |
| Objective | `infonce`, weight `1.0`; the only configured objective |
| Negative sampling | `in_batch_only` |
| Numerical precision | `fp32` |
| EMA | Disabled |
| Gradient checkpointing | Disabled |
| Image augmentation | Enabled (`img_aug=true`) |
| Batch size | 64 |
| Learning rate setting | `1e-5` |
| Weight decay | `0.05` |
| Seed | 42 |
| Training / evaluation split | `train` / `val` |
| Observed training history | 60 epochs, numbered 1 through 60 |
| Best text-to-image epoch | 57 |

The term **basic contrastive fine-tuning** here means the objective is InfoNCE alone and the run uses FP32 without EMA or gradient checkpointing. It does not mean all preprocessing and augmentation were removed. `amp_enabled` and `multipositive` are absent from the captured configuration; report FP32 as recorded, and leave the same-ID multi-positive setting unconfirmed. Model-specific image dimensions, GPU model, optimizer identity, and schedule details should be sourced from this exact run before adding them to the deck. Settings from `5zouq9g8` are not substitutes.

The experiment is one observed run with seed 42. No multi-seed uncertainty estimate is available in this package.

## 3. Main result: one coherent checkpoint epoch

All values below come from **epoch 57 of run `5aec09de`, validation split**. Use [pure_best_epoch_metrics.csv](data/pure_best_epoch_metrics.csv) for the editable result table. Values in its `value_fraction` column are unrounded; `value_percent` is the corresponding percentage.

| Metric | Percentage | Source field |
|---|---:|---|
| Text-to-image R@1 | 70.2663 | `val/t2i@1` |
| Text-to-image R@5 | 86.4079 | `val/t2i@5` |
| Text-to-image R@10 | 91.7830 | `val/t2i@10` |
| Text-to-image mAP | 64.8731 | `val/t2i_mAP` |
| Text-to-image mINP | 50.7997 | `val/t2i_mINP` |
| Image-to-text R@1 | 83.7232 | `val/i2t@1` |
| Bidirectional average R@1 | 76.9948 | `val/avg@1` |

Suggested slide wording: **“Basic in-batch InfoNCE fine-tuning reached 70.27% text-to-image validation R@1 at epoch 57.”** Include `CUHK-PEDES · ViT-B/16 · validation · run 5aec09de` in the caption or speaker notes.

Use text-to-image R@1 as the primary result. Image-to-text R@1 and the bidirectional average are different metrics; the average should not replace text-to-image R@1 in the headline.

### Evidence discrepancies and selection boundaries

The local manuscript records **70.01%** for the basic FP32 configuration. The current W&B history records **70.2663% at epoch 57**. This report uses the captured API history and records the discrepancy; its cause has not been established.

The training-run summary also has `test/best_t2i@1=0.7026631832122803`. That number matches the validation history, while the configuration identifies `eval_split=val`. A field name alone is insufficient to establish a separate official-test evaluation. Treat this value as **unverified test provenance** and use the confirmed validation history in the presentation.

The summary includes a mixture of best values and last-epoch values. In particular, last-epoch R@5, R@10, mAP, and mINP are not automatically the metrics of the best-R@1 checkpoint. The epoch-57 table above avoids mixing evaluation times.

## 4. Complete epoch history and plotting data

The [epoch-history appendix](epoch-history.md) records every epoch, global step, training loss, text-to-image R@1/5/10, mAP, mINP, image-to-text R@1, and average R@1. It is the human-readable companion to the CSVs.

| File | Grain and units | Use |
|---|---|---|
| [pure_training_history_wide.csv](data/pure_training_history_wide.csv) | One row per epoch; loss is a scalar, retrieval metrics are fractions | Preferred input for epoch charts |
| [training_history.csv](data/training_history.csv) | 780 rows: one run × epoch × metric; raw fractions retained | Pivoting, alternative charts, source auditing |
| [pure_best_epoch_metrics.csv](data/pure_best_epoch_metrics.csv) | Seven metrics from epoch 57; fractions and percentages | Main result table and bars |
| [pure_run_config.csv](data/pure_run_config.csv) | One row per configuration field | Experiment-setting slide |
| [pure_run_summary.csv](data/pure_run_summary.csv) | W&B summary fields with scope/epoch notes | Best-versus-last inspection |
| [resource_observations.csv](data/resource_observations.csv) | Validation-phase allocated/reserved memory | Optional validation-memory illustration |

Useful wide-CSV mappings:

| Plot variable | CSV column | Transform |
|---|---|---|
| Epoch | `epoch` | Integer, 1–60 |
| Global step | `step` | Preserve as recorded |
| Training loss | `train_loss` | No percentage conversion |
| Text-to-image R@1 / R@5 / R@10 | `val_t2i_1`, `val_t2i_5`, `val_t2i_10` | Multiply by 100 |
| Text-to-image mAP / mINP | `val_t2i_mAP`, `val_t2i_mINP` | Multiply by 100 |
| Image-to-text R@1 | `val_i2t_1` | Multiply by 100 |
| Average R@1 | `val_avg_1` | Multiply by 100 |

Start with the observed values, rather than an interpolated or smoothed substitute. Connect the 60 measured epochs in chronological order. A moving average, if added, should appear alongside the original series with its window stated. Epoch 1 is already a trained epoch; it is not a zero-shot or epoch-0 baseline.

There is no measured learning-rate series, epoch-duration series, throughput series, or validated training-peak memory series for the primary run in this capture. Its configured learning rate alone does not define a measured learning-rate curve. Global-step progression does not establish elapsed training time.

## 5. Visualization specifications

The [existing training figure](assets/pure_training_curves.png) contains loss and validation R@1 panels. [Its SVG](assets/pure_training_curves.svg) is available for scaling and editing. Numeric chart assets are included locally; the original CSVs remain the authority for their values.

| Visualization | Data and encoding | Annotation and interpretation |
|---|---|---|
| Training loss | `epoch` on x; `train_loss` on y; line plot | Label the objective as InfoNCE. Preserve loss units. |
| Primary learning curve | `epoch` on x; `val_t2i_1 × 100` on y | Mark epoch 57 and 70.2663%; label validation. |
| Bidirectional retrieval curves | t2i R@1, i2t R@1, and average R@1, each ×100 | Keep all three names distinct; emphasize t2i R@1. |
| Retrieval coverage during training | R@1, R@5, R@10 over all epochs | This shows top-k coverage, not three independent runs. |
| Ranking-quality curves | mAP and mINP over all epochs | Separate from loss; use percentage units. |
| Best-versus-final checkpoint | Epochs 57 and 60 from the same wide CSV | Explain that 57 is selected by the highest observed t2i R@1; 60 is the last epoch. |
| Early-training detail | Optional inset for epochs 1–15 | Keep the full 60-epoch plot visible; show both axis limits. |
| Same-epoch result bars | The five t2i metrics from epoch 57 | Use a 0–100% axis, consistent metric labels, and two-decimal value labels. |

For slide figures, keep a 16:9 slide layout and place a wide learning curve beside a concise configuration/result summary. Use consistent colors for the same metrics across slides. Start percentage axes at zero by default; a zoomed convergence panel may use a narrower range if its limits are explicit. The source note should identify the run, split, snapshot date, and input CSV.

Percentage-point differences are computed as `(new_fraction - old_fraction) × 100`. A percentage-point change is distinct from a relative percentage change. Use two decimal places in slide labels and keep full precision in calculations.

### Validation-memory figure

[pure_validation_vram_snapshot.png](assets/pure_validation_vram_snapshot.png) shows **validation-phase** telemetry: allocated 2.3406 GiB and reserved 13.8145 GiB. These are different memory measures. The underlying values are constant across the captured epochs. This chart does not establish training-peak memory, GPU capacity, training efficiency, or memory savings versus another run.

## 6. Supplementary God's Eye demonstration

Source run: [`5zouq9g8`](https://wandb.ai/tonychoi179-jayn2u/labclip/runs/5zouq9g8), a separate InfoNCE run with AMP, EMA, and gradient checkpointing. Its registered Fine-tuned Checkpoint is `labclip:cuhk-pedes:5a83880a9867`. Its Paired Baseline is `openclip/ViT-B-16@openai:384x128-reid`.

The saved 2026-09-25 Benchmark Evaluation used 6,156 CUHK-PEDES test-caption queries and 3,073 Gallery Manifest records. The original LabCLIP evaluation used 3,074 images; God's Eye represents one exact content duplicate as an alias. These are saved evaluations, not new evaluations performed for this report.

| Metric | Paired Baseline (%) | Fine-tuned demo (%) | Difference (percentage points) |
|---|---:|---:|---:|
| R@1 | 12.4756 | 70.1267 | +57.6511 |
| R@5 | 27.1442 | 87.8980 | +60.7537 |
| R@10 | 35.6238 | 92.7225 | +57.0988 |
| mAP | 11.1151 | 63.9368 | +52.8217 |
| mINP | 4.2433 | 48.4158 | +44.1726 |

Use [runtime_paired_metrics.csv](data/runtime_paired_metrics.csv) and [the grouped-bar figure](assets/runtime_paired_five_metrics.png). This is a valid within-evaluation Paired Baseline comparison for the supplementary checkpoint. It is not the baseline gain of `5aec09de`, and the primary validation result must not be subtracted from this test baseline.

LabCLIP's saved official-test R@1 for the supplementary checkpoint is 70.1105%, compared with God's Eye's 70.1267%: a difference of approximately +0.0162 percentage points. Show the query/gallery counts alongside this reproducibility comparison.

The captured W&B summary for `5zouq9g8` records best t2i validation R@1 71.0620% at epoch 10. Its imported registration's score of approximately 78% and the label “val R@1 78.0” are not evidence of 78% text-to-image R@1. Keep t2i and average metrics separate. The captured API response and registration remain available for inspection.

### Fixed Benchmark Queries and qualitative material

There are **48 model-independent Benchmark Queries**, selected with seed 20260925. Their stored first-correct-person-ID ranks are recorded in [benchmark_query_ranks.csv](data/benchmark_query_ranks.csv); [the long-form version](data/benchmark_query_ranks_long.csv) supports per-model plotting.

| Outcome | Queries | Scope |
|---|---:|---|
| Improved first-match rank | 43 | Fixed 48-query sample |
| Same first-match rank | 4 | Fixed 48-query sample |
| Worse first-match rank | 1 | Fixed 48-query sample |

Use [the rank scatter](assets/benchmark_query_rank_scatter.png), [heatmap](assets/benchmark_query_rank_heatmap.png), or [outcome counts](assets/benchmark_rank_outcomes.png). Smaller ranks are better. A logarithmic rank axis/color scale makes large ranks visible; disclose it and draw an equality reference line where appropriate. The counts describe rank changes, not 43 top-1 successes or the full test-set R@1.

Four selected examples are described in [benchmark_examples.csv](data/benchmark_examples.csv): top-1 recovery (488→1), unchanged top-1 (1→1), regression (1→2), and a remaining miss (564→12). Captions and one same-ID ground-truth gallery image per query were collected. These photos are **not retrieved top-k result images**. Present them as ground-truth examples with stored ranks, not as reconstructed search-output grids.

Raw dataset photos and the photographic contact sheet stay in the external collection, outside this repository. The collection is located at:

```text
/home/jwchoi/.codex/visualizations/2026/10/06/01a10eda-ed27-7200-a5e4-5eb22aa60ea0/finetuning-materials/
```

Use its `images/benchmark_ground_truth/` and `charts/benchmark_examples_contact_sheet.png`. [benchmark_ground_truth_images.csv](data/benchmark_ground_truth_images.csv) records source paths, copied paths, dimensions, and hashes for locating and checking all 48 originals. On another machine, supply that external collection or the relevant Dataset Installation before preparing photographic slides.

## 7. Supplementary multi-dataset evaluations

Source: [test_results.csv](data/test_results.csv) and the copied official-test JSON evidence from LabCLIP, dated 2026-08-24. All three are text-to-image evaluations and record zero dropped queries.

| Dataset / training run | Selection split | Test queries / images | R@1 (%) | R@5 (%) | R@10 (%) | mAP (%) | mINP (%) |
|---|---|---:|---:|---:|---:|---:|---:|
| CUHK-PEDES / `5zouq9g8` | Native validation | 6,156 / 3,074 | 70.1105 | 87.8980 | 92.7225 | 63.9332 | 48.4278 |
| ICFG-PEDES / `jm3q3fst` | Fold 1 of 5 | 19,848 / 19,848 | 59.5526 | 77.2823 | 83.1973 | 36.7451 | 8.2911 |
| RSTPReid / `p8zjr4t3` | Fold 5 of 5 | 2,000 / 1,000 | 53.3500 | 77.4500 | 84.7500 | 44.6577 | 26.1111 |

ICFG-PEDES and RSTPReid results are from selected individual fold checkpoints, not five-fold official-test means. Dataset and gallery-size differences affect the task; a dataset comparison is not a controlled comparison of training methods.

Use [supplementary_test_metrics.png](assets/supplementary_test_metrics.png) for grouped metric bars and [supplementary_three_point_recall.png](assets/supplementary_three_point_recall.png) for R@1/5/10. Only k=1,5,10 were supplied; label this a three-point recall view rather than a complete CMC curve.

## 8. Suggested slide structure

| Slide purpose | Main content | Visual input |
|---|---|---|
| Research task | English-description-to-person-image retrieval | An explicitly labeled dataset illustration, if external photos are supplied |
| Basic experiment configuration | Exact run `5aec09de`; InfoNCE, FP32, augmentation, batch, split | Configuration table |
| Training progression | All 60 epochs; loss and validation t2i R@1 | Primary learning curves |
| Checkpoint selection | Best epoch 57 versus final epoch 60 | Epoch-57 marker and same-run checkpoint table |
| Validation result | Coherent epoch-57 metric table | Editable bars/table from best-epoch CSV |
| Interpretation and remaining evidence | One seed, validation scope, independent test evaluation unverified | Short evidence-status table |
| Optional demo comparison | Separate AMP/EMA/GC checkpoint and its Paired Baseline | Saved test metric bars, explicitly supplementary |
| Optional qualitative examples | Recovery, unchanged, regression, remaining miss | External ground-truth photos, captions, stored ranks |
| Optional dataset expansion | Three saved official-test results | Dataset bars and query/gallery counts |

This is a content map, not a mandated slide count. Prioritize the basic experiment in the main deck. A deck that omits supplementary material should still explain the primary configuration, learning trend, selected epoch, validation result, and evidence boundary.

## 9. Definitions, source authority, and completion criteria

R@k is the fraction of queries with at least one same-person-ID gallery image among their top k results. mAP measures average precision across all relevant gallery images, then averages over queries. mINP uses the number of relevant images divided by the rank of the last relevant image, averaged over queries. All retrieval-metric fractions are multiplied by 100 for percentage displays. Similarity scores are not identity probabilities.

For this snapshot, raw W&B history is the authority for per-epoch primary metrics; same-epoch derived CSVs support charting; training summaries support only the fields and provenance they actually establish. Saved immutable evaluation JSONs are the authority for the supplementary test results. Existing chart images are convenient renderings of those data.

The [source manifest](evidence/source_manifest.csv) records original sources, snapshot times, file sizes, and SHA-256 hashes. The documentation contains no model weights or environment/API-key files. No training, new evaluation, checkpoint import, or service change was performed to create the report.

The PPT handoff is complete when the deck's figures can be traced to the supplied CSVs, primary learning curves contain all 60 epochs, every reported result has its run/split/epoch identified, and supplementary test or qualitative examples retain their separate-checkpoint scope.
