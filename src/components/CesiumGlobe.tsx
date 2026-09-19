import { useEffect, useRef, useState } from "react";
import {
  CameraEventType,
  Cartesian2,
  Cartesian3,
  Cartographic,
  Color,
  ColorMaterialProperty,
  ConstantProperty,
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
import { Crosshair, Home, Layers3, Minus, Plus, Satellite } from "lucide-react";
import type { AreaOfInterest, CatalogScene } from "../lib/types";
import type { MapLayer } from "../services/research";

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
const cesiumToken = import.meta.env.VITE_CESIUM_ION_TOKEN;
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
  const [west, south, east, north] = aoi.bbox;
  return [west, south, east, south, east, north, west, north, west, south];
}

function aoiKey(aoi: AreaOfInterest) {
  return `${aoi.name}:${aoi.bbox.join(",")}`;
}

function clamp(value: number, lower: number, upper: number) {
  return Math.max(lower, Math.min(upper, value));
}

function pointAoi(latitude: number, longitude: number): AreaOfInterest {
  // Roughly 7.8 km across at the equator: small enough for a focused inquiry
  // while still being a valid, queryable STAC bounding box.
  const halfSide = 0.035;
  return {
    name: `Globe selection · ${latitude.toFixed(4)}°, ${longitude.toFixed(4)}°`,
    bbox: [
      clamp(longitude - halfSide, -180, 180),
      clamp(latitude - halfSide, -89.95, 89.95),
      clamp(longitude + halfSide, -180, 180),
      clamp(latitude + halfSide, -89.95, 89.95),
    ],
    source: "map",
  };
}

function cameraHeightFor(aoi: AreaOfInterest) {
  const [west, south, east, north] = aoi.bbox;
  const widestSide = Math.max(Math.abs(east - west), Math.abs(north - south), 0.03);
  return Math.min(1_600_000, Math.max(40_000, widestSide * 111_000 * 3.2));
}

