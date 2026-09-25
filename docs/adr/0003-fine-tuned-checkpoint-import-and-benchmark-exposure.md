# Import fine-tuned checkpoints and expose benchmark evidence

Status: accepted (2026-09-25)

## Context

The Full Demo needs to show whether lab_clip fine-tuning improves text-to-image retrieval over an equal-preprocessing zero-shot model. lab_clip checkpoints are `torch.save` dictionaries, while runtime model assets must not require pickle loading and the Gallery Manifest is limited to the held-out test gallery.

## Decision

Import checkpoints during explicit Demo Preparation by loading with `weights_only=True`, validating their training metadata and model state, and persisting only the model weights as safetensors. Reject checkpoints whose validation or evaluation split selects `test`. Automatically prepare a Paired Baseline with the same architecture, pretrained source, image size, and preprocessing as each Fine-tuned Checkpoint.

Compute Benchmark Evaluation from each model's active index during Demo Preparation. Keep evaluation results with the immutable index version. Expose only the fixed set of 48 model-independent Benchmark Queries through the API; other source captions remain unavailable to the web app.

## Consequences

Checkpoint directories live at `<GODS_EYE_HF_CACHE>/labclip-checkpoints/<sha256>/` inside the existing model cache volume, rather than in a separate models/checkpoints directory, so no Compose volume is needed. `./gods-eye reset --model-cache` removes imported checkpoints along with the rest of that cache; `./gods-eye checkpoint remove MODEL_ID` removes one checkpoint and its indexes and evaluations, and removes its Paired Baseline index only when no other checkpoint uses it.

Benchmark Evaluation adds preparation time, while compatible completed evaluations can be reused. Caption exposure is narrowed to the 48 Benchmark Queries, but it is not zero. A supplied lab_clip reference is shown as a comparison; an R@1 difference greater than 0.5 percentage points raises a warning.
