# AstraPath-X · Rover Survival Intelligence

**ASTRA 2026** · Don't just find a route. Make sure the rover survives the mission.

AstraPath-X plans and stress-tests rover traverses on an elevation grid. Compare the shortest, slope-averse and energy-efficient routes, track the battery and return threshold, then inject a fault and watch the planner decide whether to continue, return or hold.

## Start on Windows

1. Open the project folder in File Explorer and double-click **Start_AstraPath.bat**. If you downloaded a ZIP from GitHub, extract the entire folder first.
2. Allow the first launch to finish. The launcher creates a local Python environment, installs dependencies, and opens the dashboard in your default browser. Internet access is needed to install packages on first launch or after dependencies change. If Python is missing, install Python 3.12, 3.13, or 3.14 with the [official graphical Windows installer](https://www.python.org/downloads/windows/) and double-click the launcher again.
3. Keep the launcher window open while using the app. Double-clicking again reopens the running dashboard. The default address is [http://127.0.0.1:8765](http://127.0.0.1:8765). If another service occupies that port, the launcher displays and opens a different local address.

### Load terrain in the browser

- A prepared Tso Kar study in `data/tsokar` loads on startup. When no study is installed, the **Terrain data** panel says so and clearly identifies Kestrel Basin as a synthetic demo.
- For one elevation file, choose **Upload GeoTIFF**, select a georeferenced single-band elevation file in metres, and choose **Load terrain**. Files up to 32 MiB are supported.
- For official Tso Kar files, choose **Real ISRO Dataset Mode → Guided import**, supply the CartoDEM TIFF or ZIP and the catalogue metadata, then choose **Import and load**. Check **Save as startup terrain on this computer** to retain the prepared study and source files locally and load them on the next launch. This option is available from the Windows launcher while there is no installed study directory. Additional uploads can run as session studies. Browser imports are limited to 96 MiB.

[Tso Kar download and import guide](docs/TSO_KAR.md)

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
- The upload pipeline was verified with generated geographic and projected GeoTIFF files. Authentic Tso Kar data is obtained separately through the official portal sign-in and download flow. [Ladakh CartoDEM download and provenance](docs/DATA.md)
- See [the mission model](docs/MODEL.md) for routing costs, energy and return calculations, and their limits.

## Deploy to Streamlit Community Cloud

1. Publish these project files in the GitHub branch you want to deploy. Local downloads, saved studies, and Python environments are excluded by `.gitignore`.
2. Sign in to [Streamlit Community Cloud](https://share.streamlit.io/), select **Create app** and choose the GitHub repository, branch, and entry point **`cloud/streamlit_app.py`**. In **Advanced settings**, select Python **3.13**. The entry point's requirements include the tested Streamlit version and the shared FastAPI dependencies.
3. Deploy and open the URL Cloud assigns. The Streamlit page embeds the full AstraPath-X dashboard from the same host. **Open dashboard in a full tab** opens it directly. Verify terrain rendering and route generation on that URL before sharing it.

Cloud uploads last for the server session. Use the Windows launcher for persistent uploads on your computer. [Community Cloud deployment guide](https://docs.streamlit.io/deploy/streamlit-community-cloud/deploy-your-app/deploy)

## Alternative hosting on Render

1. Push the repository to GitHub, GitLab or Bitbucket and connect that repository to your Render workspace.
2. In Render select **New → Blueprint**, choose the repository, and apply the included `render.yaml`. It provisions one free Python Web Service in Singapore with `/health` as the health check.
3. Once the service reports **Live**, open its Render URL, check `/health`, and run the judge challenge. Free services can cold-start after inactivity.
4. For manual setup, create a **Web Service** using the **Free** plan and **Python** runtime, then enter the Build Command and Start Command from `render.yaml`. Hosted uploads are session-based and may expire after a restart or when recent uploads replace older ones.

[Render Blueprint setup](https://render.com/docs/infrastructure-as-code) · [Free-tier behavior](https://render.com/docs/free)

## Repository layout

- `Start_AstraPath.bat` starts the local Windows launcher.
- `cloud/streamlit_app.py` is the Community Cloud entry point.
- `astrapath/terrain.py` reads DEMs, computes slopes and estimates terrain shadows.
- `astrapath/mission.py` builds the traversable graph, compares routes, simulates charge and replans.
- `astrapath/api.py` serves the dashboard and the planning API.
- `static/` contains the dashboard, canvas map and battery chart.
- `tests/` exercises the mission model and application endpoints.

For development, the FastAPI entry point is `astrapath.api:app`. Install `requirements-dev.txt` in a virtual environment and run `python -m pytest -q`. API documentation is available at `/docs` and the service health check at `/health`.
