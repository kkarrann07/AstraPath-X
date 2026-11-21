"""Generated fixtures verify Tso Kar geometry and routing. They contain no satellite data."""
from hashlib import sha256
import json
from zipfile import ZIP_DEFLATED, ZipFile

import numpy as np
import pytest
import rasterio
from fastapi.testclient import TestClient
from rasterio.enums import ColorInterp
from rasterio.transform import from_origin, rowcol, xy

from astrapath.api import app
from astrapath.tsokar import AOI, CRS, ImportSpec, load_window, prepare_study, study_grid


def make_tiff(path, data, affine, crs="EPSG:4326", nodata=None, unit=None, rgb=False):
    stack = data if data.ndim == 3 else data[None, :, :]
    with rasterio.open(path, "w", driver="GTiff", count=len(stack), height=stack.shape[1],
                       width=stack.shape[2], dtype=stack.dtype, transform=affine, crs=crs,
                       nodata=nodata, compress="deflate") as raster:
        raster.write(stack)
        if unit:
            raster.set_band_unit(1, unit)
        if rgb:
            raster.colorinterp = (ColorInterp.red, ColorInterp.green, ColorInterp.blue)


def source(filename, **kwargs):
    return {"file": filename, "product_id": f"GENERATED-FIXTURE-{filename}", "version": "fixture-version",
            "license": "Generated automated test data", **kwargs}


def zipped(path, files):
    with ZipFile(path, "w", ZIP_DEFLATED) as archive:
        for name, content in files.items():
            archive.writestr(name, content)


@pytest.fixture
def products(tmp_path):
    w, s, e, n = AOI
    one_second = 1 / 3600
    height = int((n - s) * 3600) + 4
    west = np.full((height, 440), 4530, dtype="int16")
    east = np.full((height, 480), 4530, dtype="int16")
    # A ridge is wider than the routing-window bounds vertically.
    east[:, 22:32] = 4720
    west[100:110, 100:110] = -32768
    make_tiff(tmp_path / "west.tif", west, from_origin(77.88, n + one_second, one_second, one_second),
              nodata=-32768, unit="m")
    make_tiff(tmp_path / "east.tif", east, from_origin(78, n + one_second, one_second, one_second),
              nodata=-32768)
    zipped(tmp_path / "east.zip", {
        "download/ELEVATION_DEM.tif": (tmp_path / "east.tif").read_bytes(),
        "download/tile-metadata.xml": b"<fixture>Test only</fixture>",
    })
    (tmp_path / "catalogue-record.txt").write_text("Test metadata only", encoding="utf-8")
    affine, shape, _ = study_grid()
    col, row = shape[1] // 2, shape[0] // 2
    x, y = xy(affine, row, col)
    # Imagery deliberately has a different origin and resolution.
    image_affine = from_origin(affine.c - 9, affine.f + 13, 18, 18)
    image_h, image_w = shape[0] * 2, shape[1] * 2
    marked_row, marked_col = rowcol(image_affine, x, y)
    image = np.full((3, image_h, image_w), 12, dtype="uint16")
    image[0, marked_row - 10:marked_row + 11, marked_col - 10:marked_col + 11] = 550
    make_tiff(tmp_path / "rgb.tif", image, image_affine, crs=CRS, rgb=True)
    spec = ImportSpec.model_validate({
        "dem": [source("west.tif", acquired="2011-02-03", metadata_files=["catalogue-record.txt"]),
                source("east.zip", acquisition_note="Fixture date range unavailable")],
        "imagery": source("rgb.tif", family="resourcesat", acquired="2025-09-10"),
    })
    return spec, tmp_path, (row, col)


