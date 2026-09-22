import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { viteStaticCopy } from "vite-plugin-static-copy";

const cesiumSource = "node_modules/cesium/Build/Cesium";
const cesiumBaseUrl = "cesium";

export default defineConfig({
  plugins: [
    react(),
    viteStaticCopy({
      targets: [
        { src: `${cesiumSource}/ThirdParty`, dest: cesiumBaseUrl },
        { src: `${cesiumSource}/Workers`, dest: cesiumBaseUrl },
        { src: `${cesiumSource}/Assets`, dest: cesiumBaseUrl },
        { src: `${cesiumSource}/Widgets`, dest: cesiumBaseUrl },
        { src: "node_modules/cesium/LICENSE.md", dest: "licenses", rename: "CesiumJS-LICENSE.txt" }
      ]
    })
  ],
  define: {
    CESIUM_BASE_URL: JSON.stringify(`/${cesiumBaseUrl}`)
  },
  server: {
    host: "0.0.0.0"
  },
  preview: {
    host: "0.0.0.0",
    allowedHosts: [
      "aletheopsis-earth-intelligence.onrender.com"
    ]
  }
});
