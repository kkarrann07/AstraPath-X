# Tso Kar Valley data acquisition and integration

## Study area

Use **west 77.8800, south 33.2100, east 78.1300, north 33.3800**, in decimal WGS 84. This rectangular engineering study area surrounds Tso Kar and Startsapuk Tso and gives the routing model terrain around the lakes. Ramsar site 2443 lists the reference location as 33°17′53″N, 78°00′42″E, about 33.29806°N, 78.01167°E. The rectangle is a catalogue and processing extent. Consult the Ramsar documents for the mapped wetland boundary. [Ramsar Information Sheet](https://rsis.ramsar.org/RISapp/files/RISrep/IN2443RIS_2012_en.pdf)

The rectangle spans 78°E. For a catalogue offering 1° chips, check both cells 77°–78°E and 78°–79°E, each at 33°–34°N. Confirm the product footprints and IDs on the portal because tile naming and packaging can differ. [Legacy NOEDA selection options](https://bhuvan-app3.nrsc.gov.in/data/download/help/source/html/introduction.htm)

## Download CartoDEM first

1. Open [Bhuvan downloads](https://bhuvan-app3.nrsc.gov.in/data/download/) and select **Satellite/Sensor → Cartosat-1**. The live selector redirects Cartosat-1 users to [Bhoonidhi Browse & Order](https://bhoonidhi.nrsc.gov.in/bhoonidhi/index.html). If your legacy interface exposes **CartoDEM 1 arc second**, use **Bounding Box** with the four coordinates above, then **Next → Metadata → Download**. The legacy service requires a Bhuvan login for downloads. [Bhuvan help](https://bhuvan-app3.nrsc.gov.in/data/download/help/source/html/steps_to_download_data.htm)
2. On Bhoonidhi, go to **Search-Criteria**, enable **Area of Interest**, select **KML / KMZ**, and select the bundled `tsokar-aoi.kml` in this folder. Use the control next to the file to display the AOI on the map. Alternatively, use **Location → Decimal**, set latitude **33.295**, longitude **78.005**, and use an area large enough to include the bounding box, then verify the footprint visually.
3. In **Satellite-Sensor**, expand **OpenData_DirectDownload** and select **CartoSat-1_PAN_CartoDEM-30m**. The API documentation writes this collection as `CartoSat-1_PAN_CartoDEM_30m`. Avoid 10 m and 2.5 m products, which are in the priced group. If the date filter excludes the DEM, broaden the search to cover the Cartosat-1 mission archive and check the product metadata. Do not filter CartoDEM to 2025. Click **Submit → Search-Results** and inspect **Details/Metadata** and each footprint. [Free 30 m product announcement](https://bhoonidhi.nrsc.gov.in/bhoonidhi_resources/help/newsletters/Bhoonidhi_Newsletter_2024_Edition_2.pdf)
4. Select the free result(s) whose combined footprints cover the rectangle, add them to the **Open/Direct Download Cart**, and confirm the items in **Cart**. Sign in or register in your own browser session, complete any verification, and download the original archive and metadata. Keep the tile ID, version, any acquisition date or range, the reported no-data value, and the product terms. Use the product's actual date or leave the date unspecified and record the date range or reason in `acquisition_note`. [Bhoonidhi manual](https://bhoonidhi.nrsc.gov.in/bhoonidhi_resources/help/docs/Bhoonidhi_ISROEOHub_UserManual_V2.0.pdf) · [Portal terms](https://bhoonidhi.nrsc.gov.in/bhoonidhi/htmls/TnC.html)

## Search for 2025 imagery

1. Keep the same AOI in Bhoonidhi and set **01 January 2025** to **31 December 2025** in **Date range**. On the calendar, click the month/year heading to jump to the month and year selectors.
2. Expand **OpenData_DirectDownload** and select **ResourceSat-2_LISS3_L2**, **ResourceSat-2A_LISS3_L2**, and/or their **LISS3_BOA-Archives** entries. LISS-3 has nominal 23.5 m sampling. Check that the selected scene is georeferenced and covers the AOI. Review quicklooks and available cloud metadata. Prefer low-cloud/snow scenes that visibly cover both lakes. [Resourcesat sensor specifications](https://bhoonidhi.nrsc.gov.in/bhoonidhi_resources/help/archives/BWS1_02Nov2022/1-BWS1-EO%20Sensors%20ImagePlanning.pdf)
3. If an archived or freely orderable Resourcesat scene is unsuitable, search the same date range and AOI for **Sentinel-2A/B/C_MSI_Level-2A** in the open group. For a color display, use the 10 m red, green, and blue bands. Sentinel imagery retains its Copernicus/ESA attribution and is distributed through Bhoonidhi. [Bhoonidhi catalogue](https://bhoonidhi.nrsc.gov.in/bhoonidhi/) · [Product FAQ](https://bhoonidhi.nrsc.gov.in/bhoonidhi/htmls/FAQ2.html)
4. In **Search-Results**, open product details and confirm the acquisition date, full product ID, processing level or baseline, footprint and free eligibility. Add an eligible scene to the Open Cart, confirm the selection and download while signed in. The portal may queue older products. Keep its original metadata and the applicable license text or reference. Report a gap if a suitable 2025 scene cannot be confirmed. [Bhoonidhi user manual](https://bhoonidhi.nrsc.gov.in/bhoonidhi_resources/help/docs/Bhoonidhi_ISROEOHub_UserManual_V2.0.pdf)

## Prepare downloaded data

For ordinary TIFFs and unambiguous ZIPs, open **Terrain data → Real ISRO Dataset Mode → Guided import**. Select the first CartoDEM file and enter its product ID, version, and license or terms reference from the catalogue. Enter the acquisition date if known and use **Add another tile** for each additional file. To add a qualifying optical scene, open **Attach 2025 imagery** and fill in the scene metadata. When using the Windows launcher, check **Save as startup terrain on this computer** if you want to keep the first study and load it automatically after restart. Select **Import and load**.

For specific ZIP members, explicit band order, or separate catalogue metadata files, choose **Use JSON manifest**. Place the original downloads and accompanying metadata together, copy `tsokar-import.example.json` beside them, and replace the examples with the catalogue values. Add one `dem` entry per tile. Leave `imagery` null until you have an eligible scene. Include documented `nodata` overrides only when necessary. ZIP input preserves the archive and records metadata filenames inside it. Standalone metadata files referenced in `metadata_files` are copied and hashed.

- For a ZIP with multiple elevation rasters, specify the exact GeoTIFF member path and use one source record per tile. For ambiguous imagery archives, specify a single georeferenced RGB member or three single-band member paths in display order. Use forward slashes and names exactly as shown in the ZIP.
- Sentinel-2 SAFE inputs can use B04, B03 and B02 JP2 files. The importer prefers matching 10 m members. Resourcesat LISS-3 does not provide a blue band. Map B4, B3 and B2 to displayed red, green and blue for a false-color composite. If GeoTIFFs arrive as separate files, put the three originals and metadata into a ZIP, or select the correct bands in a georeferenced multiband TIFF. For a multiband TIFF with no RGB designation, set `bands` to three 1-based display indexes. Keep the source files unchanged.
- In **Use JSON manifest**, select the JSON plus every referenced file. The server keeps up to three browser study sessions while it runs. Browser uploads have a 96 MiB combined request limit. For large Sentinel archives, or to preserve the study across restarts, use the local importer.

When you have a qualifying scene, replace `"imagery": null` in the example JSON with a record using the following structure. The example identifiers and date are placeholders.

```json
"imagery": {
  "file": "replace-with-downloaded-scene.zip",
  "product_id": "replace-with-actual-scene-id",
  "version": "replace-with-processing-level-or-baseline",
  "family": "resourcesat",
  "acquired": "2025-01-01",
  "license": "Replace with the scene terms and attribution.",
  "members": [],
  "metadata_files": []
}
```

From the repository root, run the importer using the environment with AstraPath-X's Python dependencies.

```powershell
python -m astrapath.tsokar path\to\tsokar-import.json --output data\tsokar
```

Use a new output directory when revising a study, and point `ASTRAPATH_TSOKAR_DIR` at that directory before launching the dashboard. The default location is `data/tsokar`. Open **Real ISRO Dataset Mode → Load existing window**. X increases east and Y increases south. The displayed routing window is at most 105 × 85 cells at 30 m posting. For a partial import, change X/Y to a window with data. The app reports valid DEM coverage for the study rectangle and blocks NoData on the routing window.

## Outputs and scientific scope

- `raw/` preserves original inputs. `manifest.json` lists the declared catalogue identity, dates and versions, terms, source raster metadata, SHA-256 hashes, DEM coverage, and imagery overlap with the DEM. Recognized sensing dates in source tags or metadata are checked against the declared imagery date. It records technical validation and user-supplied provenance. Sign-in and a catalogue record are the means of establishing source authenticity.
- `elevation.tif`, `slope.tif`, and `hazards.tif` are compressed rasters cropped to the study extent on a 30 m UTM Zone 44N grid. `imagery.tif` is an optional registered, contrast-stretched RGBA display product on the same grid. Imagery retains the acquisition date in the manifest and does not enter the route calculations.
- The app routes on windowed DEM values using the slope, energy, return and sunlight models. The saved hazard raster uses a default 19° cutoff. The app recomputes its active hazard layer at the selected maximum slope. Simulated solar azimuth uses grid north and relief within the current routing window. Battery and terrain uncertainty results are simulations. Water and protected-area boundaries are not automatic exclusions. Keep the exercise virtual and review the imagery and maps when selecting cells.
- No actual Tso Kar CartoDEM or 2025 scene has been acquired for this checkout. The tests use only generated raster fixtures, visibly separate from the default synthetic demo and official data.
