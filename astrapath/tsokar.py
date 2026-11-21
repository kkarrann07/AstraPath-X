"""Prepare a provenance-tracked Tso Kar study from locally obtained products."""
import argparse
from contextlib import contextmanager
from datetime import date, datetime
from hashlib import file_digest
import json
from math import ceil, hypot, isfinite
from pathlib import Path, PurePosixPath
import re
import shutil
from tempfile import TemporaryDirectory
from zipfile import BadZipFile, ZipFile

import numpy as np
from pydantic import BaseModel, Field
import rasterio
from rasterio.enums import ColorInterp, Resampling
from rasterio.features import geometry_mask
from rasterio.transform import from_origin, xy
from rasterio.vrt import WarpedVRT
from rasterio.warp import transform, transform_bounds, transform_geom
from rasterio.windows import Window

from .terrain import Terrain, slope_map


AOI = (77.88, 33.21, 78.13, 33.38)
CRS = "EPSG:32644"
POSTING = 30
BHOONIDHI = "https://bhoonidhi.nrsc.gov.in/bhoonidhi/"
BHUVAN = "https://bhuvan-app3.nrsc.gov.in/data/download/"
RASTER_SUFFIXES = {".tif", ".tiff", ".jp2"}
MAX_MEMBER_BYTES = 1024**3
HAZARD_SLOPE = 19
ACQUISITION_KEYS = r"DATATAKE_SENSING_START|SENSING_TIME|ACQUISITION[ _]?DATE|DATE[ _]?OF[ _]?PASS"


class Source(BaseModel):
    model_config = {"str_strip_whitespace": True, "extra": "forbid", "allow_inf_nan": False}
    file: str = Field(min_length=1, max_length=200)
    product_id: str = Field(min_length=1, max_length=200)
    version: str = Field(min_length=1, max_length=120)
    license: str = Field(min_length=1, max_length=1000)
    acquired: date | None = None
    acquisition_note: str = Field(default="", max_length=1000)
    members: list[str] = Field(default_factory=list, max_length=3)
    metadata_files: list[str] = Field(default_factory=list, max_length=8)
    nodata: float | None = None


class DemSource(Source):
    catalogue: str = Field(default="Bhoonidhi", pattern=r"^(Bhuvan|Bhoonidhi)$")
    elevation_units: str = Field(default="m", pattern=r"^m$")


class ImageSource(Source):
    family: str = Field(pattern=r"^(resourcesat|sentinel-2)$")
    acquired: date
    bands: tuple[int, int, int] | None = None


class ImportSpec(BaseModel):
    model_config = {"extra": "forbid"}
    dem: list[DemSource] = Field(min_length=1, max_length=8)
    imagery: ImageSource | None = None


def sha256(path):
    with path.open("rb") as stream:
        return file_digest(stream, "sha256").hexdigest()


def input_path(folder, name):
    path = (folder / name).resolve()
    if not path.is_relative_to(folder.resolve()) or not path.is_file():
        raise ValueError(f"Input file is missing or outside the input directory: {name}")
    return path


def preserve(source, folder, directory):
    directory.mkdir(parents=True)
    selected = [("package", source.file), *((f"metadata-{i}", name)
                                            for i, name in enumerate(source.metadata_files, 1))]
    records = []
    for role, name in selected:
        path = input_path(folder, name)
        target = directory / f"{role}-{path.name}"
        shutil.copyfile(path, target)
        records.append({"file": path.name, "stored_as": target.name, "sha256": sha256(target)})
    return directory / records[0]["stored_as"], records


def archive_selection(names, source):
    if source.members:
        missing = [name for name in source.members if name not in names]
        if missing:
            raise ValueError(f"Raster member was not found in the ZIP: {missing[0]}")
        return source.members
    if isinstance(source, DemSource):
        if len(names) == 1:
            return names
        dem_names = [name for name in names if "dem" in PurePosixPath(name).stem.lower()]
        if len(dem_names) == 1:
            return dem_names
    else:
        codes = ("B04", "B03", "B02") if source.family == "sentinel-2" else (
            "B(?:AND)?0?4", "B(?:AND)?0?3", "B(?:AND)?0?2"
        )
        result = []
        for code in codes:
            matches = [name for name in names if re.search(
                rf"(?:^|[_-]){code}(?:[_-]|$)", PurePosixPath(name).stem, re.IGNORECASE
            )]
            preferred = [name for name in matches if re.search(r"(10m|R10m)", name, re.IGNORECASE)]
            matches = preferred or matches
            if len(matches) != 1:
                break
            result.append(matches[0])
        if len(result) == 3:
            return result
        if len(names) == 1:
            return names
    raise ValueError("ZIP raster selection is ambiguous. Specify exact raster member paths in the import metadata.")


