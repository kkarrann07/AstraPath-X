from collections import OrderedDict
from functools import lru_cache
from hashlib import sha256
import json
import os
from pathlib import Path
import shutil
from tempfile import TemporaryDirectory
from threading import Lock
from typing import Annotated
from uuid import uuid4

import numpy as np
from fastapi import FastAPI, HTTPException, Query, Request, Response
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from rasterio.errors import RasterioError
from starlette.datastructures import UploadFile

from .mission import ROBUSTNESS_TRIALS, Network, Settings, alternatives, emergency, sampled_robustness
from .terrain import demo_terrain, matrix_json, read_geotiff, slope_map
from .tsokar import AOI, ImportSpec, load_window, prepare_study


app = FastAPI(title="AstraPath-X", version="1.0.0")
STATIC = Path(__file__).resolve().parent.parent / "static"
WORKSPACE_ID = sha256(os.path.normcase(str(STATIC.parent)).encode()).hexdigest()
app.mount("/assets", StaticFiles(directory=STATIC), name="assets")

DEMO = demo_terrain()
UPLOAD_LIMIT = 32 * 1024 * 1024
uploads = OrderedDict()
upload_lock = Lock()
STUDY_LIMIT = 96 * 1024 * 1024
LOCAL_STUDY_LIMIT = 2 * 1024**3
studies = OrderedDict()
study_lock = Lock()
import_lock = Lock()
Coordinate = tuple[Annotated[int, Field(ge=0, le=160)], Annotated[int, Field(ge=0, le=160)]]


class Configuration(BaseModel):
    capacity: float = Field(120, gt=0, le=5000)
    initial_pct: float = Field(82, ge=0, le=100)
    budget: float = Field(100, ge=0, le=5000)
    reserve: float = Field(18, ge=0, le=5000)
    max_slope: float = Field(19, gt=0, le=60)
    speed: float = Field(0.85, ge=0.05, le=10)
    traction: float = Field(18, ge=0, le=500)
    hotel: float = Field(15, ge=0, le=1000)
    solar_rate: float = Field(36, ge=0, le=1000)
    azimuth: float = Field(112, ge=0, le=360)
    altitude: float = Field(7, ge=0, le=90)
    solar: bool = True
    round_trip: bool = False
    uncertainty: float = Field(1, ge=0, le=30)


class MissionRequest(BaseModel):
    terrain: str = Field("demo", max_length=40)
    start: Coordinate
    target: Coordinate
    settings: Configuration = Field(default_factory=Configuration)


class EmergencyRequest(MissionRequest):
    position: Coordinate
    battery: float = Field(ge=0, le=5000)
    returning: bool = False


def get_terrain(terrain_id):
    if terrain_id == "demo":
        return DEMO
    with upload_lock:
        if terrain_id not in uploads:
            raise HTTPException(404, "Terrain session expired. Upload the DEM again.")
        uploads.move_to_end(terrain_id)
        return uploads[terrain_id]


def describe_terrain(terrain_id, terrain):
    h, w = terrain.elevation.shape
    if terrain_id == "demo":
        start, target = (42, 10), (30, 90)
    else:
        slopes = slope_map(terrain)
        points = np.argwhere(np.isfinite(slopes) & (slopes <= Settings.max_slope))
        if len(points) < 2:
            points = np.argwhere(np.isfinite(terrain.elevation))
        start, target = [points[np.argmin(np.sum((points - (h * y, w * x)) ** 2, axis=1))].tolist()
                         for y, x in ((0.55, 0.15), (0.4, 0.85))]
    return {
        "id": terrain_id, "name": terrain.name, "origin": terrain.origin, "detail": terrain.detail,
        "width": w, "height": h, "dx": terrain.dx, "dy": terrain.dy,
        "start": start, "target": target, "elevation": matrix_json(terrain.elevation),
        "min_elevation": float(np.nanmin(terrain.elevation)), "max_elevation": float(np.nanmax(terrain.elevation)),
    }


@lru_cache(maxsize=4)
def get_network(terrain_id, settings):
    return Network(get_terrain(terrain_id), settings)


def prepare(request, *positions):
    settings = Settings(**request.settings.model_dump())
    get_terrain(request.terrain)
    network = get_network(request.terrain, settings)
    height, width = network.allowed.shape
    for row, col in (request.start, request.target, *positions):
        if not (row < height and col < width):
            raise HTTPException(422, "A mission point is outside the terrain.")
    return network, settings


@app.get("/", include_in_schema=False)
def index():
    return FileResponse(STATIC / "index.html")


@app.get("/health")
def health(response: Response):
    response.headers["X-AstraPath-Workspace"] = WORKSPACE_ID
    return {"status": "ok"}


