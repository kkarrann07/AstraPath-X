import numpy as np
import pytest
from fastapi.testclient import TestClient
from rasterio.io import MemoryFile
from rasterio.transform import from_origin

from astrapath.api import app
from astrapath.terrain import read_geotiff


client = TestClient(app)
DEFAULT = {"start": [42, 10], "target": [30, 90]}


def fixture_tiff(crs, affine, z, nodata=-9999, scale=1, offset=0):
    height, width = z.shape
    with MemoryFile() as memory:
        with memory.open(driver="GTiff", width=width, height=height, count=1, dtype="int16",
                         transform=affine, crs=crs, nodata=nodata) as tile:
            tile.write(z.astype("int16"), 1)
            tile.scales = (scale,)
            tile.offsets = (offset,)
        return memory.read()


def test_live_entry_points_and_judge_replanning():
    assert "Rover Mission Control" in client.get("/").text
    assert client.get("/assets/app.js").status_code == 200
    assert client.get("/health").json() == {"status": "ok"}
    terrain = client.get("/api/terrain/demo").json()
    assert terrain["origin"] == "Synthetic demo" and terrain["elevation"][55][11] is None
    result = client.post("/api/plan", json=DEFAULT).json()
    route = result["routes"]["shortest"]
    point = route["timeline"][15]
    for loss, expected in [(0, "CONTINUE"), (.45, "RETURN"), (1, "STOP/HOLD")]:
        decision = client.post("/api/emergency", json={**DEFAULT, "position": route["path"][15],
                                                       "battery": point["battery"] * (1 - loss)})
        assert decision.status_code == 200
        assert decision.json()["status"] == expected
    trials = client.post("/api/robustness", json=DEFAULT).json()
    assert trials["trials"] == 20 and trials["seed"] == 2026


def test_round_trip_completes_using_explicit_return():
    request = {**DEFAULT, "settings": {"round_trip": True}}
    routes = client.post("/api/plan", json=request).json()["routes"]
    assert not routes["shortest"]["feasible"]
    outbound = routes["energy"]
    assert outbound["feasible"]
    result = client.post("/api/emergency", json={**request, "position": DEFAULT["target"],
                                                "battery": outbound["timeline"][-1]["battery"],
                                                "returning": True}).json()
    assert result["status"] == "RETURN"
    assert result["route"]["path"][-1] == DEFAULT["start"]
    assert result["route"]["min_battery"] >= 18


def test_geographic_geotiff_upload_produces_metric_routing():
    z = np.tile(np.arange(18), (14, 1)) + 3200
    z[7, 8] = -9999
    data = fixture_tiff("EPSG:4326", from_origin(77.5, 34.2, 1 / 3600, 1 / 3600), z, scale=2, offset=1)
    uploaded = client.post("/api/terrain/upload?name=integration.tif", content=data)
    assert uploaded.status_code == 200
    terrain = uploaded.json()
    assert terrain["origin"] == "Uploaded DEM · user-supplied"
    assert 25 < terrain["dx"] < 27 and 30 < terrain["dy"] < 32
    assert any(None in row for row in terrain["elevation"])
    assert terrain["min_elevation"] == 6401
    plan = client.post("/api/plan", json={"terrain": terrain["id"], "start": terrain["start"],
                                        "target": terrain["target"]}).json()
    assert plan["routes"]["shortest"]["feasible"]
    assert plan["routes"]["shortest"]["distance"] > 250


def test_projected_window_uses_uploaded_affine_and_selected_location():
    z = np.tile(np.arange(150), (90, 1))
    data = fixture_tiff("EPSG:32643", from_origin(500000, 3800000, 20, 30), z)
    left = read_geotiff(data, "fixture", 0, 50)
    right = read_geotiff(data, "fixture", 100, 50)
    assert left.dx == pytest.approx(20, abs=.05)
    assert left.dy == pytest.approx(30, abs=.05)
    assert np.nanmin(right.elevation) > np.nanmin(left.elevation)


@pytest.mark.parametrize("payload,expected", [
    ({"start": [500, 0], "target": [30, 90]}, 422),
    ({**DEFAULT, "terrain": "unknown"}, 404),
    ({**DEFAULT, "settings": {"initial_pct": -1}}, 422),
])
def test_invalid_requests_return_client_errors(payload, expected):
    assert client.post("/api/plan", json=payload).status_code == expected


def test_rejects_invalid_tiff_and_outside_points():
    assert client.post("/api/terrain/upload", content=b"broken").status_code == 422
    assert client.post("/api/plan", json={**DEFAULT, "target": [145, 0]}).status_code == 422
    blocked = client.post("/api/plan", json={**DEFAULT, "start": [55, 11]}).json()
    assert not blocked["routes"] and "unknown" in blocked["message"]
