"""Bundled native-posting NASA LOLA windows for the comparison and planner."""
from functools import lru_cache
import json
from pathlib import Path

import numpy as np
import rasterio

from .terrain import Terrain


DATA = Path(__file__).with_name("lunar_data")
with (DATA / "manifest.json").open(encoding="utf-8") as manifest:
    PRODUCTS = json.load(manifest)


def lunar_product(terrain_id):
    return PRODUCTS.get(terrain_id)


@lru_cache(maxsize=2)
def lunar_terrain(terrain_id):
    product = PRODUCTS[terrain_id]
    with rasterio.open(DATA / product["file"]) as raster:
        projection = raster.crs.to_dict() if raster.crs else {}
        if (raster.count != 1 or not 3 <= min(raster.shape) <= max(raster.shape) <= 105
                or projection.get("proj") != "stere" or projection.get("lat_0") != -90
                or projection.get("R") != 1737400
                or (raster.transform.a, raster.transform.b, raster.transform.d, raster.transform.e) != (5, 0, 0, -5)
                or raster.units != ("m",)):
            raise ValueError("Unexpected LOLA window CRS, resolution, or units.")
        elevation = raster.read(1, masked=True).astype(np.float64).filled(np.nan)
    if np.count_nonzero(np.isfinite(elevation)) < 2:
        raise ValueError("LOLA window has too few valid pixels.")
    elevation.setflags(write=False)
    return Terrain(elevation, 5.0, 5.0, product["name"], "NASA LOLA · lunar elevation",
                   "5 m grid posting · MOON_ME / south polar stereographic", gravity=1.62)