function cameraViewFor(aoi: AreaOfInterest) {
  const [longitude, latitude] = centreOf(aoi);
  return {
    destination: Cartesian3.fromDegrees(longitude, latitude, cameraHeightFor(aoi)),
    orientation: {
      heading: CesiumMath.toRadians(14),
      pitch: CesiumMath.toRadians(-72),
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

function formatAcquisition(scene?: CatalogScene) {
  if (!scene) return "No acquisition selected";
  const date = new Date(scene.datetime);
  return Number.isNaN(date.valueOf())
    ? scene.datetime
    : new Intl.DateTimeFormat("en-GB", {
        day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "UTC", timeZoneName: "short",
      }).format(date);
}

export function CesiumGlobe({
  variant = "workspace",
  aoi = fallbackAoi,
  scenes = [],
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
  const selectionModeRef = useRef(false);
  const lastAoiKeyRef = useRef<string | null>(null);
  const [webglReady, setWebglReady] = useState(true);
  const [viewerReady, setViewerReady] = useState(0);
  const [selectionMode, setSelectionMode] = useState(false);
  const [layerError, setLayerError] = useState<string | null>(null);
  const canUseGoogleTiles = Boolean(googleMapsKey);
  const latestScene = scenes[0];

  useEffect(() => {
    onAoiChangeRef.current = onAoiChange;
  }, [onAoiChange]);

  useEffect(() => {
    aoiRef.current = aoi;
  }, [aoi]);

  useEffect(() => {
    selectionModeRef.current = selectionMode;
    const canvas = viewerRef.current?.scene.canvas;
    if (canvas) canvas.style.cursor = selectionMode ? "crosshair" : "grab";
  }, [selectionMode, viewerReady]);

  useEffect(() => {
    if (!containerRef.current) return;
    let cancelled = false;
    let viewer: Viewer | null = null;
    let pointerHandler: ScreenSpaceEventHandler | null = null;

    async function initialise() {
      try {
        if (cesiumToken) Ion.defaultAccessToken = cesiumToken;
        viewer = new Viewer(containerRef.current!, {
          baseLayer: new ImageryLayer(new OpenStreetMapImageryProvider({ url: "https://tile.openstreetmap.org/" })),
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
        });
        if (cancelled) return;
        viewerRef.current = viewer;
        setViewerReady((value) => value + 1);
        viewer.scene.backgroundColor = Color.BLACK;
        viewer.scene.globe.enableLighting = variant === "workspace";
        viewer.scene.globe.baseColor = Color.fromCssColorString("#1b3850");
        viewer.scene.globe.depthTestAgainstTerrain = false;
        viewer.scene.fog.enabled = variant === "workspace";
        if (viewer.scene.skyAtmosphere) viewer.scene.skyAtmosphere.show = true;

        const controller = viewer.scene.screenSpaceCameraController;
        controller.enableCollisionDetection = true;
        controller.minimumZoomDistance = 500;
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
          pointerHandler = new ScreenSpaceEventHandler(viewer.scene.canvas);
          pointerHandler.setInputAction((event: { position: Cartesian2 }) => {
            if (!selectionModeRef.current) return;
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
            onAoiChangeRef.current?.(pointAoi(latitude, longitude));
            selectionModeRef.current = false;
            setSelectionMode(false);
          }, ScreenSpaceEventType.LEFT_CLICK);
        }

        if (photoRealistic && googleMapsKey && variant === "workspace") {
          GoogleMaps.defaultApiKey = googleMapsKey;
          const tileset = await createGooglePhotorealistic3DTileset(
            { key: googleMapsKey },
            { showCreditsOnScreen: true },
          );
          if (!cancelled) viewer.scene.primitives.add(tileset);
        }
      } catch {
        if (!cancelled) setWebglReady(false);
      }
    }

    void initialise();
    return () => {
      cancelled = true;
      pointerHandler?.destroy();
      if (viewer && !viewer.isDestroyed()) viewer.destroy();
      viewerRef.current = null;
    };
  }, [variant, photoRealistic]);

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
    const distance = Math.max(1_000, viewer.camera.positionCartographic.height * 0.28);
    if (direction === "in") viewer.camera.zoomIn(distance);
    else viewer.camera.zoomOut(distance);
  };

  return (
    <section className="globe-panel" aria-label="Earth observation map">
      <div className="globe-panel__toolbar">
        <div className="map-source">
          <span className="map-source__eyebrow">Area of interest</span>
          <strong>{aoi.name}</strong>
          <small>{aoi.source === "map" ? "Globe-selected analysis cell" : "Preset operating area"}</small>
        </div>
        <div className="globe-panel__actions">
          <span className="map-metadata"><Satellite size={14} /> {formatAcquisition(latestScene)}</span>
          <button
            type="button"
            className={`map-action ${selectionMode ? "is-active" : ""}`}
            onClick={() => setSelectionMode((active) => !active)}
            aria-pressed={selectionMode}
            title="Click anywhere on the globe to create a focused analysis area"
          >
            <Crosshair size={15} /> {selectionMode ? "Click globe to set AOI" : "Select on globe"}
          </button>
          <button type="button" className="map-action" onClick={resetView} title="Return to the selected area" aria-label="Reset map view">
            <Home size={15} /> Reset view
          </button>
          <button type="button" className="map-action" onClick={() => zoom("in")} title="Zoom in" aria-label="Zoom in">
            <Plus size={15} />
          </button>
          <button type="button" className="map-action" onClick={() => zoom("out")} title="Zoom out" aria-label="Zoom out">
            <Minus size={15} />
          </button>
          <button
            type="button"
            className={`map-action ${photoRealistic ? "is-active" : ""}`}
            onClick={() => onPhotoRealisticChange?.(!photoRealistic)}
            disabled={!canUseGoogleTiles}
            title={canUseGoogleTiles ? "Toggle licensed Google 3D context" : "Add a restricted Google Maps key to enable 3D context"}
          >
            <Layers3 size={15} /> {canUseGoogleTiles ? "3D context" : "3D context unavailable"}
          </button>
        </div>
      </div>
      {selectionMode && <p className="globe-panel__selection-hint" role="status">Click the globe to create a focused analysis cell around that location.</p>}
      {layerError && <p className="globe-panel__selection-hint" role="status">{layerError}</p>}
      {webglReady ? <div className="cesium-host" ref={containerRef} /> : (
        <div className="globe-fallback"><strong>3D map unavailable</strong><span>WebGL is required for the Earth view.</span></div>
      )}
    </section>
  );
}
