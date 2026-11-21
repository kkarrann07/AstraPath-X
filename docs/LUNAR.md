# Lunar comparison data

## Globe

The bundled color texture is NASA Scientific Visualization Studio's December 2025 `lroc_color_2k.jpg` from the CGI Moon Kit, credited to NASA, Ernie Wright, LRO/LROC and LOLA. It is a 2048 × 1024 global equirectangular color mosaic centered on 0° longitude, assembled from multiple observations. December 2025 describes the mosaic release, and there is no single acquisition date. Texture pixel dimensions describe the display texture. The lighting is rendered for visibility and does not represent an epoch or measured solar exposure. [NASA CGI Moon Kit](https://svs.gsfc.nasa.gov/4720/) · [Original JPG](https://svs.gsfc.nasa.gov/vis/a000000/a004700/a004720/lroc_color_2k.jpg)

Texture SHA-256 is `f7130a1822681fa7512d7dcfd40db8c10b9ba4f06777910348698260ed7a2170`. NASA permits educational and informational reuse under its media guidelines and asks for attribution. Three.js 0.180.0 is vendored under its MIT license. Both the JavaScript and imagery are served locally. [NASA media guidelines](https://www.nasa.gov/nasa-brand-center/images-and-media/) · [Three.js license](../static/vendor/three-LICENSE.txt)

## Regional elevation

Both crops preserve the original float elevation samples and GeoTIFF transform. They use 5 m native pixel posting in south polar stereographic coordinates, Moon Mean Earth/Polar Axis (MOON_ME), JPL DE421. Heights in metres refer to the 1,737,400 m lunar reference sphere. Surface pixels between laser tracks are interpolated. Effective detail varies with sampling density, and slopes depend on DEM resolution. The source is a multi-pass, final adjusted/interpolated surface described by Barker et al. (2021). The NASA catalogue gives no single acquisition date. [NASA GSFC LOLA products](https://pgda.gsfc.nasa.gov/data/LOLA_5mpp/) · [NASA dataset README](https://pgda.gsfc.nasa.gov/data/LOLA_5mpp/README) · [Barker et al.](https://doi.org/10.1016/j.pss.2020.105119)

| Region | Crop center (planetocentric) | Source crop offset (column, row) | Area at 5 m grid posting |
|---|---|---|---|
| Site04, Shackleton rim | 89.808263° S, 146.754077° W | 1110, 1130 | 525 × 425 m |
| Site01, Connecting ridge | 89.457749° S, 133.952774° W | 1380, 1440 | 525 × 425 m |

To reproduce a crop, use the 105 × 85 window at the stated zero-based offset from the original GeoTIFF, retain its native samples, NoData marker, CRS and window affine, and set the band units to metres. The manifest has the exact source and packaged-file SHA-256 hashes. Apollo 11 and 15 use NASA's LRO-derived landing coordinates and are imagery-only in AstraPath-X. [Lunar crop manifest](../astrapath/lunar_data/manifest.json) · [NASA Apollo coordinates](https://nssdc.gsfc.nasa.gov/planetary/lunar/lunar_sites.html)

## Comparing and planning

The comparison uses the same steepest-neighbor slope function as route planning. Percentages count finite-slope cells above the selected threshold. Local relief is max minus min; absolute heights use different reference datums. Comparisons preserve each grid's native spacing. Ladakh offers an analogue for exploring terrain-driven trade-offs. Gravity, regolith, atmospheric conditions and illumination differ.

The simulator uses the nominal gravity ratio of 1.62/9.80 to scale the grade-dependent component of drive energy on the Moon. Level traction, speed, onboard power and solar assumptions remain configured model inputs. Sun azimuth is relative to grid north, and the terrain horizon is limited to each cropped window. Neither the model nor the interpolated satellite elevations certify rover-scale traversability or predict actual charging. [NASA Moon/Earth gravity values](https://nssdc.gsfc.nasa.gov/planetary/factsheet/moonfact.html)

Use the [Tso Kar import guide](TSO_KAR.md) to load CartoDEM through the Earth panel. Kestrel Basin is the labeled synthetic alternative for an installation without Tso Kar data.
