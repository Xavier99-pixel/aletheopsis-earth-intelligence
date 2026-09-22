import { useEffect, useRef, useState } from "react";
import {
  CameraEventType,
  Cartesian2,
  Cartesian3,
  Cartographic,
  Color,
  ColorMaterialProperty,
  Cesium3DTileset,
  ConstantProperty,
  Credit,
  CreditDisplay,
  GoogleMaps,
  GeoJsonDataSource,
  ImageryLayer,
  Ion,
  LabelStyle,
  Math as CesiumMath,
  OpenStreetMapImageryProvider,
  ScreenSpaceEventHandler,
  ScreenSpaceEventType,
  VerticalOrigin,
  Viewer,
  createGooglePhotorealistic3DTileset,
} from "cesium";
import { Crosshair, Home, Layers3, Minus, Plus, Maximize2, Minimize2, Pentagon, Undo2, X, Check } from "lucide-react";
import type { AreaOfInterest, CatalogScene } from "../lib/types";
import { downloadContent, type MapLayer } from "../services/research";
import { LocationSearch } from "./LocationSearch";
import { polygonAoi, locationAoi, type MapPoint } from "../lib/mapSelection";
import "../styles/map.css";

type CesiumGlobeProps = {
  variant?: "landing" | "workspace";
  aoi?: AreaOfInterest;
  scenes?: CatalogScene[];
  photoRealistic?: boolean;
  onPhotoRealisticChange?: (value: boolean) => void;
  onAoiChange?: (aoi: AreaOfInterest) => void;
  analysisLayers?: MapLayer[];
  layerOpacity?: number;
};

const googleMapsKey = import.meta.env.VITE_GOOGLE_MAPS_API_KEY;
// This viewer uses local CesiumJS assets, OSM imagery and optional direct Google
// tiles, not ion services. Remove only the default logo via the public API.
// Provider credits remain visible; ion credits would be restored by Cesium if
// an ion-backed data source were added in the future.
CreditDisplay.cesiumCredit = new Credit("");
Ion.defaultAccessToken = "";
const osmCredit = new Credit('<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">&copy; OpenStreetMap contributors</a>', true);
const fallbackAoi: AreaOfInterest = {
  name: "Hyderabad Basin",
  bbox: [78.30, 17.32, 78.47, 17.49],
  source: "preset",
};

function centreOf(aoi: AreaOfInterest) {
  const [west, south, east, north] = aoi.bbox;
  return [(west + east) / 2, (south + north) / 2] as const;
}

function polygonDegrees(aoi: AreaOfInterest) {
  if (aoi.geometry) return aoi.geometry.coordinates[0].flat();
  const [west, south, east, north] = aoi.bbox;
  return [west, south, east, south, east, north, west, north, west, south];
}

function aoiKey(aoi: AreaOfInterest) {
  return JSON.stringify([aoi.name, aoi.bbox, aoi.geometry]);
}

function cameraHeightFor(aoi: AreaOfInterest) {
  const [west, south, east, north] = aoi.bbox;
  const widestSide = Math.max(Math.abs(east - west), Math.abs(north - south), 0.001);
  return Math.min(1_600_000, Math.max(600, widestSide * 111_000 * 2.2));
}

function cameraViewFor(aoi: AreaOfInterest) {
  const [longitude, latitude] = centreOf(aoi);
  return {
    destination: Cartesian3.fromDegrees(longitude, latitude, cameraHeightFor(aoi)),
    orientation: {
      heading: 0,
      pitch: CesiumMath.toRadians(-90),
      roll: 0,
    },
  };
}

function flyToAoi(viewer: Viewer, aoi: AreaOfInterest, duration = 0.85) {
  viewer.camera.cancelFlight();
  viewer.camera.flyTo({
    ...cameraViewFor(aoi),
    duration,
  });
}