@app.get("/tso-kar-guide", include_in_schema=False)
def tsokar_guide():
    return FileResponse(STATIC.parent / "docs" / "TSO_KAR.md", media_type="text/plain; charset=utf-8")


@app.get("/tso-kar-aoi.kml", include_in_schema=False)
def tsokar_aoi():
    return FileResponse(STATIC.parent / "docs" / "tsokar-aoi.kml",
                        media_type="application/vnd.google-earth.kml+xml", filename="tsokar-aoi.kml")


@app.get("/tso-kar-import.example.json", include_in_schema=False)
def tsokar_import_template():
    return FileResponse(STATIC.parent / "docs" / "tsokar-import.example.json",
                        media_type="application/json", filename="tsokar-import.example.json")


@app.get("/api/terrain/demo")
def demo():
    return describe_terrain("demo", DEMO)


def register_terrain(terrain):
    terrain_id = uuid4().hex
    with upload_lock:
        uploads[terrain_id] = terrain
        if len(uploads) > 12:
            uploads.popitem(last=False)
    return terrain_id


@app.post("/api/terrain/upload")
async def upload(request: Request, name: str = Query("Elevation DEM", max_length=100),
                 x: float = Query(50, ge=0, le=100), y: float = Query(50, ge=0, le=100)):
    data = bytearray()
    async for chunk in request.stream():
        if len(data) + len(chunk) > UPLOAD_LIMIT:
            raise HTTPException(413, "Upload limit is 32 MiB. Crop or compress the DEM first.")
        data.extend(chunk)
    try:
        terrain = await run_in_threadpool(read_geotiff, bytes(data), name, x, y)
    except (RasterioError, ValueError) as exc:
        message = str(exc) if isinstance(exc, ValueError) else "The file could not be read as a georeferenced GeoTIFF."
        raise HTTPException(422, message) from exc
    terrain_id = register_terrain(terrain)
    return describe_terrain(terrain_id, terrain)


def installed_study():
    return Path(os.environ.get("ASTRAPATH_TSOKAR_DIR", STATIC.parent / "data" / "tsokar"))


def can_save_locally():
    return os.environ.get("ASTRAPATH_SAVE_LOCAL") == "1" and not installed_study().exists()


def local_study_request(request):
    return (os.environ.get("ASTRAPATH_SAVE_LOCAL") == "1"
            and request.url.hostname in {"127.0.0.1", "localhost"}
            and request.headers.get("origin") == f"http://{request.url.netloc}")


def upload_limit_mib():
    limit = LOCAL_STUDY_LIMIT if os.environ.get("ASTRAPATH_SAVE_LOCAL") == "1" else STUDY_LIMIT
    return limit // 1024**2


def study_summary(study_id, manifest):
    return {
        "id": study_id, "name": manifest["name"], "bbox": manifest["study_bbox_wgs84"],
        "coverage": manifest["valid_coverage_fraction"], "posting": manifest["posting_metres"],
        "can_save_locally": can_save_locally(),
        "upload_limit_mib": upload_limit_mib(),
        "dem": [{key: item[key] for key in ("product_id", "version", "acquired")} for item in manifest["dem"]],
        "imagery": ({key: manifest["imagery"][key] for key in ("product_id", "acquired", "display")}
                    if manifest["imagery"] else None),
    }


@app.get("/api/tsokar")
def tsokar_status():
    path = installed_study() / "manifest.json"
    if not path.is_file():
        return {"id": None, "name": "Tso Kar Valley, Ladakh", "bbox": AOI,
                "can_save_locally": can_save_locally(), "upload_limit_mib": upload_limit_mib()}
    try:
        return study_summary("installed", json.loads(path.read_text(encoding="utf-8")))
    except (OSError, ValueError, KeyError, TypeError) as exc:
        raise HTTPException(422, "The installed Tso Kar manifest is unreadable or incomplete.") from exc


def import_study(spec, files, save_local=False):
    with import_lock:
        if save_local and not can_save_locally():
            raise HTTPException(409, "The local study directory already exists or saving is disabled.")
        session = TemporaryDirectory(prefix="astrapath-study-")
        try:
            root = Path(session.name)
            directory = installed_study() if save_local else root / "study"
            with TemporaryDirectory(dir=root) as upload_dir:
                incoming = Path(upload_dir)
                for file in files:
                    name = file.filename
                    if not name or name in {".", ".."} or any(char in name for char in "\\/:"):
                        raise ValueError("File uploads must have plain, unique filenames.")
                    with (incoming / name).open("xb") as output:
                        shutil.copyfileobj(file.file, output, 1024 * 1024)
                manifest = prepare_study(spec, incoming, directory)
            if save_local:
                session.cleanup()
                return study_summary("installed", manifest)
            study_id = uuid4().hex
            with study_lock:
                studies[study_id] = (session, directory, manifest)
                if len(studies) > 3:
                    _, (old, _, _) = studies.popitem(last=False)
                    old.cleanup()
            return study_summary(study_id, manifest)
        except (ValueError, OSError, RasterioError) as exc:
            session.cleanup()
            raise HTTPException(422, str(exc)) from exc