@contextmanager
def raster_files(path, source):
    if path.suffix.lower() in RASTER_SUFFIXES:
        if source.members:
            raise ValueError("Raster member names apply only to ZIP files.")
        yield [(source.file, path)], [], set()
        return
    if path.suffix.lower() != ".zip":
        raise ValueError("Provide a GeoTIFF, an imagery JP2, or a ZIP archive.")
    try:
        with ZipFile(path) as archive, TemporaryDirectory() as work:
            rasters = {}
            metadata = []
            dates = set()
            for item in archive.infolist():
                if item.is_dir():
                    continue
                name = PurePosixPath(item.filename)
                if name.suffix.lower() in RASTER_SUFFIXES:
                    if item.filename in rasters:
                        raise ValueError("ZIP contains duplicate raster member names.")
                    rasters[item.filename] = item
                elif name.suffix.lower() in {".xml", ".meta", ".txt", ".json", ".pdf", ".dim"}:
                    metadata.append(item.filename)
                    if name.suffix.lower() in {".xml", ".meta", ".txt"} and item.file_size <= 256 * 1024:
                        dates.update(acquisition_dates(archive.read(item).decode("utf-8-sig", errors="replace")))
            result = []
            for index, name in enumerate(archive_selection(list(rasters), source)):
                item = rasters[name]
                if item.file_size > MAX_MEMBER_BYTES or item.flag_bits & 1:
                    raise ValueError("A selected ZIP raster is encrypted or exceeds 1 GiB.")
                target = Path(work) / f"{index}{PurePosixPath(name).suffix.lower()}"
                with archive.open(item) as contents, target.open("wb") as output:
                    shutil.copyfileobj(contents, output, 1024 * 1024)
                result.append((name, target))
            yield result, metadata, dates
    except BadZipFile as exc:
        raise ValueError("An input ZIP is invalid.") from exc


def study_grid():
    west, south, east, north = transform_bounds("EPSG:4326", CRS, *AOI)
    affine = from_origin(west, north, POSTING, POSTING)
    shape = (ceil((north - south) / POSTING), ceil((east - west) / POSTING))
    w, s, e, n = AOI
    # Densify the four geographic edges before projecting the crop polygon.
    lons = np.linspace(w, e, 32).tolist()
    lats = np.linspace(s, n, 32).tolist()
    ring = [(x, s) for x in lons] + [(e, y) for y in lats[1:]]
    ring += [(x, n) for x in lons[-2::-1]] + [(w, y) for y in lats[-2::-1]]
    polygon = transform_geom("EPSG:4326", CRS, {"type": "Polygon", "coordinates": [ring]})
    inside = geometry_mask([polygon], shape, affine, invert=True)
    return affine, shape, inside


def raster_info(src, name, path):
    if src.crs is None or src.transform.is_identity or src.driver not in {"GTiff", "JP2OpenJPEG"}:
        raise ValueError(f"{name} needs a supported georeferenced raster with a CRS and affine transform.")
    bounds = transform_bounds(src.crs, "EPSG:4326", *src.bounds, densify_pts=21)
    w, s, e, n = AOI
    if not all(map(isfinite, bounds)) or bounds[2] <= w or bounds[0] >= e or bounds[3] <= s or bounds[1] >= n:
        raise ValueError(f"{name} does not intersect the Tso Kar study area.")
    r, c = src.height / 2, src.width / 2
    xx, yy = xy(src.transform, [r, r, r + 1], [c, c + 1, c], offset="ul")
    mx, my = transform(src.crs, CRS, xx, yy)
    spacing = [hypot(mx[i] - mx[0], my[i] - my[0]) for i in (1, 2)]
    if any(not isfinite(m) or m <= 0 for m in spacing):
        raise ValueError(f"{name} has invalid pixel spacing.")
    return {
        "member": name, "sha256": sha256(path), "crs": src.crs.to_string(), "bounds_wgs84": bounds,
        "shape": [src.height, src.width], "pixel_size_source_crs": src.res,
        "pixel_size_metres": spacing, "units": src.units, "nodata": [
            value if value is None or isfinite(value) else "NaN" for value in src.nodatavals
        ], "dtype": src.dtypes, "scale": src.scales, "offset": src.offsets,
        "raster_tags": src.tags(),
    }


