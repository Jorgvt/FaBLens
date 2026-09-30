// Small, bounded per-tab cache; reuses results only for almost identical crops.
const cardSessions=new Map();
export function frameCache(key,context,width,height,now=Date.now()){
 if(!key)return {entries:[]};
 const signature=JSON.stringify([context.enabled,context.axis,context.slots,context.epoch,width,height]);
 let cache=cardSessions.get(key);
 if(!cache||cache.signature!==signature)cache={signature,entries:[]};
 cardSessions.delete(key);cardSessions.set(key,cache);
 while(cardSessions.size>4)cardSessions.delete(cardSessions.keys().next().value);
 // Positive entries are checked against CURRENT pixels on every frame.
 // Only negative results expire on a clock. No periodic mass reset.
 cache.entries=cache.entries.filter(e=>e.result?.presence||now-e.at<4000);return cache;
}
let sigCanvas;
export function cropSignature(image,box){
 const c=sigCanvas||(sigCanvas=new OffscreenCanvas(48,48)),ctx=c.getContext('2d',{willReadFrequently:true});
 ctx.drawImage(image,box.x,box.y,box.w,box.h,0,0,48,48);return ctx.getImageData(0,0,48,48).data;
}
export function sameCrop(a,b){
 if(!a||a.length!==b.length)return false;
 let sum=0,changed=0;
 for(let i=0;i<a.length;i++){if(i%4===3)continue;const d=Math.abs(a[i]-b[i]);if(d>12)return false;sum+=d;if(d>4)changed++;}
 return sum/(a.length*.75)<=.7&&changed/(a.length*.75)<=.01;
}
export function cachedCard(cache,box,pixels,overlap,image=null){
 return cache.entries.find(e=>{
  const match=overlap(e.box,box);
  if(match>=.98&&sameCrop(e.pixels,pixels))return true;
  // Detector coordinates can jitter while the physical card stays still.
  // Recheck the original fixed crop instead of comparing shifted pixels.
  return image&&match>=.80&&sameCrop(e.pixels,cropSignature(image,e.box));
 });
}
