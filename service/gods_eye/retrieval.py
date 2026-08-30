import hashlib
from typing import Protocol

from .gallery import GalleryManifest
from .models import Dataset, SearchResult


class RetrievalEngine(Protocol):
    def search(self, query: str, top_k: int, datasets: list[Dataset]) -> list[SearchResult]: ...


class FixtureRetrievalEngine:
    """Deterministic development adapter; production engines implement the same seam."""

    _gallery = (
        ("CUHK-PEDES", "test", "cuhk:fixture:001", 0.923, "sky"),
        ("ICFG-PEDES", "validation", "icfg:fixture:002", 0.881, "violet"),
        ("RSTPReid", "train", "rstp:fixture:003", 0.846, "mint"),
    )

    def search(self, query: str, top_k: int, datasets: list[Dataset]) -> list[SearchResult]:
        del query
        rows = [row for row in self._gallery if row[0] in datasets][:top_k]
        return [
            SearchResult(
                rank=rank,
                similarity=similarity,
                dataset=dataset,
                id=stable_id,
                split=split,
                image_url=f"/api/images/{color}.svg",
            )
            for rank, (dataset, split, stable_id, similarity, color) in enumerate(rows, 1)
        ]


class ManifestRetrievalEngine:
    """Deterministic pre-index adapter over normalized gallery records.

    Ticket #4 replaces the score implementation with the validated FAISS index while
    preserving this API and manifest provenance behavior.
    """

    def __init__(self, manifest: GalleryManifest):
        self.manifest = manifest

    def search(self, query: str, top_k: int, datasets: list[Dataset]) -> list[SearchResult]:
        scored = []
        for record in self.manifest.records:
            provenance = record.provenance_for(datasets)
            if provenance is None:
                continue
            digest = hashlib.sha256(f"{query}:{record.id}".encode()).digest()
            similarity = int.from_bytes(digest[:8], "big") / (2**64 - 1)
            scored.append((similarity, record, provenance))
        scored.sort(key=lambda item: (-item[0], item[1].id))
        return [
            SearchResult(
                rank=rank,
                similarity=similarity,
                dataset=provenance.dataset,
                id=record.id,
                split=provenance.split,
                image_url=f"/api/images/{record.id}",
            )
            for rank, (similarity, record, provenance) in enumerate(scored[:top_k], 1)
        ]
