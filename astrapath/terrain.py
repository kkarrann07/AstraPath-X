from dataclasses import dataclass
from math import ceil, cos, radians, sin, tan

import numpy as np
from rasterio.crs import CRS
from rasterio.enums import Resampling
from rasterio.io import MemoryFile
from rasterio.transform import from_origin, xy
from rasterio.warp import reproject, transform
from rasterio.windows import Window


@dataclass(frozen=True)
class Terrain:
    elevation: np.ndarray
    dx: float
    dy: float
    name: str
    origin: str
    detail: str
    gravity: float = 9.80


def demo_terrain():
    y, x = np.mgrid[:73, :101]
    z = (
        132 + 0.26 * x + 0.12 * y
        + 8 * np.sin(x / 7) * np.sin(y / 8)
        + 4 * np.cos((x + y) / 4)
        + 120 * np.exp(-(((x - 44) / 10) ** 2 + ((y - 46) / 12) ** 2))
        + 113 * np.exp(-(((x - 68) / 14) ** 2 + ((y - 20) / 8) ** 2))
        + 69 * np.exp(-(((x - 21) / 13) ** 2 + ((y - 16) / 7) ** 2))
        + 44 * np.exp(-(((x - 81) / 8) ** 2 + ((y - 52) / 10) ** 2))
        - 22 * np.exp(-((y - 35 - 5 * np.sin(x / 13)) / 3.3) ** 2)
    )
    z[((x - 11) / 4) ** 2 + ((y - 55) / 6) ** 2 < 1] = np.nan
    return Terrain(z, 30, 30, "Kestrel Basin", "Synthetic demo", "30 m grid · Generated elevation")


def read_geotiff(data, name, center_x=50, center_y=50):
    """Crop at source resolution, then warp to a local north-up metric grid."""
    with MemoryFile(data) as memory, memory.open() as src:
        if src.driver != "GTiff" or src.count != 1 or src.crs is None:
            raise ValueError("Upload a georeferenced, single-band elevation GeoTIFF.")
        unit = (src.units[0] or "").strip().lower()
        if unit and unit not in {"m", "metre", "meter", "metres", "meters"}:
            raise ValueError("Elevation metadata must use metres. Convert the source elevations first.")
        width, height = min(src.width, 105), min(src.height, 85)
        if min(width, height) < 3:
            raise ValueError("The elevation raster must have at least three rows and columns.")
        col = round((src.width - width) * center_x / 100)
        row = round((src.height - height) * center_y / 100)
        window = Window(col, row, width, height)
        affine = src.window_transform(window)
        scale, offset = src.scales[0], src.offsets[0]
        values = src.read(1, window=window, masked=True).astype(np.float64).filled(np.nan)
        values = values * scale + offset
        values[~np.isfinite(values)] = np.nan
        mid_x, mid_y = width / 2, height / 2
        center_x, center_y = xy(affine, [mid_y], [mid_x], offset="ul")
        lon, lat = transform(src.crs, "EPSG:4326", center_x, center_y)
        metric = CRS.from_string(f"+proj=aeqd +lat_0={lat[0]} +lon_0={lon[0]} +datum=WGS84 +units=m")
        rows = [0, 0, height, height, mid_y, mid_y, mid_y + 1]
        cols = [0, width, 0, width, mid_x, mid_x + 1, mid_x]
        source_x, source_y = xy(affine, rows, cols, offset="ul")
        mx, my = transform(src.crs, metric, source_x, source_y)
        dx = np.hypot(mx[5] - mx[4], my[5] - my[4])
        dy = np.hypot(mx[6] - mx[4], my[6] - my[4])
        if not 0.001 <= min(dx, dy) <= max(dx, dy) <= 10000:
            raise ValueError("The raster has unsupported horizontal cell spacing.")
        out_width = max(3, ceil((max(mx[:4]) - min(mx[:4])) / dx - 1e-7))
        out_height = max(3, ceil((max(my[:4]) - min(my[:4])) / dy - 1e-7))
        if max(out_width, out_height) > 160:
            raise ValueError("This raster has strongly rotated or elongated pixels. Export a north-up DEM first.")
        output = np.full((out_height, out_width), np.nan)
        reproject(values, output, src_transform=affine, src_crs=src.crs, src_nodata=np.nan,
                  dst_transform=from_origin(min(mx[:4]), max(my[:4]), dx, dy), dst_crs=metric,
                  dst_nodata=np.nan, resampling=Resampling.nearest)
    if np.count_nonzero(np.isfinite(output)) < 2:
        raise ValueError("The selected terrain window contains too few valid elevation pixels.")
    detail = f"{dx:.1f} × {dy:.1f} m grid · {lat[0]:.5f}°, {lon[0]:.5f}° center"
    return Terrain(output, float(dx), float(dy), name, "Uploaded DEM · user-supplied", detail)


def shifted(z, dr, dc, fill=np.nan):
    h, w = z.shape
    result = np.full(z.shape, fill, dtype=float)
    if abs(dr) < h and abs(dc) < w:
        rs = slice(max(0, -dr), min(h, h - dr))
        cs = slice(max(0, -dc), min(w, w - dc))
        result[rs, cs] = z[slice(max(0, dr), min(h, h + dr)), slice(max(0, dc), min(w, w + dc))]
    return result


DIRECTIONS = tuple((dr, dc) for dr in (-1, 0, 1) for dc in (-1, 0, 1) if dr or dc)


def slope_map(terrain):
    z = terrain.elevation
    grades = [np.abs(shifted(z, dr, dc) - z) / np.hypot(dc * terrain.dx, dr * terrain.dy)
              for dr, dc in DIRECTIONS]
    return np.degrees(np.arctan(np.fmax.reduce(grades)))


def illumination(terrain, azimuth, altitude):
    """Sample the DEM horizon toward a fixed sun. Unknown cells cast conservative shadow."""
    z = terrain.elevation
    valid = np.isfinite(z)
    if altitude <= 0:
        return np.zeros(z.shape, dtype=bool)
    if altitude >= 90:
        return valid
    az = radians(azimuth)
    vc, vr = sin(az) / terrain.dx, -cos(az) / terrain.dy
    norm = max(abs(vc), abs(vr))
    obstruction = np.where(valid, z, np.inf)
    lit = valid.copy()
    for step in range(1, max(z.shape)):
        dr, dc = round(step * vr / norm), round(step * vc / norm)
        distance = np.hypot(dr * terrain.dy, dc * terrain.dx)
        lit &= ~(shifted(obstruction, dr, dc, -np.inf) > z + distance * tan(radians(altitude)))
    return lit


def matrix_json(values, digits=2):
    return [[round(float(cell), digits) if np.isfinite(cell) else None for cell in row] for row in values]