def acquisition_dates(metadata):
    """Recognize explicit sensing fields while leaving production dates alone."""
    dates = set()
    for value in re.findall(
        rf"(?:{ACQUISITION_KEYS})[ \"']*(?:>|=|:)[ \"']*(\d{{4}}-\d{{2}}-\d{{2}}|\d{{8}}|\d{{2}}-[A-Za-z]{{3}}-\d{{4}})",
        metadata, re.IGNORECASE,
    ):
        for pattern in ("%Y-%m-%d", "%Y%m%d", "%d-%b-%Y"):
            try:
                dates.add(datetime.strptime(value, pattern).date())
                break
            except ValueError:
                continue
    return dates


def warp(src, indexes, nodata, affine, shape, resampling):
    kwargs = {} if nodata is None else {"src_nodata": nodata}
    with WarpedVRT(src, crs=CRS, transform=affine, width=shape[1], height=shape[0],
                   dtype="float32", nodata=np.nan, resampling=resampling, **kwargs) as local:
        values = local.read(indexes, masked=True, out_dtype="float32").filled(np.nan)
    for array, index in zip(values, indexes):
        array *= src.scales[index - 1]
        array += src.offsets[index - 1]
    return values


def write_tiff(folder, name, data, affine, nodata=None, unit=None, rgb=False):
    stack = data if data.ndim == 3 else data[None, :, :]
    with rasterio.open(folder / name, "w", driver="GTiff", width=stack.shape[2], height=stack.shape[1],
                       count=stack.shape[0], dtype=stack.dtype, crs=CRS, transform=affine,
                       nodata=nodata, compress="deflate", tiled=True, blockxsize=128, blockysize=128) as out:
        out.write(stack)
        if unit:
            out.set_band_unit(1, unit)
        if rgb:
            out.colorinterp = (ColorInterp.red, ColorInterp.green, ColorInterp.blue, ColorInterp.alpha)


def read_dem(path, source, affine, shape):
    with raster_files(path, source) as (files, metadata, dates):
        if len(files) != 1:
            raise ValueError("Provide one elevation GeoTIFF per CartoDEM source record.")
        name, raster = files[0]
        with rasterio.open(raster, driver="GTiff") as src:
            if src.driver != "GTiff" or src.count != 1:
                raise ValueError("CartoDEM must be a single-band elevation GeoTIFF.")
            info = raster_info(src, name, raster)
            unit = (src.units[0] or source.elevation_units).lower()
            if unit not in {"m", "metre", "meter", "metres", "meters"}:
                raise ValueError("CartoDEM elevations must be in metres.")
            info["elevation_unit_basis"] = "raster band metadata" if src.units[0] else "declared import metadata"
            if src.crs.is_geographic:
                plausible = all(0.90 <= angle * 3600 <= 1.10 for angle in src.res)
            else:
                plausible = all(20 <= m <= 40 for m in info["pixel_size_metres"])
            if not plausible:
                raise ValueError("CartoDEM needs 1 arc-second posting or an approximately 30 m projected grid.")
            data = warp(src, [1], source.nodata, affine, shape, Resampling.nearest)[0]
    return data, [info], metadata, dates


def read_imagery(path, source, affine, shape):
    if source.acquired.year != 2025:
        raise ValueError("The imagery acquisition date must be in 2025.")
    channels, details = [], []
    with raster_files(path, source) as (files, metadata, dates):
        if len(files) not in {1, 3}:
            raise ValueError("Use one RGB raster or three single-band rasters in display channel order.")
        for name, raster in files:
            driver = "JP2OpenJPEG" if raster.suffix.lower() == ".jp2" else "GTiff"
            with rasterio.open(raster, driver=driver) as src:
                info = raster_info(src, name, raster)
                if any(m > 80 for m in info["pixel_size_metres"]):
                    raise ValueError("Imagery is too coarse for the study overlay. Use georeferenced optical bands instead of a browse preview.")
                if len(files) == 3:
                    if src.count != 1 or source.bands is not None:
                        raise ValueError("Three selected imagery members must each contain one band.")
                    indexes = [1]
                else:
                    rgb = (ColorInterp.red, ColorInterp.green, ColorInterp.blue)
                    indexes = source.bands or ([src.colorinterp.index(color) + 1 for color in rgb]
                                               if all(color in src.colorinterp for color in rgb) else [])
                    if len(set(indexes)) != 3 or min(indexes) < 1 or max(indexes) > src.count:
                        raise ValueError("Provide RGB band metadata or list the three display band indexes.")
                nodata = source.nodata
                if nodata is None and source.family == "sentinel-2" and driver == "JP2OpenJPEG" and src.nodata is None:
                    nodata = 0
                channels.extend(warp(src, indexes, nodata, affine, shape, Resampling.bilinear))
                info["display_band_indexes"] = indexes
                info["nodata_override_applied"] = nodata
                details.append(info)
    return np.stack(channels), details, metadata, dates


