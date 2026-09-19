import { test, expect } from "@playwright/test";
import { resolve } from "node:path";

test("research example computes, exposes equations and exports its evidence", async ({page}) => {
  const errors:string[]=[]; page.on("pageerror",error=>errors.push(error.message));
  await page.goto("/research");
  await page.getByRole("button",{name:"Open demonstration workspace"}).click();
  await expect(page.getByRole("heading",{name:"From source to calculation."})).toBeVisible();
  await page.getByRole("button",{name:"Krishna / Vijayawada"}).click();
  await page.getByLabel("River Date B").fill("2024-10-01");
  await page.getByRole("button",{name:"Explore a labelled calculation example"}).click();
  await page.getByRole("button",{name:"Run scientific analysis"}).click();
  await expect(page.getByRole("heading",{name:"Calculation results"})).toBeVisible({timeout:30000});
  await expect(page.locator(".research-metric").filter({hasText:"Channel water volume"})).toContainText("Not available");
  await expect(page.locator(".research-metric").filter({hasText:"Predicted flood inundation area"})).toContainText("Not available");
  await expect(page.locator(".research-metric").first()).toContainText("EXAMPLE");
  await expect(page.locator(".calculation-detail")).toContainText("EPSG:32644");
  await expect(page.locator(".research-error")).toHaveCount(0);
  await page.getByRole("button",{name:"How was this calculated?"}).nth(1).click();
  await expect(page.locator(".calculation-detail")).toContainText("clip_tolerance_m");
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button",{name:"Report JSON"}).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/aletheopsis-.*\.json/);
  await page.getByRole("button",{name:"Source evidence",exact:true}).click();
  await expect(page.locator(".research-evidence")).toContainText("No satellite acquisition or source pixels were used");
  await page.getByRole("button",{name:"Calculation",exact:true}).click();
  await page.screenshot({path:resolve("../../work/research-desktop.png"),fullPage:true});
  expect(errors).toEqual([]);
});

test("government data remains protected in the public demo",async({page})=>{
  await page.goto("/admin");
  await page.getByRole("button",{name:"Open demonstration workspace"}).click();
  await expect(page.getByRole("heading",{name:"Verified government access"})).toBeVisible();
  await expect(page.getByRole("alert")).toContainText("administrator-provisioned");
  await expect(page.getByRole("button",{name:"Check corridor records"})).toHaveCount(0);
});

test("volume example is calculated and mobile layout stays within viewport",async({page})=>{
  await page.setViewportSize({width:390,height:844});
  await page.goto("/research");
  await page.getByRole("button",{name:"Open demonstration workspace"}).click();
  await page.locator(".research-calculators summary").click();
  await page.getByRole("button",{name:"Calculate from supplied inputs"}).click();
  await expect(page.locator(".research-calculators pre")).toContainText('"volume_m3": 6000');
  await expect(page.locator(".research-calculators pre")).toContainText('"evidence_level": "EXAMPLE"');
  const viewport = await page.evaluate(()=>({width:document.documentElement.clientWidth,scroll:document.documentElement.scrollWidth}));
  expect(viewport.scroll).toBeLessThanOrEqual(viewport.width+1);
  await page.screenshot({path:resolve("../../work/research-mobile.png"),fullPage:true});
});
