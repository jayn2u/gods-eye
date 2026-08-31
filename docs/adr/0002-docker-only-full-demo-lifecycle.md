# Provide a Docker-only Full Demo lifecycle

The primary README path prepares and runs the real-dataset Full Demo through one Launcher that requires Docker, Compose, and a supported NVIDIA GPU but no host Python or Node.js toolchain. Demo Preparation remains explicit, resumable, and terms-gated, while the Demo Runtime is a separate repeatable action that opens only on loopback. This favors a consistent research demonstration over a fast fixture-first onboarding path and keeps long-lived data, model, and index assets outside container images.

## Consequences

The supported Quickstart is Linux amd64 with an NVIDIA GPU of at least 8 GB VRAM and a working NVIDIA Container Toolkit. Tagged releases use immutable public GHCR images; development checkouts fall back to local image builds. Local development, fixture operation, manual indexing, and offline operation remain available as advanced documentation rather than steps in the primary path.