def provenance(source, files, rasters, metadata, dates, raw_folder):
    for item in rasters:
        fields = "\n".join(f"{key}={value}" for key, value in item["raster_tags"].items())
        dates.update(acquisition_dates(fields))
    for item in files[1:]:
        path = raw_folder / item["stored_as"]
        if path.suffix.lower() in {".xml", ".meta", ".txt"} and path.stat().st_size <= 256 * 1024:
            dates.update(acquisition_dates(path.read_text(encoding="utf-8-sig", errors="replace")))
    if isinstance(source, ImageSource) and dates and dates != {source.acquired}:
        raise ValueError("Imagery acquisition date conflicts with the supplied product metadata.")
    if isinstance(source, DemSource) and source.acquired and len(dates) == 1 and source.acquired not in dates:
        raise ValueError("CartoDEM acquisition date conflicts with the supplied product metadata.")
    record = source.model_dump(mode="json", exclude={"file", "members", "metadata_files"})
    record["catalogue_url"] = BHUVAN if record.get("catalogue") == "Bhuvan" else BHOONIDHI
    record["files"] = files
    record["rasters"] = rasters
    record["archive_metadata_files"] = metadata
    record["metadata_acquisition_dates"] = [value.isoformat() for value in sorted(dates)]
    return record


def prepare_study(spec, input_dir, output):
    """Atomically publish a small, aligned dataset. Originals are preserved under raw/."""
    output = output.resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    if output.exists():
        raise ValueError("Choose a new output directory to preserve the existing study.")
    with TemporaryDirectory(dir=output.parent) as work:
        folder = Path(work) / "study"
        affine, shape, inside = study_grid()
        elevation = np.full(shape, np.nan, dtype="float32")
        sources = []
        for index, source in enumerate(spec.dem, 1):
            raw_folder = folder / "raw" / f"dem-{index}"
            path, files = preserve(source, input_dir, raw_folder)
            tile, rasters, metadata, dates = read_dem(path, source, affine, shape)
            valid = inside & np.isfinite(tile)
            if np.count_nonzero(valid) < 9:
                raise ValueError(f"{source.product_id} has too few valid pixels in the study area.")
            if np.any((tile[valid] < 1500) | (tile[valid] > 9000)):
                raise ValueError("Unexpected elevation values in the study area. Check vertical units and the source NoData metadata.")
            fill = valid & ~np.isfinite(elevation)
            elevation[fill] = tile[fill]
            record = provenance(source, files, rasters, metadata, dates, raw_folder)
            record["study_valid_pixels"] = int(np.count_nonzero(valid))
            record["mosaic_added_pixels"] = int(np.count_nonzero(fill))
            sources.append(record)

        valid = np.isfinite(elevation)
        terrain = Terrain(elevation, POSTING, POSTING, "", "", "")
        slope = slope_map(terrain).astype("float32")
        hazards = np.where(np.isfinite(slope), slope > HAZARD_SLOPE, 255).astype("uint8")
        write_tiff(folder, "elevation.tif", elevation, affine, np.nan, "m")
        write_tiff(folder, "slope.tif", slope, affine, np.nan, "degree")
        write_tiff(folder, "hazards.tif", hazards, affine, 255)
        output_names = ["elevation.tif", "slope.tif", "hazards.tif"]
        image_record = None
        if spec.imagery:
            source = spec.imagery
            raw_folder = folder / "raw" / "imagery"
            path, files = preserve(source, input_dir, raw_folder)
            image, rasters, metadata, dates = read_imagery(path, source, affine, shape)
            image_valid = inside & np.all(np.isfinite(image), axis=0)
            overlap = image_valid & valid
            if np.count_nonzero(overlap) < 9:
                raise ValueError("Imagery has too little valid overlap with the CartoDEM mosaic.")
            display = np.zeros((4, *shape), dtype="uint8")
            for channel, values in enumerate(image):
                low, high = np.percentile(values[image_valid], (2, 98))
                display[channel, image_valid] = np.clip(
                    255 * (values[image_valid] - low) / max(high - low, 1e-6), 0, 255
                ).astype("uint8")
            display[3, image_valid] = 255
            write_tiff(folder, "imagery.tif", display, affine, rgb=True)
            output_names.append("imagery.tif")
            image_record = provenance(source, files, rasters, metadata, dates, raw_folder)
            image_record["display"] = ("Sentinel-2 display composite" if source.family == "sentinel-2"
                                       else "Resourcesat display composite")
            image_record["dem_overlap_fraction"] = float(np.count_nonzero(overlap) / np.count_nonzero(valid))

        manifest = {
            "schema_version": 1,
            "name": "Tso Kar Valley, Ladakh",
            "source_status": "Catalogue provenance supplied by importer. Geospatial checks completed.",
            "study_bbox_wgs84": AOI, "crs": CRS, "posting_metres": POSTING, "shape": shape,
            "grid_transform": tuple(affine)[:6],
            "valid_coverage_fraction": float(np.count_nonzero(valid) / np.count_nonzero(inside)),
            "elevation_range_m": [float(np.nanmin(elevation)), float(np.nanmax(elevation))],
            "hazard_slope_degrees": HAZARD_SLOPE,
            "dem": sources, "imagery": image_record,
            "processed": {name: sha256(folder / name) for name in output_names},
        }
        (folder / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2, allow_nan=False),
                                               encoding="utf-8")
        folder.rename(output)
    return manifest


