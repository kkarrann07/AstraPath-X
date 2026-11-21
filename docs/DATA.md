# Elevation data and provenance

## Obtain a CartoDEM tile near Leh, Ladakh

1. Open the [ISRO / NRSC Bhuvan Open Data Archive](https://bhuvan-app3.nrsc.gov.in/data/download/). Sign in with your own Bhuvan credentials when the portal asks for them. Review the terms shown for the product and download.
2. Choose **Satellite**, then **CartoDEM – 1 arc second**. In **Bounding Box** mode use west **77.45° E**, east **77.70° E**, south **34.05° N**, and north **34.27° N**. Alternatively, draw that area on the map.
3. Click **Next** to display the tile list. Use **View** and **Metadata** to identify a tile intersecting the area and record its tile ID, version, CRS, acquisition or processing dates if available, and no-data value.
4. Click **Download**. Extract the archive and locate the single-band elevation TIFF. Keep the metadata and license notices. The official CartoDEM brochure lists GeoTIFF and signed-short elevations. Verify the specific downloaded product with its metadata or `gdalinfo`. [Bhuvan's download steps](https://bhuvan-app3.nrsc.gov.in/data/download/help/source/html/steps_to_download_data.htm) · [CartoDEM product brochure](https://bhuvan-app3.nrsc.gov.in/data/download/tools/document/cartodem_bro_final.pdf)
5. To make a repeatable Leh demo, use QGIS **Raster → Extraction → Clip Raster by Extent** to clip the elevation layer to approximately **77.56°–77.60° E** and **34.15°–34.18° N**. Enter the extent in the correct CRS, retain native resolution and no-data metadata, and export as GeoTIFF. Upload the result at X/Y = 50% and choose traversable base and target cells. You can also upload the full TIFF and choose an X/Y window. X changes the crop position from left to right. Y changes it from top to bottom.
6. Credit the original data as **Cartosat-1 CartoDEM, NRSC / ISRO via Bhuvan** and include the selected version, tile ID, window extent, and any processing. Follow the applicable product terms when sharing a tile or derived material.

CartoDEM's approximately 30 m posting is useful for exploring terrain-scale routing. Ladakh is a terrestrial analogue, and terrain of this resolution cannot resolve rover-scale obstacles.

## Other official sources

- [ISRO Bhuvan](https://bhuvan.nrsc.gov.in/) hosts the NRSC geoportal. The archive above is the intended elevation source for this project.
- [ISRO Bhoonidhi](https://bhoonidhi.nrsc.gov.in/bhoonidhi/home.html) is an optional source for eligible satellite imagery. This app bundles no satellite imagery.
- [ISRO PRADAN](https://pradan.issdc.gov.in/) hosts Chandrayaan scientific products. The upload pipeline is designed for Earth-referenced data. Lunar DEM support would require a Moon-specific CRS, product ingestion and illumination assumptions.

## What the repository contains

The app bundles a deterministic generated elevation scenario named Kestrel Basin. Tests create georeferenced GeoTIFFs with known values to exercise the file format, coordinates, masks, and reprojection. No ISRO measurements, imagery or archive files are bundled.