def test_mosaic_coverage_provenance_and_imagery_alignment(products):
    spec, folder, marker = products
    output = folder / "derived"
    provenance = prepare_study(spec, folder, output)
    assert provenance["valid_coverage_fraction"] > .99
    assert provenance["elevation_range_m"] == [4530, 4720]
    assert provenance["dem"][0]["acquired"] == "2011-02-03"
    assert provenance["dem"][1]["acquired"] is None
    assert provenance["dem"][1]["rasters"][0]["member"] == "download/ELEVATION_DEM.tif"
    assert provenance["dem"][1]["archive_metadata_files"] == ["download/tile-metadata.xml"]
    assert provenance["imagery"]["acquired"] == "2025-09-10"
    assert provenance["imagery"]["dem_overlap_fraction"] > .99
    record = provenance["dem"][0]["files"][0]
    preserved = output / "raw" / "dem-1" / record["stored_as"]
    assert preserved.read_bytes() == (folder / "west.tif").read_bytes()
    assert record["sha256"] == sha256(preserved.read_bytes()).hexdigest()
    for file, fingerprint in provenance["processed"].items():
        assert sha256((output / file).read_bytes()).hexdigest() == fingerprint
    grids = set()
    for name in ("elevation", "slope", "hazards", "imagery"):
        with rasterio.open(output / f"{name}.tif") as raster:
            grids.add((raster.crs.to_string(), raster.shape, raster.transform))
            if name == "elevation":
                assert np.isnan(raster.nodata) and raster.units == ("m",)
            elif name == "imagery":
                row, col = marker
                assert list(raster.read()[:, row, col]) == [255, 0, 0, 255]
            elif name == "hazards":
                assert raster.nodata == 255 and np.any(raster.read(1) == 1)
    assert len(grids) == 1


def test_partial_coverage_and_rejected_year_are_explicit(products):
    spec, folder, _ = products
    partial = spec.model_copy(update={"dem": spec.dem[:1], "imagery": None})
    output = folder / "partial"
    manifest = prepare_study(partial, folder, output)
    assert .4 < manifest["valid_coverage_fraction"] < .6
    with pytest.raises(ValueError, match="no usable elevations"):
        load_window(output, x=100, y=50)
    terrain, imagery = load_window(output, x=5, y=50)
    assert terrain.dx == 30 and imagery is None
    spec = spec.model_copy(update={"imagery": spec.imagery.model_copy(
        update={"acquired": spec.imagery.acquired.replace(year=2024)})})
    failed = folder / "wrong-year"
    with pytest.raises(ValueError, match="must be in 2025"):
        prepare_study(spec, folder, failed)
    assert not failed.exists()


@pytest.mark.parametrize(
    ("affine", "unit", "message"),
    [(from_origin(77.55, 34.2, 1/3600, 1/3600), "m", "does not intersect"),
     (from_origin(78.02, 33.31, 1/1200, 1/1200), "m", "1 arc-second"),
     (from_origin(78.02, 33.31, 1/3600, 1/3600), "ft", "must be in metres")],
)
def test_geospatial_validation_rejects_wrong_location_resolution_and_units(tmp_path, affine, unit, message):
    make_tiff(tmp_path / "invalid.tif", np.full((80, 80), 4500, dtype="int16"), affine, unit=unit)
    spec = ImportSpec.model_validate({"dem": [source("invalid.tif")]})
    with pytest.raises(ValueError, match=message):
        prepare_study(spec, tmp_path, tmp_path / "rejected")


def test_zip_member_overrides_remain_inside_work_directory(products):
    _, folder, _ = products
    zipped(folder / "archive.zip", {"../../fixture-dem.tif": (folder / "east.tif").read_bytes(),
                                   "nested/preview.tif": (folder / "west.tif").read_bytes()})
    config = ImportSpec.model_validate({"dem": [source("archive.zip", members=["../../fixture-dem.tif"])]})
    try:
        manifest = prepare_study(config, folder, folder / "sanitized")
    finally:
        assert not (folder.parent / "fixture-dem.tif").exists()
    assert manifest["dem"][0]["rasters"][0]["member"] == "../../fixture-dem.tif"