def load_window(directory, x=50, y=50, manifest=None):
    if manifest is None:
        manifest = json.loads((directory / "manifest.json").read_text(encoding="utf-8"))
    with rasterio.open(directory / "elevation.tif") as src:
        if (src.crs is None or src.crs.to_string() != CRS or src.shape != tuple(manifest["shape"])
                or tuple(src.transform)[:6] != tuple(manifest["grid_transform"]) or src.units != ("m",)):
            raise ValueError("Processed elevation does not match the study grid manifest.")
        width, height = min(105, src.width), min(85, src.height)
        window = Window(round((src.width - width) * x / 100), round((src.height - height) * y / 100), width, height)
        elevation = src.read(1, window=window, masked=True).filled(np.nan)
        if not np.any(np.isfinite(slope_map(Terrain(elevation, POSTING, POSTING, "", "", "")))):
            raise ValueError("This routing window has no usable elevations. Select a window with DEM coverage.")
        affine = src.window_transform(window)
        cx, cy = xy(affine, [height / 2], [width / 2], offset="ul")
        lon, lat = transform(src.crs, "EPSG:4326", cx, cy)
        expected_grid = (src.crs, src.transform, src.width, src.height)
    rgb = None
    if manifest.get("imagery"):
        with rasterio.open(directory / "imagery.tif") as image:
            if (image.crs, image.transform, image.width, image.height) != expected_grid:
                raise ValueError("Processed imagery is misaligned with the DEM.")
            rgb = image.read(window=window)
    terrain = Terrain(elevation, POSTING, POSTING, manifest["name"], "Declared CartoDEM source",
                      f"30 m analysis grid · {lat[0]:.5f}°, {lon[0]:.5f}° center")
    return terrain, rgb


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("spec", type=Path, help="JSON metadata alongside the downloaded files")
    parser.add_argument("--output", type=Path, default=Path("data/tsokar"))
    args = parser.parse_args()
    try:
        spec = ImportSpec.model_validate_json(args.spec.read_text(encoding="utf-8-sig"))
        manifest = prepare_study(spec, args.spec.parent, args.output)
    except (ValueError, OSError, rasterio.errors.RasterioError) as exc:
        parser.exit(2, f"Import failed: {exc}\n")
    print(f"Prepared {manifest['name']} at {args.output} "
          f"({manifest['valid_coverage_fraction']:.1%} of the study area has elevation).")


if __name__ == "__main__":
    main()
