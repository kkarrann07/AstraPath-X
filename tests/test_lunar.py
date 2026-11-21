from hashlib import sha256
from math import hypot

from fastapi.testclient import TestClient
import numpy as np
import pytest

from astrapath.api import app
from astrapath.lunar import DATA, lunar_product, lunar_terrain
from astrapath.terrain import slope_map


client = TestClient(app)


@pytest.mark.parametrize("terrain_id,relief", [("lunar-site04", 140), ("lunar-site01", 188)])
def test_comparison_and_planner_use_the_same_native_lola_window(terrain_id, relief):
    product = lunar_product(terrain_id)
    assert sha256((DATA / product["file"]).read_bytes()).hexdigest() == product["crop_sha256"]
    grid = lunar_terrain(terrain_id)
    response = client.get(f"/api/terrain/{terrain_id}/comparison")
    assert response.status_code == 200
    preview = response.json()
    assert preview["gravity"] == 1.62 and preview["dx"] == preview["dy"] == 5
    assert (preview["width"], preview["height"]) == (105, 85)
    assert preview["max_elevation"] - preview["min_elevation"] == pytest.approx(relief, abs=1)
    assert -90 < preview["lunar"]["lat"] < -89
    request = {"terrain": terrain_id, "start": preview["start"], "target": preview["target"]}
    result = client.post("/api/plan", json=request).json()
    assert preview["slope"] == result["slope"]
    assert set(result["routes"]) == {"shortest", "energy", "safest"}
    slopes = slope_map(grid)
    for route in result["routes"].values():
        assert route["feasible"]
        assert route["path"][0] == request["start"]
        assert route["path"][-1] == request["target"]
        assert route["distance"] == pytest.approx(sum(
            hypot((b[0] - a[0]) * grid.dy, (b[1] - a[1]) * grid.dx)
            for a, b in zip(route["path"], route["path"][1:])
        ), abs=0.005)
        assert max(slopes[row, col] for row, col in route["path"]) <= 19


def test_lunar_solar_fault_and_imagery_only_region():
    response = client.get("/api/terrain/lunar-site04/comparison").json()
    request = {"terrain": response["id"], "start": response["start"], "target": response["target"],
               "settings": {"altitude": 30}}
    baseline = client.post("/api/plan", json=request).json()["routes"]["shortest"]
    no_sun = client.post("/api/plan", json={
        **request, "settings": {**request["settings"], "solar": False},
    }).json()["routes"]["shortest"]
    assert baseline["path"] == no_sun["path"]
    assert baseline["timeline"][-1]["solar"] > no_sun["timeline"][-1]["solar"] == 0
    assert no_sun["timeline"][-1]["battery"] < baseline["timeline"][-1]["battery"]
    assert np.isfinite(lunar_terrain(response["id"]).elevation).all()

    limited = {**request, "settings": {"initial_pct": 26, "solar": False}}
    outbound = client.post("/api/plan", json=limited).json()["routes"]["shortest"]
    assert outbound["feasible"] and 0 < outbound["pnr"] < len(outbound["path"])
    returned = client.post("/api/emergency", json={
        **limited, "position": outbound["path"][15],
        "battery": outbound["timeline"][15]["battery"] * 0.8,
    }).json()
    assert returned["status"] == "RETURN" and returned["route"]["path"][-1] == request["start"]

    result = client.post("/api/emergency", json={
        **request, "position": baseline["path"][15], "battery": 0,
    }).json()
    assert result["status"] == "STOP/HOLD"
    assert client.get("/api/terrain/apollo11/comparison").status_code == 404
    assert client.post("/api/plan", json={**request, "terrain": "apollo11"}).status_code == 404