def test_sentinel_zip_uses_display_band_order_and_checks_sensing_date(products):
    spec, folder, _ = products
    affine, shape, _ = study_grid()
    small = from_origin(affine.c + 180, affine.f - 220, 10, 10)
    files = {}
    for index, band in enumerate(("B04", "B03", "B02")):
        path = folder / f"{band}.jp2"
        values = np.tile(np.arange(180, dtype="uint16"), (172, 1)) + 200 + index
        with rasterio.open(path, "w", driver="JP2OpenJPEG", dtype=values.dtype, count=1,
                           height=values.shape[0], width=values.shape[1], transform=small, crs=CRS,
                           REVERSIBLE="YES") as out:
            out.write(values, 1)
        files[f"fixture.SAFE/GRANULE/A/IMG_DATA/R10m/fixture_{band}_10m.jp2"] = path.read_bytes()
    files["fixture.SAFE/MTD_MSIL2A.xml"] = (
        b"<DATATAKE_SENSING_START>2025-09-10T05:10:00Z</DATATAKE_SENSING_START>"
    )
    zipped(folder / "sentinel.zip", files)
    optical = spec.imagery.model_copy(update={"file": "sentinel.zip", "family": "sentinel-2"})
    sentinel = spec.model_copy(update={"imagery": optical})
    manifest = prepare_study(sentinel, folder, folder / "sentinel")
    assert manifest["imagery"]["metadata_acquisition_dates"] == ["2025-09-10"]
    assert [item["member"].rsplit("/", 1)[-1] for item in manifest["imagery"]["rasters"]] == [
        "fixture_B04_10m.jp2", "fixture_B03_10m.jp2", "fixture_B02_10m.jp2",
    ]
    conflict = sentinel.model_copy(update={"imagery": optical.model_copy(
        update={"acquired": optical.acquired.replace(day=11)})})
    with pytest.raises(ValueError, match="conflicts with"):
        prepare_study(conflict, folder, folder / "conflict")


def test_uploaded_mode_routes_use_dem_and_imagery_is_only_visual(products, monkeypatch):
    spec, folder, _ = products
    monkeypatch.setenv("ASTRAPATH_TSOKAR_DIR", str(folder / "unconfigured"))
    client = TestClient(app)
    assert client.get("/api/tsokar").json()["id"] is None
    assert client.get("/api/tsokar/unavailable/window").status_code == 404
    names = ("west.tif", "east.zip", "catalogue-record.txt", "rgb.tif")
    reply = client.post("/api/tsokar/import", data={"spec": spec.model_dump_json()},
                        files=[("files", (name, (folder / name).read_bytes())) for name in names])
    assert reply.status_code == 200, reply.text
    study = reply.json()
    manifest = client.get(f"/api/tsokar/{study['id']}/manifest").json()
    assert "Geospatial checks completed" in manifest["source_status"]
    response = client.get(f"/api/tsokar/{study['id']}/window")
    assert response.status_code == 200, response.text
    terrain = response.json()
    assert terrain["study"]["imagery"]["acquired"] == "2025-09-10"
    assert terrain["origin"] != "Synthetic demo"
    assert len(terrain["imagery"]) == terrain["height"]

    row = terrain["height"] // 2
    payload = {"terrain": terrain["id"], "start": [row, 15], "target": [row, 70]}
    planned = client.post("/api/plan", json=payload).json()
    assert any(value > 19 for line in planned["slope"] for value in line if value is not None)
    assert "connected route" in planned["message"]
    assert not any(planned["routes"].values())

    # Remove the measured ridge from the elevation fixture, leaving the study coordinates unchanged.
    with rasterio.open(folder / "east.tif", "r+") as raster:
        raster.write(np.full(raster.shape, 4530, dtype="int16"), 1)
    flat = ImportSpec.model_validate({"dem": [source("west.tif"), source("east.tif")]})
    installed = folder / "installed"
    prepare_study(flat, folder, installed)
    monkeypatch.setenv("ASTRAPATH_TSOKAR_DIR", str(installed))
    assert client.get("/api/tsokar").json()["id"] == "installed"
    flat_window = client.get("/api/tsokar/installed/window").json()
    assert "imagery" not in flat_window
    planned = client.post("/api/plan", json={**payload, "terrain": flat_window["id"]}).json()
    shortest = planned["routes"]["shortest"]
    assert shortest["feasible"] and shortest["max_slope"] == 0
    decision = client.post("/api/emergency", json={**payload, "terrain": flat_window["id"],
                                                   "position": [row, 26], "battery": 0}).json()
    assert decision["status"] == "STOP/HOLD"