@app.post("/api/tsokar/import")
async def tsokar_import(request: Request, save_local: bool = False):
    from_launcher = local_study_request(request)
    if save_local and not from_launcher:
        raise HTTPException(403, "Save as startup terrain is available from the local Windows launcher.")
    length = request.headers.get("content-length", "")
    if not length.isdigit():
        raise HTTPException(411, "A file upload must include its content length.")
    limit = LOCAL_STUDY_LIMIT if from_launcher else STUDY_LIMIT
    if int(length) > limit:
        detail = ("The import exceeds the 2 GiB local browser limit."
                  if from_launcher else "This server accepts up to 96 MiB. Use the Windows launcher for larger imports.")
        raise HTTPException(413, detail)
    async with request.form(max_files=24, max_fields=1, max_part_size=64 * 1024) as form:
        metadata = form.get("spec")
        files = form.getlist("files")
        if not isinstance(metadata, str) or not files or not all(isinstance(f, UploadFile) for f in files):
            raise HTTPException(422, "Upload a JSON import manifest and the files it references.")
        try:
            spec = ImportSpec.model_validate_json(metadata.lstrip("\ufeff"))
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc
        return await run_in_threadpool(import_study, spec, files, save_local)


def resolve_study(study_id):
    if study_id == "installed":
        directory = installed_study()
        path = directory / "manifest.json"
        if path.is_file():
            return directory, json.loads(path.read_text(encoding="utf-8"))
    elif study_id in studies:
        studies.move_to_end(study_id)
        _, directory, manifest = studies[study_id]
        return directory, manifest
    raise HTTPException(404, "The Tso Kar study is unavailable. Import the files or load a prepared study.")


@app.get("/api/tsokar/{study_id}/manifest")
def tsokar_manifest(study_id: str):
    with study_lock:
        _, manifest = resolve_study(study_id)
    return manifest


@app.get("/api/tsokar/{study_id}/window")
def tsokar_window(study_id: str, x: float | None = Query(None, ge=0, le=100),
                  y: float | None = Query(None, ge=0, le=100)):
    with study_lock:
        try:
            directory, manifest = resolve_study(study_id)
            terrain, imagery, center = load_window(directory, x, y, manifest, return_center=True)
        except (ValueError, OSError, RasterioError, KeyError, TypeError) as exc:
            raise HTTPException(422, str(exc)) from exc
    result = describe_terrain(register_terrain(terrain), terrain)
    result["study"] = study_summary(study_id, manifest)
    result["window"] = {"x": center[0], "y": center[1]}
    if imagery is not None:
        result["imagery"] = np.moveaxis(imagery, 0, -1).tolist()
    return result


@app.post("/api/plan")
def plan(request: MissionRequest):
    network, settings = prepare(request)
    starts_valid = request.start in network.outgoing and request.target in network.outgoing
    distinct = request.start != request.target
    returns = network.return_requirements(request.start) if starts_valid and distinct else {}
    options = (alternatives(network, request.start, request.target, settings.initial, returns)
               if starts_valid and distinct else {})
    if not distinct:
        message = "Pick distinct base and target cells."
    elif not starts_valid:
        message = "Choose base and target outside steep or unknown terrain."
    elif not any(options.values()):
        message = "No terrain-connected route between the selected cells."
    elif not any(route and route["feasible"] for route in options.values()):
        message = "All modeled route options exceed the current mission limits."
    else:
        message = ""
    return {
        "routes": options, "message": message, "floor": settings.floor, "initial": settings.initial,
        "slope": matrix_json(network.slopes), "restricted": (~network.allowed).tolist(),
        "illuminated": network.lit.tolist(),
    }


@app.post("/api/robustness")
def robustness(request: MissionRequest):
    network, settings = prepare(request)
    paths = {policy: path for policy in ("shortest", "safest", "energy")
             if (path := network.path(request.start, request.target, policy))}
    return {"passes": sampled_robustness(network, paths, request.start), "trials": ROBUSTNESS_TRIALS,
            "seed": 2026, "sigma": settings.uncertainty}


@app.post("/api/emergency")
def replan(request: EmergencyRequest):
    network, settings = prepare(request, request.position)
    if request.battery > settings.capacity:
        raise HTTPException(422, "Current battery must be within capacity.")
    return emergency(network, request.start, request.position, request.target, request.battery, request.returning)