export function CesiumGlobe({
  variant = "workspace",
  aoi = fallbackAoi,
  scenes: _scenes = [],
  photoRealistic = false,
  onPhotoRealisticChange,
  onAoiChange,
  analysisLayers,
  layerOpacity = 0.55,
}: CesiumGlobeProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<Viewer | null>(null);
  const onAoiChangeRef = useRef(onAoiChange);
  const aoiRef = useRef(aoi);
  const selectionModeRef = useRef<"browse" | "point" | "polygon">("browse");
  const lastAoiKeyRef = useRef<string | null>(null);
  const [mapError, setMapError] = useState<string | null>(null);
  const [mapRevision, setMapRevision] = useState(0);
  const [viewerReady, setViewerReady] = useState(0);
  const [selectionMode, setSelectionMode] = useState<"browse" | "point" | "polygon">("browse");
  const [vertices, setVertices] = useState<MapPoint[]>([]);
  const [selectionError, setSelectionError] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [coordinates, setCoordinates] = useState("");
  const [halfWidth, setHalfWidth] = useState(1000);
  const halfWidthRef = useRef(halfWidth);
  halfWidthRef.current = halfWidth;
  const [layerError, setLayerError] = useState<string | null>(null);
  const canUseGoogleTiles = Boolean(googleMapsKey);


  useEffect(() => {
    onAoiChangeRef.current = onAoiChange;
  }, [onAoiChange]);

  useEffect(() => {
    aoiRef.current = aoi;
  }, [aoi]);

  useEffect(() => {
    selectionModeRef.current = selectionMode;
    const canvas = viewerRef.current?.scene.canvas;
    if (canvas) canvas.style.cursor = selectionMode !== "browse" ? "crosshair" : "grab";
    const viewer = viewerRef.current;
    if (viewer) viewer.scene.screenSpaceCameraController.enableRotate = selectionMode !== "polygon";
  }, [selectionMode, viewerReady]);

  useEffect(() => {
    if (!containerRef.current) return;
    const host = containerRef.current;
    let cancelled = false;
    let viewer: Viewer | null = null;
    let pointerHandler: ScreenSpaceEventHandler | null = null;
    let removeRenderError: (() => void) | undefined;
    let canvas: HTMLCanvasElement | undefined;
    function contextLost(event: Event) {
      event.preventDefault();
      if (!cancelled) setMapError("The graphics connection was interrupted. Retry the map; your selected area is saved.");
    }
    function contextRestored() { if (!cancelled) setMapRevision(value => value + 1); }
    setMapError(null);

    async function initialise() {
      try {
        viewer = new Viewer(host, {
          baseLayer: new ImageryLayer(new OpenStreetMapImageryProvider({ url: "https://tile.openstreetmap.org/", credit: osmCredit })),
          showRenderLoopErrors: false,
          animation: false,
          baseLayerPicker: false,
          fullscreenButton: false,
          geocoder: false,
          homeButton: false,
          infoBox: false,
          navigationHelpButton: false,
          sceneModePicker: false,
          selectionIndicator: false,
          timeline: false,
          shouldAnimate: false,
          requestRenderMode: true,
          maximumRenderTimeChange: Number.POSITIVE_INFINITY,
        });
        if (cancelled) return;
        viewerRef.current = viewer;
        canvas = viewer.scene.canvas;
        canvas.addEventListener("webglcontextlost", contextLost);
        canvas.addEventListener("webglcontextrestored", contextRestored);
        removeRenderError = viewer.scene.renderError.addEventListener(() => {
          if (!cancelled) setMapError("Map rendering paused. Retry to restore the view; place search and your selected area are preserved.");
        });
        viewer.scene.backgroundColor = Color.BLACK;
        viewer.scene.globe.enableLighting = false;
        viewer.scene.globe.baseColor = Color.fromCssColorString("#1b3850");
        viewer.scene.globe.depthTestAgainstTerrain = false;
        viewer.scene.fog.enabled = variant === "workspace";
        if (viewer.scene.skyAtmosphere) viewer.scene.skyAtmosphere.show = true;

        const controller = viewer.scene.screenSpaceCameraController;
        controller.enableCollisionDetection = true;
        controller.minimumZoomDistance = 25;
        controller.maximumZoomDistance = 22_000_000;
        controller.inertiaSpin = 0;
        controller.inertiaTranslate = 0;
        controller.inertiaZoom = 0;
        controller.enableTilt = false;
        controller.enableLook = false;
        controller.tiltEventTypes = undefined;
        controller.lookEventTypes = undefined;
        controller.rotateEventTypes = CameraEventType.LEFT_DRAG;
        controller.zoomEventTypes = [CameraEventType.WHEEL, CameraEventType.PINCH];
        controller.maximumTiltAngle = CesiumMath.toRadians(75);
        viewer.camera.constrainedAxis = Cartesian3.UNIT_Z;

        if (variant === "landing") {
          viewer.camera.setView({ destination: Cartesian3.fromDegrees(78.38, 17.39, 15_000_000) });
        } else {
          const initialAoi = aoiRef.current;
          viewer.camera.setView(cameraViewFor(initialAoi));
          lastAoiKeyRef.current = aoiKey(initialAoi);
          viewer.screenSpaceEventHandler.removeInputAction(ScreenSpaceEventType.LEFT_DOUBLE_CLICK);
          pointerHandler = new ScreenSpaceEventHandler(viewer.scene.canvas);
          pointerHandler.setInputAction((event: { position: Cartesian2 }) => {
            if (selectionModeRef.current === "browse") return;
            const ray = viewer?.camera.getPickRay(event.position);
            // Prefer the rendered globe surface so clicking over terrain stays
            // geographically stable; retain the ellipsoid as a safe fallback.
            const cartesian = ray && viewer
              ? viewer.scene.globe.pick(ray, viewer.scene) ?? viewer.camera.pickEllipsoid(event.position, viewer.scene.globe.ellipsoid)
              : undefined;
            if (!cartesian || !viewer) return;
            const coordinate = Cartographic.fromCartesian(cartesian);
            const longitude = CesiumMath.toDegrees(coordinate.longitude);
            const latitude = CesiumMath.toDegrees(coordinate.latitude);
            setSelectionError("");
            if (selectionModeRef.current === "polygon") {
              setVertices(points => points.length < 200 ? [...points, [longitude, latitude]] : points);
            } else {
              try {
                onAoiChangeRef.current?.(locationAoi(latitude, longitude, halfWidthRef.current));
                selectionModeRef.current = "browse";
                setSelectionMode("browse");
              } catch (error) { setSelectionError((error as Error).message); }
            }
          }, ScreenSpaceEventType.LEFT_CLICK);
        }

        setViewerReady((value) => value + 1);
      } catch {
        pointerHandler?.destroy(); pointerHandler = null;
        removeRenderError?.(); removeRenderError = undefined;
        canvas?.removeEventListener("webglcontextlost", contextLost);
        canvas?.removeEventListener("webglcontextrestored", contextRestored);
        if (viewer && !viewer.isDestroyed()) viewer.destroy();
        viewer = null; viewerRef.current = null;
        // A constructor that throws can leave canvas/credit nodes before a
        // Viewer instance exists to destroy. Keep retries free of stale nodes.
        host.replaceChildren();
        if (!cancelled) setMapError("The map could not start. Retry, or enable graphics acceleration in your browser. Place search and coordinates remain available.");
      }
    }

    void initialise();
    return () => {
      cancelled = true;
      pointerHandler?.destroy();
      removeRenderError?.();
      canvas?.removeEventListener("webglcontextlost", contextLost);
      canvas?.removeEventListener("webglcontextrestored", contextRestored);
      if (viewer && !viewer.isDestroyed()) viewer.destroy();
      viewerRef.current = null;
      host.replaceChildren();
    };
  }, [variant, mapRevision]);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || variant !== "workspace" || !photoRealistic || !googleMapsKey) return;
    let cancelled = false;
    let tiles: Cesium3DTileset | undefined;
    GoogleMaps.defaultApiKey = googleMapsKey;
    void createGooglePhotorealistic3DTileset({key: googleMapsKey}, {showCreditsOnScreen:true}).then(value => {
      if (cancelled || viewer.isDestroyed()) { value.destroy(); return; }
      tiles = value; viewer.scene.primitives.add(value);
    }).catch(() => {
      if (!cancelled) {
        setSelectionError("Google 3D context could not load. The base globe is still available. Check the Google Maps key, billing and allowed website in your provider settings.");
        onPhotoRealisticChange?.(false);
      }
    });
    return () => { cancelled = true; if (tiles && !viewer.isDestroyed()) viewer.scene.primitives.remove(tiles); };
  }, [viewerReady, variant, photoRealistic]);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || !containerRef.current) return;
    const observer = new ResizeObserver(() => { if (!viewer.isDestroyed()) { viewer.resize(); viewer.scene.requestRender(); } });
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, [viewerReady]);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    const draft = viewer.entities.values.filter(entity => entity.id.startsWith("draw-"));
    draft.forEach(entity => viewer.entities.remove(entity));
    vertices.forEach((point,i) => viewer.entities.add({id:`draw-${i}`, position:Cartesian3.fromDegrees(...point),
      point:{pixelSize:11,color:Color.YELLOW,outlineColor:Color.BLACK,outlineWidth:2,disableDepthTestDistance:Number.POSITIVE_INFINITY}}));
    if (vertices.length > 1) viewer.entities.add({id:"draw-line",polyline:{positions:Cartesian3.fromDegreesArray((vertices.length>2 ? [...vertices,vertices[0]]:vertices).flat()),width:3,material:Color.YELLOW}});
    viewer.scene.requestRender();
  }, [vertices, viewerReady]);

  useEffect(() => {
    function escape(event:KeyboardEvent) {
      if (event.key === "Escape") { setSelectionMode("browse"); setVertices([]); setExpanded(false); setSelectionError(""); }
    }
    window.addEventListener("keydown",escape);
    return () => window.removeEventListener("keydown",escape);
  }, []);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || variant !== "workspace") return;
    const nextAoiKey = aoiKey(aoi);
    if (lastAoiKeyRef.current === nextAoiKey) return;
    lastAoiKeyRef.current = nextAoiKey;
    flyToAoi(viewer, aoi);
  }, [aoi, variant, viewerReady]);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || variant !== "workspace") return;
    viewer.entities.removeById("selected-aoi");
    viewer.entities.add({
      id: "selected-aoi",
      name: aoi.name,
      polygon: {
        hierarchy: Cartesian3.fromDegreesArray(polygonDegrees(aoi)),
        material: new ColorMaterialProperty(Color.fromCssColorString("#E7B72A").withAlpha(0.16)),
        outline: true,
        outlineColor: new ConstantProperty(Color.fromCssColorString("#F6E8A6")),
        outlineWidth: new ConstantProperty(3),
      },
      label: {
        text: aoi.source === "map" ? "SELECTED AOI" : aoi.name.toUpperCase(),
        font: "600 12px system-ui",
        fillColor: Color.WHITE,
        outlineColor: Color.BLACK,
        outlineWidth: 4,
        style: LabelStyle.FILL_AND_OUTLINE,
        verticalOrigin: VerticalOrigin.BOTTOM,
        pixelOffset: new Cartesian2(0, -8),
      },
      point: {
        pixelSize: 8,
        color: Color.fromCssColorString("#E7B72A"),
        outlineColor: Color.fromCssColorString("#050505"),
        outlineWidth: 2,
      },
      position: Cartesian3.fromDegrees(...centreOf(aoi), 1),
    });
    viewer.scene.requestRender();
  }, [aoi, variant, viewerReady]);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || variant !== "workspace") return;
    let cancelled = false;
    const sources: GeoJsonDataSource[] = [];
    setLayerError(null);
    void (async () => {
      // Buffers draw first, with the observed water/edges visible above them.
      const ordered = [...(analysisLayers ?? [])].sort((a, b) => Number(!a.id.startsWith("proximity")) - Number(!b.id.startsWith("proximity")));
      for (const layer of ordered) {
        try {
          const colour = Color.fromCssColorString(layer.id.startsWith("proximity") ? "#f0c829" : layer.id.startsWith("lost") ? "#fa9b70" : layer.id.startsWith("gained") ? "#81d9a3" : layer.id.includes("edges") ? "#ffffff" : "#61c9ed");
          const source = await GeoJsonDataSource.load(layer.geojson, { fill: colour.withAlpha(layerOpacity), stroke: colour, strokeWidth: 2, clampToGround: false });
          if (cancelled || viewer.isDestroyed()) return;
          source.name = layer.label;
          await viewer.dataSources.add(source);
          if (cancelled || viewer.isDestroyed()) { if (!viewer.isDestroyed()) viewer.dataSources.remove(source, true); return; }
          sources.push(source);
        } catch {
          if (!cancelled) setLayerError("A result layer could not be displayed. Download its GeoJSON to inspect the geometry.");
        }
      }
      if (!cancelled && !viewer.isDestroyed()) viewer.scene.requestRender();
    })();
    return () => { cancelled = true; if (!viewer.isDestroyed()) sources.forEach(source => viewer.dataSources.remove(source, true)); };
  }, [analysisLayers, layerOpacity, variant, viewerReady]);

  if (variant === "landing") {
    return <div className="planet-stage" aria-label="Earth view"><div className="planet-stage__canvas" ref={containerRef} /></div>;
  }

  const resetView = () => {
    const viewer = viewerRef.current;
    if (viewer) flyToAoi(viewer, aoi, 0.55);
  };

  const zoom = (direction: "in" | "out") => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    viewer.camera.cancelFlight();
    const distance = Math.max(10, viewer.camera.positionCartographic.height * 0.28);
    if (direction === "in") viewer.camera.zoomIn(distance);
    else viewer.camera.zoomOut(distance);
  };

  function mode(next: "browse" | "point" | "polygon") {
    setSelectionError(""); setVertices([]); setSelectionMode(next);
    selectionModeRef.current = next;
  }
  function finishPolygon() {
    try { const selected = polygonAoi(vertices); onAoiChange?.(selected); mode("browse"); }
    catch(error) { setSelectionError((error as Error).message); }
  }
  function useCoordinates(event:React.FormEvent) {
    event.preventDefault();
    const parts = coordinates.split(",").map(value=>value.trim());
    try {
      if(parts.length!==2 || parts.some(value=>!value)) throw new Error("Enter latitude, longitude, for example 16.50, 80.62.");
      onAoiChange?.(locationAoi(Number(parts[0]), Number(parts[1]), halfWidth)); mode("browse");
    } catch(error) { setSelectionError((error as Error).message); }
  }
  return (
    <section className={`globe-panel map-workspace ${expanded ? "map-workspace--expanded" : ""}`} aria-label="Earth observation map">
      <div className="map-workspace__header">
        <div><span className="eyebrow">Explore Earth</span><strong title={aoi.name}>{aoi.name}</strong></div>
        <button type="button" className="map-action" onClick={()=>setExpanded(value=>!value)} aria-label={expanded ? "Close expanded map" : "Expand map"}>{expanded ? <Minimize2 size={17}/> : <Maximize2 size={17}/>}</button>
      </div>
      <div className="map-workspace__search"><LocationSearch label="Search the map" placeholder="City, river or place…" onSelect={value=>{onAoiChange?.(value);mode("browse");}} /></div>
      <div className="map-workspace__tools" role="group" aria-label="Map selection tools">
        <button className="map-action" aria-pressed={selectionMode==="browse"} onClick={()=>mode("browse")}>Explore</button>
        <button className="map-action" aria-pressed={selectionMode==="point"} onClick={()=>mode("point")}><Crosshair size={16}/> Select location</button>
        <button className="map-action" aria-pressed={selectionMode==="polygon"} onClick={()=>mode("polygon")}><Pentagon size={16}/> Draw polygon</button>
      </div>
      <div className="map-workspace__viewport">
        <div className={`cesium-host ${mapError ? "cesium-host--paused" : ""}`} data-testid="earth-canvas" aria-hidden={Boolean(mapError)} ref={containerRef} />
        {mapError && <div className="map-recovery" role="alert"><strong>Restore map view</strong><p>{mapError}</p><button className="map-action" onClick={() => setMapRevision(value => value + 1)}>Retry map</button></div>}
        <div className="map-workspace__navigation" aria-label="Map navigation">
          <button className="map-action" onClick={resetView} aria-label="Reset map view" title="Fit selection · north up"><Home size={18}/></button>
          <button className="map-action" onClick={()=>zoom("in")} aria-label="Zoom in"><Plus size={18}/></button>
          <button className="map-action" onClick={()=>zoom("out")} aria-label="Zoom out"><Minus size={18}/></button>
          {canUseGoogleTiles && onPhotoRealisticChange && <button className="map-action" aria-label="Toggle 3D context" aria-pressed={photoRealistic} onClick={()=>onPhotoRealisticChange(!photoRealistic)}><Layers3 size={18}/></button>}
        </div>
        {!mapError && selectionMode!=="browse" && <div className="map-workspace__hint" role="status">{selectionMode==="polygon" ? `Tap corners on the map · ${vertices.length}/200 corners` : "Tap a location to select a square study area."}</div>}
      </div>
      <div className="map-workspace__footer">
        {selectionMode==="polygon" ? <div className="map-workspace__draw-actions">
          <button className="map-action" onClick={()=>{setVertices(points=>points.slice(0,-1));setSelectionError("");}} disabled={!vertices.length}><Undo2 size={16}/> Undo</button>
          <button className="map-action" onClick={()=>mode("browse")}><X size={16}/> Cancel</button>
          <button className="map-action" onClick={finishPolygon} disabled={vertices.length<3}><Check size={16}/> Finish polygon</button>
        </div> : <details><summary>Coordinates &amp; selection</summary>
          <form onSubmit={useCoordinates} className="map-coordinate-form">
            <label>Latitude, longitude<input aria-label="Latitude, longitude" value={coordinates} onChange={event=>setCoordinates(event.target.value)} placeholder="16.50, 80.62" /></label>
            <label>Square half-width<select aria-label="Selection half-width" value={halfWidth} onChange={event=>setHalfWidth(Number(event.target.value))}><option value={500}>500 m</option><option value={1000}>1 km</option><option value={2000}>2 km</option><option value={5000}>5 km</option></select></label>
            <button className="map-action" type="submit">Go to coordinates</button>
          </form>
          <p>Lat {centreOf(aoi)[1].toFixed(5)}°, lon {centreOf(aoi)[0].toFixed(5)}° · {aoi.geometry ? "Exact polygon boundary" : "Bounding rectangle"}</p>
          <button className="map-action" onClick={()=>downloadContent("selected-area.geojson",JSON.stringify({type:"Feature",properties:{name:aoi.name},geometry:aoi.geometry ?? {type:"Polygon",coordinates:[Array.from({length:5},(_,i)=>polygonDegrees(aoi).slice(i*2,i*2+2))]}},null,2),"application/geo+json")}>Export selection</button>
        </details>}
        {selectionError && <p className="map-workspace__error" role="alert">{selectionError}</p>}
        {layerError && <p className="map-workspace__error" role="status">{layerError}</p>}
      </div>
    </section>
  );
}
