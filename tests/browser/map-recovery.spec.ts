import { test, expect } from '@playwright/test';

test('base map has compact provider attribution and no ion branding or requests', async ({page})=>{
 const ionRequests:string[]=[];
 page.on('request',request=>{if(/https:\/\/[^/]*cesium\.com\//.test(request.url())) ionRequests.push(request.url());});
 await page.goto('/research');
 await page.getByRole('button',{name:'Open demonstration workspace'}).click();
 const map=page.getByTestId('earth-canvas');
 await expect(map.locator('canvas')).toBeVisible();
 await expect(map.getByRole('link',{name:'© OpenStreetMap contributors'})).toBeVisible();
 await expect(map.locator('.cesium-credit-logoContainer img')).toHaveCount(0);
 await expect(page.getByText('3D map unavailable',{exact:true})).toHaveCount(0);
 expect(ionRequests).toEqual([]);
});

test('unavailable Google 3D leaves base globe and location selection working',async({page})=>{
 await page.route('https://tile.googleapis.com/**',route=>route.fulfill({status:403,contentType:'application/json',body:JSON.stringify({error:{message:'Test: key not authorized'}})}));
 await page.goto('/');
 await page.getByRole('button',{name:'Open demonstration workspace'}).click();
 const toggle=page.getByRole('button',{name:'Toggle 3D context'});
 await toggle.click();
 await expect(page.getByRole('alert')).toContainText('The base globe is still available');
 await expect(toggle).toHaveAttribute('aria-pressed','false');
 await expect(page.getByTestId('earth-canvas').locator('canvas')).toBeVisible();
 await expect(page.getByRole('button',{name:'Retry map'})).toHaveCount(0);
 await page.locator('.map-workspace__footer summary').click();
 await page.getByLabel('Latitude, longitude',{exact:true}).fill('16.50, 80.62');
 await page.getByRole('button',{name:'Go to coordinates'}).click();
 await expect(page.locator('.map-workspace__header strong')).toContainText('16.50000, 80.62000');
});

test('map initialization failure recovers without duplicate canvases or lost selection',async({page})=>{
 await page.goto('/');
 await page.getByRole('button',{name:'Open demonstration workspace'}).waitFor();
 await page.evaluate(()=>{
  const original=HTMLCanvasElement.prototype.getContext;
  (window as unknown as {restoreTestContext:()=>void}).restoreTestContext=()=>{HTMLCanvasElement.prototype.getContext=original;};
  HTMLCanvasElement.prototype.getContext=function(type:string,...args:unknown[]) {
   if(type.includes('webgl')) return null;
   return Reflect.apply(original,this,[type,...args]);
  } as typeof original;
 });
 await page.getByRole('button',{name:'Open demonstration workspace'}).click();
 await expect(page.getByRole('alert')).toContainText('The map could not start');
 await page.locator('.map-workspace__footer summary').click();
 await page.getByLabel('Latitude, longitude',{exact:true}).fill('16.50, 80.62');
 await page.getByRole('button',{name:'Go to coordinates'}).click();
 await page.evaluate(()=>(window as unknown as {restoreTestContext:()=>void}).restoreTestContext());
 await page.getByRole('button',{name:'Retry map'}).click();
 await expect(page.getByTestId('earth-canvas').locator('canvas')).toBeVisible();
 await expect(page.getByTestId('earth-canvas').locator('canvas')).toHaveCount(1);
 await expect(page.getByRole('button',{name:'Retry map'})).toHaveCount(0);
 await expect(page.locator('.map-workspace__header strong')).toContainText('16.50000, 80.62000');
});

test('a lost graphics context can be retried with the same AOI',async({page})=>{
 await page.goto('/');
 await page.getByRole('button',{name:'Open demonstration workspace'}).click();
 const canvas=page.getByTestId('earth-canvas').locator('canvas');
 await expect(canvas).toBeVisible();
 const name=await page.locator('.map-workspace__header strong').textContent();
 await canvas.evaluate(node=>{
  const gl=(node as HTMLCanvasElement).getContext('webgl2');
  const loss=gl?.getExtension('WEBGL_lose_context');
  if(!loss) throw new Error('Context-loss simulation must be supported by the test browser');
  loss.loseContext();
 });
 await expect(page.getByRole('button',{name:'Retry map'})).toBeVisible();
 await page.getByRole('button',{name:'Retry map'}).click();
 await expect(canvas).toHaveCount(1);
 await expect(canvas).toBeVisible();
 await expect(page.getByRole('button',{name:'Retry map'})).toHaveCount(0);
 await expect(page.locator('.map-workspace__header strong')).toHaveText(name!);
});
