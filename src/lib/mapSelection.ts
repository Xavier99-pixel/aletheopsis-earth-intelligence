import type { AreaOfInterest } from "./types";
export type MapPoint = [number, number];
const cross = (a: MapPoint, b: MapPoint, c: MapPoint) => (b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);
function intersects(a:MapPoint,b:MapPoint,c:MapPoint,d:MapPoint) {
  const on = (p:MapPoint,q:MapPoint,r:MapPoint) => Math.abs(cross(p,q,r))<1e-12 && r[0]>=Math.min(p[0],q[0])-1e-12 && r[0]<=Math.max(p[0],q[0])+1e-12 && r[1]>=Math.min(p[1],q[1])-1e-12 && r[1]<=Math.max(p[1],q[1])+1e-12;
  return cross(a,b,c)*cross(a,b,d)<0 && cross(c,d,a)*cross(c,d,b)<0 || on(a,b,c)||on(a,b,d)||on(c,d,a)||on(c,d,b);
}
export function polygonAoi(points:MapPoint[]):AreaOfInterest {
  if(points.length<3) throw new Error("Add at least three corners.");
  if(points.length>200) throw new Error("Use at most 200 corners.");
  if(points.some(p=>!p.every(Number.isFinite)||p[0]<-180||p[0]>180||p[1]<-80||p[1]>84)) throw new Error("Select an area between 80°S and 84°N.");
  const xs=points.map(p=>p[0]), ys=points.map(p=>p[1]);
  const bbox:AreaOfInterest["bbox"]=[Math.min(...xs),Math.min(...ys),Math.max(...xs),Math.max(...ys)];
  if(bbox[2]-bbox[0]>.8 || bbox[3]-bbox[1]>.8) throw new Error("Zoom in: research areas must be smaller than 0.8° per side.");
  for(let i=0;i<points.length;i++) {
    const next=(i+1)%points.length;
    if(Math.hypot(points[i][0]-points[next][0],points[i][1]-points[next][1])<1e-7) throw new Error("Corners are too close together.");
    for(let j=i+1;j<points.length;j++) {
      if(j===next || (j+1)%points.length===i) continue;
      if(intersects(points[i],points[next],points[j],points[(j+1)%points.length])) throw new Error("Edges cannot cross or touch. Undo a corner and try again.");
    }
  }
  const area=Math.abs(points.reduce((sum,p,i)=>sum+cross(points[0],p,points[(i+1)%points.length]),0))/2;
  if(area<1e-9) throw new Error("The polygon is too small or its corners form a line.");
  return {name:`Drawn polygon · ${points.length} corners`,bbox,source:"map",geometry:{type:"Polygon",coordinates:[[...points,points[0]]]}};
}
export function locationAoi(lat:number,lon:number,halfWidthM=1000):AreaOfInterest {
  if(!Number.isFinite(lat)||!Number.isFinite(lon)||lat<-79.9||lat>83.9||lon<-179.9||lon>179.9) throw new Error("Use a local location between 79.9°S and 83.9°N, away from the date line.");
  const dy=halfWidthM/111320, dx=dy/Math.cos(lat*Math.PI/180);
  return {name:`Selected location · ${lat.toFixed(5)}, ${lon.toFixed(5)}`,bbox:[lon-dx,lat-dy,lon+dx,lat+dy],source:"map"};
}
