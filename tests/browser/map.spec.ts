import { test, expect } from "@playwright/test";
test.use({hasTouch:true});
for (const width of [1440,1024,390,320]) {
 test(`map selection, exact polygon export and scrolling at ${width}px`, async ({page})=>{
  await page.setViewportSize({width,height:900});
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto('/research');await page.getByRole('button',{name:'Open demonstration workspace'}).click();
  await page.getByRole('button',{name:'Expand map',exact:true}).click();
  const map=page.getByTestId('earth-canvas');
  await expect(map.locator('canvas')).toBeVisible();
  const pick = (position:{x:number,y:number}) => width < 600 ? map.tap({position}) : map.click({position});
  await page.getByRole('button',{name:'Select location',exact:true}).click();
  await pick({x:width*.45,y:180});
  await expect(page.locator('.map-workspace__header strong')).toContainText('Selected location');
  // A fresh camera fit settles before drawing the polygon.
  await page.waitForTimeout(1200);
  await page.getByRole('button',{name:'Draw polygon',exact:true}).click();
  await pick({x:width*.30,y:100});
  await pick({x:width*.60,y:120});
  await pick({x:width*.45,y:260});
  await expect(page.getByRole('button',{name:'Finish polygon'})).toBeEnabled();
  await page.getByRole('button',{name:'Undo',exact:true}).click();
  await expect(page.getByRole('button',{name:'Finish polygon'})).toBeDisabled();
  await pick({x:width*.45,y:260});
  await page.getByRole('button',{name:'Finish polygon'}).click();
  await expect(page.locator('.map-workspace__header strong')).toContainText('Drawn polygon · 3 corners');
  await page.locator('.map-workspace__footer summary').click();
  const downloadPromise=page.waitForEvent('download');
  await page.getByRole('button',{name:'Export selection',exact:true}).click();
  const download=await downloadPromise;const stream=await download.createReadStream();
  let content='';for await(const chunk of stream!) content+=chunk.toString();
  const feature=JSON.parse(content);
  expect(feature.geometry.coordinates[0]).toHaveLength(4);
  expect(feature.geometry.coordinates[0][0]).toEqual(feature.geometry.coordinates[0][3]);
  await page.getByRole('button',{name:'Close expanded map',exact:true}).click();
  await page.getByRole('button',{name:'Draw polygon',exact:true}).click();
  await page.getByRole('button',{name:'Cancel',exact:true}).click();
  await expect(page.locator('.map-workspace__header strong')).toContainText('Drawn polygon');
  await page.locator('.research-calculators').scrollIntoViewIfNeeded();
  const dimensions=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth,y:scrollY}));
  expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.width+1);
  expect(dimensions.y).toBeGreaterThan(0);
  await page.screenshot({path:`../../work/map-${width}.png`,fullPage:false});
  expect(errors).toEqual([]);
 });
}
