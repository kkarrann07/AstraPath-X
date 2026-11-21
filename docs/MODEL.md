# Mission model

## Terrain and paths

The reader checks for a single-band GeoTIFF with a source CRS, applies the band's scale and offset, and preserves its no-data mask. If the vertical unit is absent the reader assumes metres. A source window is reprojected to a local, north-up azimuthal equidistant grid with approximately native spacing using nearest-neighbor sampling. Elevations and the resulting horizontal row/column spacing feed the same solver used by Kestrel Basin.

For each cell, the hazard layer uses the largest absolute center-to-neighbor slope, `atan(|Δelevation| / horizontal distance)`. Missing and over-limit cells are excluded. Diagonal moves also require the two flanking cells to be traversable. Displayed route slope comes from the actual moves.

A* finds one path per objective, using eight-neighbor planar distances.

| Candidate | Cost per edge |
| --- | --- |
| Shortest | Horizontal distance |
| Safest | Distance multiplied by `1 + (slope degrees / 4)²` |
| Energy-efficient | Positive net electrical draw plus a small distance cost |

The cards are candidate comparisons. A steep tile can block all paths, and an energy or return constraint can reject some or all candidates. The solver considers these objective-specific paths and their modeled return trees. Other feasible paths can exist, especially when charging or waiting changes the best route.

## Power and shadow

Travel time is distance divided by configured level speed and multiplied by `1 + 0.7 × |grade|`. Traction is level-drive Wh/km times distance in km, multiplied by `1 + 3.5 × uphill grade + 0.6 × downhill grade magnitude`. An onboard load in watts is applied during movement and during explicit stationary waits. Coefficients express illustrative slope sensitivity and rolling resistance. No regenerative braking is modeled.

On a bundled lunar LOLA grid, the uphill and downhill terms are multiplied by the nominal Moon-to-Earth gravity ratio, 1.62/9.80. The configured level traction, speed and onboard power stay the same. Distances use the native metre spacing of the lunar polar stereographic grid. [Lunar grid provenance and assumptions](LUNAR.md)

The illumination solver samples grid heights toward a fixed sun azimuth and altitude. Higher cells can occlude the sun, missing cells are treated as potential obstructions, and the raster edge has no modeled terrain beyond it. Solar input is constant watts in illuminated cells and zero in shadow. Movement conservatively requires both endpoint cells to be illuminated. At zero altitude there is no illumination. Solar mode off keeps the shadow layer visible and removes power input from it.

For each edge, subtract traction and onboard energy and add simultaneous solar input. The battery is capped at capacity, and any projected fall below the mission floor rejects the candidate. The floor is the larger of the configured reserve and initial charge minus energy draw budget. This makes the budget a cap on instantaneous depletion relative to launch charge, including during surprises. The rejected route timeline is a diagnostic projection. Movement stops in the interactive simulation when no feasible route is available.

## Return and emergency decisions

Three reverse route trees model paths back to base under the same objectives. The charge required before each edge equals the larger of the mission floor and the next cell's required charge plus the current edge's net draw. A downstream requirement beyond capacity makes that return candidate infeasible. The smallest feasible threshold among the trees is used at each cell. For return-required missions, every outbound cell must preserve modeled return capability, including at the target.

The Point of No Return is the first cell where outbound charge is below this modeled threshold. It can be temporary with later illumination. With the return requirement off, simulation pauses one cell before crossing and can resume. Battery loss applies a percentage of current charge. The planner checks target and base candidates from the current cell and recommends **CONTINUE** if the modeled target mission is feasible, otherwise **RETURN** if a modeled path reaches base, otherwise **STOP/HOLD**. A hold estimate describes stationary power for the next ten minutes or time to depletion within that window.

## Uncertainty

The app adds independent zero-mean Gaussian elevation errors with user-selected standard deviation to valid cells. Twenty trials with seed 2026 recompute terrain restrictions and shadows, then test the original outbound paths. Return paths can adapt in the trials when a return is required. Counts are scenario sensitivity under modeled assumptions. The model does not represent spatially correlated error, physical rover calibration, lunar ephemerides, thermal constraints, or sub-pixel obstacles.
