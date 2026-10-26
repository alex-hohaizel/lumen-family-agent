import {gunzipSync} from 'node:zlib';
import sharp from 'sharp';

// Bounded vector-only Lottie reader. No scripts, external images, URLs or fonts.
function mix(a:any,b:any,t:number):any{if(typeof a==='number'&&typeof b==='number')return a+(b-a)*t;if(Array.isArray(a)&&Array.isArray(b))return a.map((x,i)=>mix(x,b[i],t));if(a&&b&&typeof a==='object')return Object.fromEntries(Object.keys(a).map(k=>[k,mix(a[k],b[k],t)]));return a;}
function value(p:any,f:number,fallback:any){if(p===undefined)return fallback;const k=p.k??p;if(!Array.isArray(k)||!k.length||typeof k[0]!=='object'||!('t' in k[0]))return k;let a=k[0],b=k.at(-1);for(let i=0;i<k.length;i++){if(k[i].t<=f)a=k[i];if(k[i].t>f){b=k[i];break;}}const start=a.s?.[0]?.v?a.s[0]:a.s;const endValue=a.e??b.s??start;const end=Array.isArray(endValue)&&endValue[0]?.v?endValue[0]:endValue;return a.h===1?start:mix(start,end,Math.max(0,Math.min(1,(f-a.t)/Math.max(1,b.t-a.t))));}
function number(p:any,f:number,d=0){const v=value(p,f,d);return Number(Array.isArray(v)?v[0]:v)||0;}
function safe(v:any){const n=Number(v);return Number.isFinite(n)?Math.max(-100000,Math.min(100000,n)):0;}
function point(v:any):[number,number]{return Array.isArray(v)?[safe(v[0]),safe(v[1])]:[0,0];}
function transform(p:any,f:number){const pos=p?.p?.s?[number(p.p.x,f),number(p.p.y,f)]:point(value(p?.p,f,[0,0]));const a=point(value(p?.a,f,[0,0])),s=point(value(p?.s,f,[100,100]));return `translate(${pos?.[0]||0} ${pos?.[1]||0}) rotate(${number(p?.r??p?.rz,f)}) scale(${(s?.[0]??100)/100} ${(s?.[1]??100)/100}) translate(${-Number(a?.[0]||0)} ${-Number(a?.[1]||0)})`;}
function color(v:any){return '#'+(Array.isArray(v)?v:[0,0,0]).slice(0,3).map(x=>Math.round(Math.max(0,Math.min(1,Number(x)))*255).toString(16).padStart(2,'0')).join('');}
function path(shape:any){if(!shape?.v?.length||shape.v.length>5000)return '';const v=shape.v.map(point);let d=`M${v[0][0]},${v[0][1]}`;const end=shape.c?v.length:v.length-1;for(let i=0;i<end;i++){const j=(i+1)%v.length,a=point(shape.o?.[i]),b=point(shape.i?.[j]);d+=` C${v[i][0]+a[0]},${v[i][1]+a[1]} ${v[j][0]+b[0]},${v[j][1]+b[1]} ${v[j][0]},${v[j][1]}`;}return d+(shape.c?' Z':'');}
function shapes(items:any[],f:number,depth=0):string{
  if(depth>12||!Array.isArray(items)||items.length>2000)return '';
  const fill=items.find(x=>x.ty==='fl'&&!x.hd),stroke=items.find(x=>x.ty==='st'&&!x.hd),tr=items.find(x=>x.ty==='tr');
  const style=`fill="${fill?color(value(fill.c,f,[0,0,0])):'none'}" fill-opacity="${fill?number(fill.o,f,100)/100:1}" stroke="${stroke?color(value(stroke.c,f,[0,0,0])):'none'}" stroke-width="${stroke?number(stroke.w,f,1):0}" stroke-linecap="round" stroke-linejoin="round"`;
  let body='';for(const x of items){if(x.hd)continue;if(x.ty==='gr')body+=shapes(x.it,f,depth+1);if(x.ty==='sh'){const d=path(value(x.ks,f,{}));if(d)body+=`<path d="${d}" ${style}/>`;}if(x.ty==='el'){const p=point(value(x.p,f,[0,0])),s=point(value(x.s,f,[0,0]));body+=`<ellipse cx="${p[0]}" cy="${p[1]}" rx="${Math.abs(s[0])/2}" ry="${Math.abs(s[1])/2}" ${style}/>`;}if(x.ty==='rc'){const p=point(value(x.p,f,[0,0])),s=point(value(x.s,f,[0,0]));body+=`<rect x="${p[0]-s[0]/2}" y="${p[1]-s[1]/2}" width="${Math.max(0,s[0])}" height="${Math.max(0,s[1])}" rx="${number(x.r,f)}" ${style}/>`;}}
  return `<g transform="${transform(tr,f)}" opacity="${tr?number(tr.o,f,100)/100:1}">${body}</g>`;
}
export async function renderTGS(bytes:Buffer){
  const parsed=JSON.parse(gunzipSync(bytes,{maxOutputLength:2*1024*1024}).toString('utf8'));const layers=parsed.layers;
  if(!Array.isArray(layers)||layers.length>500||JSON.stringify(parsed).length>2000000)throw Error('vector_too_large');
  const check=(x:any):void=>{if(!x||typeof x!=='object')return;if(x.masksProperties?.length||x.ef?.length||x.tt||['gf','gs','tm','rp','mm','pb','zz'].includes(x.ty)||[1,2,5].includes(x.ty))throw Error('vector_feature_unsupported');for(const v of Object.values(x))if(Array.isArray(v))v.forEach(check);else if(v&&typeof v==='object')check(v);};
  check(parsed);
  const assets=new Map((parsed.assets || []).map((a:any)=>[a.id,a]));
  const render=(ls:any[],f:number,depth=0):string=>depth>8?'':ls.slice().reverse().map(l=>{
    if(l.hd||f<(l.ip??0)||f>=(l.op??Infinity))return '';
    const local=(f-(l.st||0))/(l.sr||1);let body=l.ty===4?shapes(l.shapes,local):l.ty===0?render((assets.get(l.refId) as any)?.layers || [],local,depth+1):'';
    if(!body)return '';let parent=l.parent!==undefined?ls.find(x=>x.ind===l.parent):undefined;let tr=transform(l.ks,local),count=0;while(parent&&count++<12){tr=transform(parent.ks,local)+' '+tr;parent=parent.parent!==undefined?ls.find(x=>x.ind===parent.parent):undefined;}
    return `<g transform="${tr}" opacity="${number(l.ks?.o,local,100)/100}">${body}</g>`;
  }).join('');
  const start=Number(parsed.ip||0),end=Number(parsed.op||60);const result:Buffer[]=[];
  for(const t of [0,.45,.85]){const body=render(layers,start+(end-start)*t);if(!body||body.length>3000000)throw Error('vector_not_renderable');const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 ${Number(parsed.w)||512} ${Number(parsed.h)||512}">${body}</svg>`;result.push(await sharp(Buffer.from(svg),{limitInputPixels:20000000}).png().toBuffer());}
  return result;
}
