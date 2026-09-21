import { defineConfig } from "@playwright/test";
import { resolve } from "node:path";

export default defineConfig({
  testDir: "./tests/browser",
  fullyParallel: false,
  reporter: process.env.CI ? [["list"], ["github"]] : "list",
  workers: 1,
  // Hosted Linux runners render the full-size Cesium globe in software.
  timeout: process.env.CI ? 120000 : 60000,
  use: { baseURL: "http://127.0.0.1:4175", viewport: {width:1440,height:1000}, screenshot:"only-on-failure", trace:"retain-on-failure" },
  webServer: [
    {command:"backend/.venv/bin/uvicorn app.main:app --app-dir backend --host 127.0.0.1 --port 8005",url:"http://127.0.0.1:8005/api/health",reuseExistingServer:false,
      env:{ANALYSIS_DATA_DIR:resolve("../../work/browser-analysis"),ALLOWED_ORIGINS:"http://127.0.0.1:4175",SUPABASE_URL:"",SUPABASE_ANON_KEY:"",CDSE_CLIENT_ID:"",CDSE_CLIENT_SECRET:"",INTELLIGENCE_ALLOW_UNAUTHENTICATED:"false"}},
    {command:"npm run dev -- --host 127.0.0.1 --port 4175 --strictPort",url:"http://127.0.0.1:4175",reuseExistingServer:false,
      env:{VITE_BACKEND_BASE_URL:"http://127.0.0.1:8005",VITE_SUPABASE_URL:"",VITE_SUPABASE_ANON_KEY:""}}
  ],
});
