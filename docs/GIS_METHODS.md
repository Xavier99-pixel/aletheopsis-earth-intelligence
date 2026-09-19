# Aletheopsis: scientific methods and evidence boundaries

The research workspace adds deterministic calculations to the existing catalogue, atmospheric and conversation features. A language model does not supply measurement values. The application records inputs, formulas, units, source identifiers, CRS, limitations and downloadable results.

## Executable workflow

1. Select a local area and two dates, and enter a question.
2. The rule-based planner maps the request to approved functions. It does not generate or execute code. Form dates and the selected AOI are authoritative; place/date mentions in free text do not override them.
3. Choose actual Sentinel-2 processing, uploaded dated GeoJSON water polygons, or an explicitly synthetic example.
4. A bounded background job acquires/validates inputs, computes geometry, and writes a result ledger.
5. Inspect the Cesium layers, numerical calculation inputs, acquisition dates, coverage, source assets and limitations. Export report JSON, metric CSV or combined GeoJSON.

The current satellite route compares **two acquisitions**, not every image between Date A and Date B. Upload up to twelve dated polygons for a longer observed series. Change uses consecutive supplied dates. The original catalogue/weather/conversation workspace remains separately available.

## Horizontal measurement

Inputs are two-dimensional GeoJSON in EPSG:4326, with longitude first. The geometry engine validates topology and limits the AOI to a 100 km span. It selects WGS84 UTM from the AOI centroid; Krishna/Vijayawada uses EPSG:32644. Calculations are local projected grid measurements, not cadastral survey certification.

Polygon area uses the shoelace relation, retaining holes:

`A_ring = |Σ(xᵢ yᵢ₊₁ − xᵢ₊₁ yᵢ)| / 2`

`A_water = Σ(outer_ring_area − hole_areas)`

Line length uses `L = Σ √((xᵢ₊₁−xᵢ)² + (yᵢ₊₁−yᵢ)²)`.

The calculation ledger includes per-polygon outer/hole/net areas and retained boundary-component lengths, together with layer references. GeoJSON exports preserve geometry for independent recalculation. `1 ha = 10,000 m²`, `1 km² = 1,000,000 m²`, `1 km = 1,000 m`.

For government parcel proximity, PostGIS geography computes spheroidal metre distances with `ST_DWithin` and `ST_Distance`. Parcel overlay areas use each parcel's local UTM CRS. See [PostGIS distance](https://postgis.net/docs/ST_DWithin.html) and [area](https://postgis.net/docs/ST_Area.html).

## Sentinel-2 pixel processing

The server queries the public CDSE STAC catalogue in an explicit ±0–30 day window around each requested date. It selects the nearest available acquisition day, records the actual date, and calls the authenticated Sentinel Hub Process API for that day. A catalogue scene is not itself a water measurement. If the bounded catalogue response is truncated, the evidence records that limitation; this is not an exhaustive archive search.

The fixed evalscript requests B03, B08, B11, SCL and dataMask, plus an index into provider tile metadata. It picks the first clear valid sample in the provider's least-cloud ordering. The output has a common projected raster grid. Pixel size is at least 20 m, increasing to bound the longest raster dimension to approximately 512 pixels. All bands use nearest-neighbour resampling; coarse B11/SCL information is never described as new 10 m detail. Harmonized reflectance handles provider processing-baseline differences.

- `NDWI = (B03 − B08) / (B03 + B08)`
- `MNDWI = (B03 − B11) / (B03 + B11)`
- Mask nodata, nonfinite/negative reflectance, zero denominators, and SCL classes other than 4, 5, 6, 7. This deliberately conservative mask excludes dark/topographic-shadow class 2 and may omit some real water.
- Require at least 50% usable AOI coverage and 100 valid pixels. An all-cloud observation is unavailable, never “zero water”.
- Use Otsu's maximum between-class histogram variance to derive the MNDWI threshold. Uniform/nonseparable histograms are rejected rather than assigned an invented threshold.
- Remove components smaller than four pixels. Select the component containing an explicitly supplied river seed, or otherwise the largest four-connected component. This needs visual review; the largest waterbody is not guaranteed to be the named river.
- Compute NDWI separately as a diagnostic cross-check. Its agreement fraction is **not classification accuracy or an AI probability**.
- Vectorize the selected water and valid-coverage masks. Retain source TIFF, classified mask TIFF, metadata JSON and SHA-256 hashes. Mask values are 0 = valid non-selected-water, 1 = selected water, 255 = invalid; 0 can include other unselected water components.

The raster area ledger is `selected_water_pixel_count × pixel_area_m²`. Boundary pixels use centre inclusion; vector polygons are additionally clipped to the exact AOI, so the two areas can differ slightly. Contributing Process API tile identifiers are kept separately from catalogue candidate identifiers.

