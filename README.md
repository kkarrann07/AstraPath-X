# AstraPath-X · Rover Survival Intelligence

**ASTRA 2026** · Don't just find a route. Make sure the rover survives the mission.

AstraPath-X plans and stress-tests rover traverses on an elevation grid. Compare the shortest, slope-averse and energy-efficient routes, track the battery and return threshold, then inject a fault and watch the planner decide whether to continue, return or hold.

## Start on Windows

1. Open the project folder in File Explorer and double-click **Start_AstraPath.bat**. If you downloaded a ZIP from GitHub, extract the entire folder first.
2. Allow the first launch to finish. The launcher creates a local Python environment, installs dependencies, and opens the dashboard in your default browser. Internet access is needed to install packages on first launch or after dependencies change. If Python is missing, install Python 3.12, 3.13, or 3.14 with the [official graphical Windows installer](https://www.python.org/downloads/windows/) and double-click the launcher again.
3. Keep the launcher window open while using the app. Double-clicking again reopens the running dashboard. The default address is [http://127.0.0.1:8765](http://127.0.0.1:8765). If another service occupies that port, the launcher displays and opens a different local address.

### Load terrain in the browser

- A prepared Tso Kar study in `data/tsokar` loads on startup. When no study is installed, **Terrain source** says so and identifies Kestrel Basin as a synthetic demo.
- For one elevation file, choose **Upload GeoTIFF**, select a georeferenced single-band elevation file in metres, and choose **Load terrain**. Files up to 32 MiB are supported.
- For official Tso Kar files, choose **ISRO datasets → Get the official satellite files** for search coordinates and the AOI download. In **Guided import**, supply the CartoDEM TIFF or ZIP and catalogue metadata, then choose **Import and load**. Check **Save as startup terrain on this computer** to keep the first prepared study and originals. The Windows launcher accepts browser imports up to 2 GiB per request. Hosted imports are limited to 96 MiB.

[Tso Kar download and import guide](docs/TSO_KAR.md)

## Live judge challenge

1. Open **Judge challenge** to load the synthetic Kestrel Basin. Adjust battery, maximum slope, solar charging, or the return requirement to replan immediately. **Back to plan** returns to route comparison. **Open simulation** starts at the base when the selected route is feasible. Reopen the challenge to restore the default conditions.
2. Compare **Fastest / Shortest** at 2.55 km and about 52.0 Wh at arrival with **Energy-efficient** at 2.91 km and about 60.8 Wh at arrival. The **Battery forecast** shows modeled sunlight and shadow by distance. Toggle **Solar Survival** to compare charging and choose **Hazards** to inspect restricted terrain.
3. Select **Fastest / Shortest**, open **Simulate**, and click **Advance 5 cells** three times. Inject the default **45% battery loss**. The rover replans from cell 15 and recommends **RETURN**. The event timeline records the fault and the decision. For a second outcome, reset and inject **100%** loss at the same point to produce **STOP/HOLD**.
4. Reset the shortest route and press **Play**. The rover pauses before its first **Point of No Return**, approximately 2.48 km into this plan. The map marks it and the battery timeline shows where the projected charge falls below the modeled return threshold. Resume to cross the point in one-way mode.
5. Enable **Require return to base**. The shortest candidate is rejected. Select **Energy-efficient**, advance to target, and click **Return to base** to execute the modeled return. **Idle 10 min** simulates stationary power draw and solar input at the current cell before recalculating the recommendation.
6. Adjust elevation uncertainty under **Mission configuration → Advanced parameters**, then choose **Plan mission**. Mission intelligence reports how many of 20 deterministic terrain trials met the configured constraints for the selected candidate.

## Mission-control workspace

- **Mission configuration** holds the terrain selector, waypoints, battery and reserve, maximum slope, optimization policy, and solar assumptions. Select **Plan mission** to apply edited fields. On narrow displays, select **Show settings** to expand the panel.
- **Terrain view** supports elevation, slope, hazards, simulated sunlight and registered imagery when available. Drag to pan, use the wheel or zoom controls, and hover over a route to inspect its metrics. With the map focused, use arrow keys to pan, **+** or **−** to zoom, and **Home** to reset. For keyboard waypoint placement, select a waypoint, center the map and press **Enter**. You can also enter row and column directly.
- **Mission intelligence** shows the gross energy requirement, expected arrival charge, modeled return threshold, robustness and recommendation for the selected route. The return threshold includes the mission floor. The amber dashed map sections mark modeled return deficits.
- **Simulate** exposes flight controls and a time-stamped event timeline. The battery graph shows projected charge, gross energy used, modeled solar gain and the return threshold. Solar, battery and recommendation outputs are model results.
- **Compare terrains** pairs an Earth grid with an interactive NASA lunar globe or a regional LOLA elevation, slope, or hazard layer. Select Shackleton rim or Connecting ridge to plan a traverse on the same grid in the rover simulator. The Apollo views provide imagery and coordinates with planning disabled because those regional grids are absent.

[Desktop mission plan](docs/screenshots/mission-control-desktop.jpg) · [Emergency replan](docs/screenshots/mission-control-simulation.jpg) · [Tablet](docs/screenshots/mission-control-tablet.jpg) · [Mobile](docs/screenshots/mission-control-mobile.jpg)

## Moon-to-Ladakh comparison

1. Open **Compare terrains**. When a Tso Kar study is installed, the Earth panel uses its CartoDEM window. Otherwise it starts on **Kestrel Basin · Synthetic** and identifies the missing CartoDEM. Select **ISRO datasets** to import authorized files. The Earth **Imagery** layer becomes available when the study has registered imagery.
2. Drag the 3D Moon to rotate it, scroll to zoom, and choose a region to shift the camera. A purple marker identifies the selected site. **Pause rotation**, **Reset view**, and **Fullscreen** control the globe. With the canvas focused, use the arrow keys, **+**, **−**, and **Home**. WebGL 2 enables the globe. Other browsers show the NASA flat mosaic and retain regional DEM layers.
3. Choose **Elevation**, **Slope**, or **Hazards** and use the shared **Slope screening** threshold. Pan and zoom either grid, hover to inspect elevation and slope, or focus a grid and press **Enter** to inspect its center. Each panel keeps the source grid spacing and displays its own physical scale, relief and slope summary.
4. Select **Plan Earth traverse** or **Plan lunar traverse**. The planner loads the displayed dataset and uses the selected slope threshold. Use **Simulate** for battery, solar, emergency replanning and Point of No Return. The Earth and lunar windows have different grid postings, datums, surface properties and gravity. Their slope screens estimate broad terrain constraints and cannot resolve rover-scale obstacles.

[Comparison screenshot](docs/screenshots/moon-to-ladakh.jpg) · [Lunar slope analysis](docs/screenshots/lunar-slope-comparison.jpg) · [Lunar route planning](docs/screenshots/lunar-planning.jpg) · [Lunar data and attribution](docs/LUNAR.md)

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
