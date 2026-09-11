import { useEffect, useRef, useState } from "react";
import {
  Cartesian2,
  Cartesian3,
  Cartographic,
  Color,
  ColorMaterialProperty,
  ConstantProperty,
  GoogleMaps,
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
import { Crosshair, Layers3, Satellite } from "lucide-react";
import type { AreaOfInterest, CatalogScene } from "../lib/types";

type CesiumGlobeProps = {
  variant?: "landing" | "workspace";
  aoi?: AreaOfInterest;
  scenes?: CatalogScene[];
  photoRealistic?: boolean;
  onPhotoRealisticChange?: (value: boolean) => void;
  onAoiChange?: (aoi: AreaOfInterest) => void;
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
}: CesiumGlobeProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<Viewer | null>(null);
  const onAoiChangeRef = useRef(onAoiChange);
  const [webglReady, setWebglReady] = useState(true);
  const [viewerReady, setViewerReady] = useState(0);
  const canUseGoogleTiles = Boolean(googleMapsKey);
  const latestScene = scenes[0];

  useEffect(() => {
    onAoiChangeRef.current = onAoiChange;
  }, [onAoiChange]);

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

        if (variant === "landing") {
          viewer.camera.setView({ destination: Cartesian3.fromDegrees(78.38, 17.39, 15_000_000) });
        } else {
          const [longitude, latitude] = centreOf(aoi);
          viewer.camera.setView({
            destination: Cartesian3.fromDegrees(longitude, latitude, 300_000),
            orientation: {
              heading: CesiumMath.toRadians(24),
              pitch: CesiumMath.toRadians(-75),
              roll: 0,
            },
          });
          pointerHandler = new ScreenSpaceEventHandler(viewer.scene.canvas);
          pointerHandler.setInputAction((event: { position: Cartesian2 }) => {
            const cartesian = viewer?.camera.pickEllipsoid(event.position, viewer.scene.globe.ellipsoid);
            if (!cartesian || !viewer) return;
            const coordinate = Cartographic.fromCartesian(cartesian);
            const longitude = CesiumMath.toDegrees(coordinate.longitude);
            const latitude = CesiumMath.toDegrees(coordinate.latitude);
            const halfSide = 0.035;
            onAoiChangeRef.current?.({
              name: `Selected AOI · ${latitude.toFixed(3)}°, ${longitude.toFixed(3)}°`,
              bbox: [longitude - halfSide, latitude - halfSide, longitude + halfSide, latitude + halfSide],
              source: "map",
            });
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

  if (variant === "landing") {
    return <div className="planet-stage" aria-label="Earth view"><div className="planet-stage__canvas" ref={containerRef} /></div>;
  }

  return (
    <section className="globe-panel" aria-label="Earth observation map">
      <div className="globe-panel__toolbar">
        <div className="map-source">
          <span className="map-source__eyebrow">Area of interest</span>
          <strong>{aoi.name}</strong>
          <small>{aoi.source === "map" ? "Map-selected boundary" : "Preset operating area"}</small>
        </div>
        <div className="globe-panel__actions">
          <span className="map-metadata"><Satellite size={14} /> {formatAcquisition(latestScene)}</span>
          <button type="button" className="map-action" title="Select an area of interest on the globe">
            <Crosshair size={15} /> Select on map
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
      {webglReady ? <div className="cesium-host" ref={containerRef} /> : (
        <div className="globe-fallback"><strong>3D map unavailable</strong><span>WebGL is required for the Earth view.</span></div>
      )}
      <div className="globe-panel__legend">
        <span><i className="legend-dot legend-dot--aoi" /> Selected AOI</span>
        <span><i className="legend-dot legend-dot--base" /> Context basemap</span>
        <span className="globe-panel__notice">Analytical evidence is sourced separately from the public catalogue.</span>
      </div>
    </section>
  );
}
