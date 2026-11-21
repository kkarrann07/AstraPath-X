# AstraPath-X · Rover Survival Intelligence

**ASTRA 2026** · Don't just find a route. Make sure the rover survives the mission.

AstraPath-X plans and stress-tests rover traverses on an elevation grid. Compare the shortest, slope-averse and energy-efficient routes, track the battery and return threshold, then inject a fault and watch the planner decide whether to continue, return or hold.

## Run locally

Use Python 3.12–3.14. From the repository root:

```powershell
python -m venv .venv
.venv\Scripts\python -m pip install -r requirements-dev.txt
.venv\Scripts\python -m uvicorn astrapath.api:app --port 8765
```

On macOS or Linux, use `.venv/bin/python` in the last two commands. Open [Rover Mission Control](http://127.0.0.1:8765). The synthetic basin loads automatically. The dashboard uses bundled HTML, CSS and JavaScript and needs no map provider or external assets.

Run the tests with `python -m pytest -q` using the virtual environment's Python. API docs are available at `/docs` and the service health check at `/health`.

## Live judge challenge

1. Click **Judge challenge** to load Kestrel Basin with Base `42,10`, Target `30,90` and the shortest route selected. Judges can set other endpoints on the map or enter row and column values. Reset to the challenge defaults before the steps below.
2. With **Solar Survival** on, compare the shorter 2.55 km route (60% illuminated, about 52.0 Wh at target) and the 2.91 km energy-efficient route (100% illuminated, about 60.8 Wh at target). Toggle solar off to compare projections and the energy route, then turn it back on. Switch to **Hazards** to inspect restricted terrain.
3. Select **Shortest**, then click **Advance 5 cells** three times. Inject the default **45% battery loss**. The rover replans from cell 15 and recommends **RETURN** with the modeled route, slope, charge floor and predicted minimum charge. Advance along the amber return route. For a second outcome, reset and inject **100%** loss at the same point to produce **STOP/HOLD**.
4. Reset the shortest route and press **Play**. The rover pauses before its first **Point of No Return**, approximately 2.48 km into this plan. The map marks it and the battery timeline shows where the projected charge falls below the modeled return threshold. Resume to cross the point in one-way mode.
5. Enable **Require return to base**. The shortest candidate is rejected. Select **Energy-efficient**, advance to target, and click **Return to base** to execute the modeled return. **Idle 10 min** simulates stationary power draw and solar input at the current cell before recalculating the recommendation.
6. Adjust the elevation uncertainty in **Mission parameters**. Route cards show how many of 20 deterministic terrain trials met the configured constraints.

## Elevation data

- The bundled Kestrel Basin is procedurally generated and has no claimed geographic location.
- **Real ISRO Dataset Mode** loads a provenance-tracked Tso Kar CartoDEM mosaic and optional Bhoonidhi 2025 imagery. See the [Tso Kar download and import guide](docs/TSO_KAR.md) for the AOI, exact portal selections, and local preparation.
- **Upload GeoTIFF** accepts a single-band georeferenced elevation raster of up to 32 MiB. The server processes a window up to 105 × 85 source pixels. Use window X/Y or crop the file to focus on a particular area. Imported windows and paths use the same mission analysis as the demo.
- See [Ladakh CartoDEM download and provenance](docs/DATA.md). The upload pipeline was verified with generated geographic and projected GeoTIFF files. The official CartoDEM download requires a Bhuvan login, and no CartoDEM tile was obtained for this build.
- See [the mission model](docs/MODEL.md) for routing costs, energy and return calculations, and their limits.

## Deploy to Render Free

1. Push the repository to GitHub, GitLab or Bitbucket and connect that repository to your Render workspace.
2. In Render select **New → Blueprint**, choose the repository, and apply the included `render.yaml`. It provisions one free Python Web Service in Singapore with `/health` as the health check.
3. Once the service reports **Live**, open its Render URL, check `/health`, and run the judge challenge. Free services can cold-start after inactivity.
4. For manual setup, create a **Web Service** using the **Free** plan and **Python** runtime, then enter the Build Command and Start Command from `render.yaml`. The service uses one process. Uploads are held temporarily in memory and expire after a restart or when recent uploads replace older ones.

[Render Blueprint setup](https://render.com/docs/infrastructure-as-code) · [Free-tier behavior](https://render.com/docs/free)

## Repository layout

- `astrapath/terrain.py` reads DEMs, computes slopes and estimates terrain shadows.
- `astrapath/mission.py` builds the traversable graph, compares routes, simulates charge and replans.
- `astrapath/api.py` serves the dashboard and the planning API.
- `static/` contains the dashboard, canvas map and battery chart.
- `tests/` exercises the mission model and application endpoints.
