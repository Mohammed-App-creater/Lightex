"""Shared first-fit packing vectors (docs/v2/33-dashboards-presence.md §8.3). `pack_vectors.json` is a verbatim copy of
the web client's `frontend/src/features/dashboards/pack-vectors.json`; both sides run every case."""

import hashlib
import json
from pathlib import Path

import pytest

from apps.dashboards.widgets import pack

HERE = Path(__file__).resolve().parent
VECTORS = HERE / "pack_vectors.json"
FRONTEND = HERE.parents[3] / "frontend" / "src" / "features" / "dashboards" / "pack-vectors.json"
DATA = json.loads(VECTORS.read_text(encoding="utf-8"))


def test_the_copy_is_identical_to_the_frontends():
    if not FRONTEND.exists():
        pytest.skip("frontend checkout not present")
    digest = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()  # noqa: E731
    assert digest(VECTORS) == digest(FRONTEND)


def test_the_contract_cases_are_present():
    names = " ".join(c["name"] for c in DATA["cases"])
    for needle in ("design default", "all 3x1", "12x4 then 3x1", "6, 3, 3, 6, 3, 3", "back-fills", "empty"):
        assert needle in names
    assert DATA["cols"] == 12


@pytest.mark.parametrize("case", DATA["cases"], ids=[c["name"] for c in DATA["cases"]])
def test_pack(case):
    assert pack([(x["w"], x["h"]) for x in case["widgets"]], DATA["cols"]) == case["rects"]


def test_widths_above_the_grid_are_clamped():
    assert pack([(20, 1), (3, 1)]) == [{"x": 0, "y": 0, "w": 12, "h": 1}, {"x": 0, "y": 1, "w": 3, "h": 1}]
