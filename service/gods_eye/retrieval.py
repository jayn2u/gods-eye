from typing import Protocol

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

