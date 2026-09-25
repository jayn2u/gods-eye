# God's Eye

God's Eye is a research context for preparing person-image galleries and retrieving visually similar images from natural-language descriptions.

## Language

**Dataset Acquisition**:
The explicit operator-controlled lifecycle that turns a verified Dataset Source into a Dataset Installation.
_Avoid_: Auto-download, dataset setup

**Dataset Source**:
The remote, distributable origin from which one supported research dataset can be obtained.
_Avoid_: Download URL, Drive file

**Dataset Registry**:
The version-controlled declaration of supported Dataset Sources and the expected identity of each Dataset Archive.
_Avoid_: Download configuration, URL list

**Dataset Archive**:
A completely downloaded and integrity-checked local package for one Dataset Source that has not necessarily been installed.
_Avoid_: Dataset ZIP, downloaded dataset

**Dataset Installation**:
A validated, complete local directory for one supported dataset whose images and metadata are ready for gallery preparation.
_Avoid_: Extracted files, dataset folder

**Installation Receipt**:
Local metadata that proves a Dataset Installation was produced from a specific verified Dataset Archive and passed structural validation.
_Avoid_: Done marker, install state

**Gallery Manifest**:
The normalized collection of image records and provenance derived from the evaluation (test) split of one or more Dataset Installations for retrieval indexing. Train and validation rows are structurally validated and then left out: they are never embedded, indexed, or searchable. Captions are never exposed except as Benchmark Queries.
_Avoid_: Dataset index, image list

**Fine-tuned Checkpoint**:
A model checkpoint with weights trained for text-to-image retrieval on designated research data,
separate from the held-out test gallery.
_Avoid_: Training artifact, test-split checkpoint

**Paired Baseline**:
The zero-shot model with the same architecture, pretrained source, image size, and preprocessing as a
Fine-tuned Checkpoint, used to isolate the effect of fine-tuning.
_Avoid_: Reference model, control model

**Benchmark Evaluation**:
A text-to-image ranking measurement against the Gallery Manifest using test-split captions and person-ID ground truth.
_Avoid_: Accuracy test, biometric evaluation

**Benchmark Query**:
One of 48 fixed, model-independent test captions selected for visible model comparison.
_Avoid_: Prompt example, dataset description

**Full Demo**:
The runnable research experience that searches the supported real-world galleries with the selected retrieval model.
_Avoid_: Production deployment, fixture mode

**Demo Preparation**:
The resumable lifecycle that establishes and verifies every local asset required by a Full Demo.
_Avoid_: Setup, installation, startup

**Prepared Demo**:
A Full Demo state whose Dataset Installations, model assets, active retrieval index, and search capability have all been verified.
_Avoid_: Installed app, ready files

**Demo Runtime**:
The active local web experience backed by the assets of a Prepared Demo.
_Avoid_: Production service, deployment

**Launcher**:
The single operator-facing entry point that manages Demo Preparation and the Demo Runtime.
_Avoid_: Python CLI, web app
