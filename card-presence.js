// Cheap card-presence gate. Current frame only; no catalogue scan or extra model.
export function plausibleCardBox(box,width,height){
 const {x,y,w,h}=box;
 return [x,y,w,h].every(Number.isFinite)&&w>=12&&h>=12&&Math.max(w/h,h/w)<=2.8&&w*h<=width*height*.45;
}
export function cardBoundary(image,box){
 const size=96,pad=.16,c=new OffscreenCanvas(size,size),ctx=c.getContext('2d',{willReadFrequently:true});
 ctx.drawImage(image,box.x-pad*box.w,box.y-pad*box.h,box.w*(1+2*pad),box.h*(1+2*pad),0,0,size,size);
 const rgba=ctx.getImageData(0,0,size,size).data,gray=new Float32Array(size*size);
 for(let i=0;i<gray.length;i++)gray[i]=.299*rgba[i*4]+.587*rgba[i*4+1]+.114*rgba[i*4+2];
 const edge=pad/(1+2*pad)*size,far=size-edge,at=(x,y)=>gray[Math.max(0,Math.min(95,Math.round(y)))*96+Math.max(0,Math.min(95,Math.round(x)))];
 const sides=[];
 for(let side=0;side<4;side++){
  let best=0;
  for(const offset of [-6,-3,0,3,6])for(const slope of [-.16,0,.16]){
   let hits=0;const origin=(side%2?far:edge)+offset;
   for(let t=0;t<40;t++){
    const along=edge+5+(far-edge-10)*t/39,normal=origin+slope*(along-48);
    const delta=side<2?Math.abs(at(normal-2,along)-at(normal+2,along)):Math.abs(at(along,normal-2)-at(along,normal+2));
    if(delta>=16)hits++;
   }
   best=Math.max(best,hits/40);
  }
  sides.push(best);
 }
 let sum=0,squares=0,n=0;
 for(let y=24;y<72;y++)for(let x=24;x<72;x++){const v=gray[y*96+x];sum+=v;squares+=v*v;n++;}
 const contrast=Math.sqrt(Math.max(0,squares/n-(sum/n)**2));
 return {sides,edges:sides.filter(s=>s>=.55).length,contrast};
}
export function keepCard(box,top,boundary){
 const c=top?.[0];if(!c)return false;
 const score=c.score||0,margin=score-(top[1]?.score??0),edges=boundary.edges;
 // Existing independently verified zones/detail/glare can retain an occluded
 // or foil card even when a die or glare interrupts the border.
 const local=c.evidence==='art-zones'||c.evidence==='art-detail'||c.evidence==='art-glare';
 if(local)return true;
 // Printed empty zones have a rectangle too, but almost no interior detail.
 if(boundary.contrast<9)return false;
 if(c.evidence==='art-outline'&&((c.artScore||0)>=1.5||edges>=1))return true;
 if(edges>=2&&score>=.50)return true;
 if(edges>=1&&score>=.65)return true;
 // Preserve strong visual/detector agreement when borders disappear.
 return score>=.82&&margin>=.06&&(box.detectScore||0)>=.70;
}

// A playmat illustration can have card-like art and proportions but be several
// times larger than the physical cards around it. Abstain on sparse scenes.
export function consistentCardSizes(boxes){
 const anchors=boxes.filter(b=>b.detectScore>=.60&&Math.max(b.w/b.h,b.h/b.w)<=2.2);
 if(anchors.length<5)return boxes;
 const median=values=>values.sort((a,b)=>a-b)[Math.floor(values.length/2)];
 const area=median(anchors.map(b=>b.w*b.h)),short=median(anchors.map(b=>Math.min(b.w,b.h))),long=median(anchors.map(b=>Math.max(b.w,b.h)));
 return boxes.filter(b=>!(b.w*b.h>area*3.5&&Math.min(b.w,b.h)>short*1.6&&Math.max(b.w,b.h)>long*1.6));
}