References: [Copernicus Sentinel-2 band/quality definitions](https://documentation.dataspace.copernicus.eu/APIs/SentinelHub/Data/S2L2A.html), [source metadata in evalscripts](https://documentation.dataspace.copernicus.eu/APIs/SentinelHub/UserGuides/Metadata.html), [multi-response TIFF/JSON requests](https://documentation.dataspace.copernicus.eu/notebook-samples/sentinelhub/getting_started/data_download_process_request.html).

**Not executed:** Sentinel-1 independent classification/verification, machine-learned water segmentation, or field validation. No confidence score is fabricated. Optical processing can fail because of clouds, shadows, vegetation, turbidity, small channels or unavailable credentials; it does not silently claim to switch to SAR.

## River geometry and temporal change

The output is **observed water-edge length**, including island edges and excluding artificial AOI/nodata closure edges within a documented 0.1 m computational clipping tolerance. That tolerance removes numeric clipping artefacts; it is not an estimate of image accuracy. The engine does not call the entire polygon perimeter one shoreline or automatically assign left/right morphological banks.

If a simple centreline is supplied, its length is measured and perpendicular transects are sampled at the configured spacing. `wᵢ = length(transectᵢ ∩ water)`. The result is summed wetted width across all intersected channels, not bankfull width. Sections clipped by the AOI/valid-coverage boundary are excluded from the mean. Centreline orientation and representativeness require review; automatic centreline/left-right-bank extraction is not implemented.

For consecutive observations, intersect their valid-coverage footprints before computing:

- `newly_mapped_water = (W₂ − W₁) ∩ common_valid_coverage`
- `formerly_mapped_water = (W₁ − W₂) ∩ common_valid_coverage`
- `ΔA = A_gain − A_loss`

If uploaded polygons omit `valid_geometry`, full AOI coverage is assumed. The upload author must supply the cloud/nodata coverage polygon when coverage is incomplete. These are water-footprint changes, not automatically erosion/accretion: season, discharge, stage and reservoir operations may move the observed waterline.

The explicit-input rate calculator accepts dated **signed positions on the same stable transect**:

- `NSM = position_latest − position_earliest`
- `EPR = NSM / elapsed_years`, with a year defined as 365.2425 days.
- `LRR = Σ((t−t̄)(d−d̄)) / Σ((t−t̄)²)`.
- LRR's 95% slope interval uses Student's t for at least three observations, under independent homoscedastic residual assumptions.
- Supplied endpoint positional uncertainties propagate by root-sum-square. That result is not automatically a 95% interval.

These are DSAS-style calculations, not an execution of USGS DSAS. Stable baselines and corresponding bank intersections are supplied, not inferred from polygon area. References: [USGS DSAS v6](https://www.usgs.gov/data/digital-shoreline-analysis-system-version-6), [USGS rate/uncertainty definitions](https://cmgds.marine.usgs.gov/catalog/whcmsc/SB_data_release/DR_P9DHOFXU/VA_rates_ST.faq.html).

## Volume calculators

The river dashboard leaves channel volume unavailable when it has only 2D boundaries. Expand **Scientific calculators** for calculations from actual measurements or clearly labelled teaching inputs:

1. **Cross-sections:** `V = Σ [(Aᵢ + Aᵢ₊₁)/2] × (sᵢ₊₁ − sᵢ)`. Chainages must increase; wet cross-sectional areas must describe one compatible water-level condition. Linear area variation between sections is an assumption.
2. **Depth integration:** `dᵢ = max(WSEᵢ − bedᵢ, 0)`; `V = Σ(dᵢ × cell_area)`. Inputs must share grid and vertical datum. A caller-supplied connected-domain mask is accepted, but the calculator does not solve connectivity or flow. Overwater surface DEM values are not valid substitutes for bathymetry.
3. **DEM of difference:** `Δz = z_after − z_before`, `LoD = k√(σ_before² + σ_after²)`. Sum cells with `|Δz| > LoD`. This assumes co-registration, a shared vertical datum and independent approximately Gaussian errors. Deposition/erosion volumes here concern measured terrain change, not river water storage.

References: [HEC-RAS terrain requirements](https://www.hec.usace.army.mil/confluence/rasdocs/rmum/6.6/terrain-layer), [surveyed channel terrain](https://www.hec.usace.army.mil/confluence/rasdocs/hgt/latest/guides/export-channel-data-for-terrain).

## Flood screening, exposure and forecasts

The 500 m, 1 km, 2 km/custom layers buffer the latest retained water edges, exclude mapped water, and are clipped to valid AOI coverage. They are **distance screening zones**. They contain no depth, probability, arrival time, hydraulic connectivity or legal setback determination.

The explicit-input API has a geometric exposure calculator for supplied polygons, lines and points: intersect each asset with a sourced observed-water, screening or modelled-inundation polygon. Counts refer to intersecting assets, not damage or casualties. Population raster exposure is not implemented.

Actual flood forecasts need gauge/rainfall/release inputs, surveyed channel geometry, terrain, roughness, structures and upstream/downstream boundary conditions, a calibrated hydraulic solver, and independent validation. The deployed code does not include HEC-RAS execution or a trained forecast model. These capabilities return unavailable in `/api/analysis/capabilities` and are never depicted as working forecasts.

Future ML training must use chronological validation and report held-out events, MAE/RMSE, stage/peak timing errors and uncertainty. Satellite extent validation should report IoU, precision, recall and F1. References: [USACE hydraulic boundary conditions](https://www.hec.usace.army.mil/confluence/rasdocs/r2dum/latest/boundary-and-initial-conditions-for-2d-flow-areas), [time-series validation](https://scikit-learn.org/stable/modules/generated/sklearn.model_selection.TimeSeriesSplit.html).

## Land status and news

The government monitor separates geometric proximity, active authorization records and imported observed built footprints. Missing records mean “requires officer verification”; imagery never proves illegality. See [GOVERNMENT.md](GOVERNMENT.md). An arbitrary 500 m query is not a jurisdiction-specific statutory rule. [DILRMP's official description](https://dilrmp.gov.in/userProfile/about-us) explains the distinction between record integration and conclusive title.

News uses fixed-provider GDELT article discovery, source URLs, publisher classification and provider-seen time. Seen time is not invented publication time. Place-name text matches have no verified geometry, so they are not placed on the map. Official PIB/IMD/CWC/NRSC/NDMA portals are presented as reference links, separately from retrieved articles. Outages, empty results and actual articles have distinct states.
