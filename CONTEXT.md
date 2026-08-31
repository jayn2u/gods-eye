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
The normalized collection of image records and provenance derived from one or more Dataset Installations for retrieval indexing.
_Avoid_: Dataset index, image list
