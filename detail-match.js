// Independent 32x32 art validation: tonal layout plus signed local edges.
// Search small translations/scales, preserving one common alignment for both signals.
// Catalogue scans only: no video screenshot is used as a recognition reference.
export function detailFeature(raw){
  const out=new Float32Array(1024);let mean=0;
  const at=(x,y)=>raw[(y<0?-y:y>31?62-y:y)*32+(x<0?-x:x>31?62-x:x)];
  for(let y=0;y<32;y++)for(let x=0;x<32;x++){
    let sum=0;for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++)sum+=at(x+dx,y+dy)*(dx===0?2:1)*(dy===0?2:1);
    out[y*32+x]=sum/16;mean+=sum/16;
  }
  mean/=1024;let norm=0;for(let i=0;i<1024;i++){out[i]-=mean;norm+=out[i]**2;}
  norm=Math.sqrt(norm)||1;for(let i=0;i<1024;i++)out[i]/=norm;
  return out;
}
export function detailEdges(f){
 const out=new Float32Array(2048);let norm=0;
 for(let y=1;y<31;y++)for(let x=1;x<31;x++){
  const i=y*32+x,gx=f[i+1]-f[i-1],gy=f[i+32]-f[i-32];out[i]=gx;out[1024+i]=gy;norm+=gx*gx+gy*gy;
 }
 norm=Math.sqrt(norm)||1;for(let i=0;i<out.length;i++)out[i]/=norm;return out;
}
export function detailCoarse(feature){
  const out=new Float32Array(64);let norm=0;
  for(let y=0;y<8;y++)for(let x=0;x<8;x++){
    let sum=0;for(let dy=0;dy<4;dy++)for(let dx=0;dx<4;dx++)sum+=feature[(y*4+dy)*32+x*4+dx];
    out[y*8+x]=sum;norm+=sum*sum;
  }
  norm=Math.sqrt(norm)||1;for(let i=0;i<64;i++)out[i]/=norm;return out;
}
export function buildDetailSearch(raw,references,cards){
  const numRefs=references.length;
  if(raw.length!==numRefs*1024)throw Error('Detailed art index incomplete');
  const features=new Float32Array(numRefs*1024),coarse=new Float32Array(numRefs*64),edges=new Int8Array(numRefs*2048);
  const temp=new Float32Array(1024);
  for(let index=0;index<numRefs;index++){
    const rawOffset=index*1024,featOffset=index*1024,edgeOffset=index*2048,coarseOffset=index*64;
    for(let y=0;y<32;y++){
      const row=rawOffset+y*32,trow=y*32;
      temp[trow]=(raw[row]*2+raw[row+1]*2)*.25;
      for(let x=1;x<31;x++)temp[trow+x]=(raw[row+x-1]+raw[row+x]*2+raw[row+x+1])*.25;
      temp[trow+31]=(raw[row+31]*2+raw[row+30]*2)*.25;
    }
    let sum=0;
    for(let x=0;x<32;x++){
      const v0=(temp[x]*2+temp[32+x]*2)*.25;features[featOffset+x]=v0;sum+=v0;
      for(let y=1;y<31;y++){const vy=(temp[(y-1)*32+x]+temp[y*32+x]*2+temp[(y+1)*32+x])*.25;features[featOffset+y*32+x]=vy;sum+=vy;}
      const v31=(temp[31*32+x]*2+temp[30*32+x]*2)*.25;features[featOffset+31*32+x]=v31;sum+=v31;
    }
    const mean=sum/1024;let norm=0;
    for(let i=0;i<1024;i++){const v=features[featOffset+i]-mean;features[featOffset+i]=v;norm+=v*v;}
    norm=Math.sqrt(norm)||1;const invNorm=1/norm;
    for(let i=0;i<1024;i++)features[featOffset+i]*=invNorm;
    let edgeNorm=0;
    for(let y=1;y<31;y++){
      const row=featOffset+y*32;
      for(let x=1;x<31;x++){const i=row+x,gx=features[i+1]-features[i-1],gy=features[i+32]-features[i-32];edgeNorm+=gx*gx+gy*gy;}
    }
    edgeNorm=Math.sqrt(edgeNorm)||1;const invEdgeNorm=256/edgeNorm;
    for(let y=1;y<31;y++){
      const fRow=featOffset+y*32,eRow=edgeOffset+y*32;
      for(let x=1;x<31;x++){
        const fi=fRow+x,gx=(features[fi+1]-features[fi-1])*invEdgeNorm,gy=(features[fi+32]-features[fi-32])*invEdgeNorm;
        edges[eRow+x]=Math.max(-127,Math.min(127,Math.round(gx)));
        edges[eRow+1024+x]=Math.max(-127,Math.min(127,Math.round(gy)));
      }
    }
    let coarseNorm=0;
    for(let cy=0;cy<8;cy++)for(let cx=0;cx<8;cx++){
      let csum=0;
      for(let dy=0;dy<4;dy++){const fRow=featOffset+(cy*4+dy)*32+cx*4;csum+=features[fRow]+features[fRow+1]+features[fRow+2]+features[fRow+3];}
      coarse[coarseOffset+cy*8+cx]=csum;coarseNorm+=csum*csum;
    }
    coarseNorm=Math.sqrt(coarseNorm)||1;const invCoarseNorm=1/coarseNorm;
    for(let i=0;i<64;i++)coarse[coarseOffset+i]*=invCoarseNorm;
  }
  return {features,coarse,edges,references,cards};
}
export function samplePatchBilinear(gray,W,H,dx=0,dy=0,scale=1,targetSize=32){
  const sx0=(.5-.43*scale+dx)*W,sy0=(.375-.235*scale+dy)*H;
  const sw=.86*scale*W,sh=.47*scale*H;
  const stepX=sw/targetSize,stepY=sh/targetSize;
  const out=new Float32Array(targetSize*targetSize);
  for(let y=0;y<targetSize;y++){
    const srcY=sy0+(y+.5)*stepY-.5;
    const y0=Math.floor(srcY),y1=y0+1,fy=srcY-y0;
    const clY0=Math.max(0,Math.min(H-1,y0)),clY1=Math.max(0,Math.min(H-1,y1));
    const row0=clY0*W,row1=clY1*W;
    for(let x=0;x<targetSize;x++){
      const srcX=sx0+(x+.5)*stepX-.5;
      const x0=Math.floor(srcX),x1=x0+1,fx=srcX-x0;
      const clX0=Math.max(0,Math.min(W-1,x0)),clX1=Math.max(0,Math.min(W-1,x1));
      const v00=gray[row0+clX0],v01=gray[row0+clX1];
      const v10=gray[row1+clX0],v11=gray[row1+clX1];
      const v0=v00+fx*(v01-v00),v1=v10+fx*(v11-v10);
      out[y*targetSize+x]=v0+fy*(v1-v0);
    }
  }
  return out;
}
export function detailedCandidates(image,box,support){
  const matches=new Map();
  // Avoid matching sideways text areas to art. Keep both plausible upright directions.
  for(const rotation of (box.w>box.h?[1,3]:[0,2])){
    const upright=new OffscreenCanvas(256,256),ctx=upright.getContext('2d',{willReadFrequently:true});
    ctx.translate(128,128);ctx.rotate(rotation*Math.PI/2);
    ctx.drawImage(image,box.x,box.y,box.w,box.h,-128,-128,256,256);
    const rgba=ctx.getImageData(0,0,256,256).data,gray=new Float32Array(256*256);
    for(let i=0;i<gray.length;i++)gray[i]=.299*rgba[4*i]+.587*rgba[4*i+1]+.114*rgba[4*i+2];
    const coarseQueries=[];
    for(const dx of [-.06,0,.06])for(const dy of [-.03,0,.03])coarseQueries.push(detailCoarse(detailFeature(samplePatchBilinear(gray,256,256,dx,dy,1,32))));
    const shortlist=[];let min=-Infinity,minIndex=0;
    for(let i=0;i<support.references.length;i++){
      let best=-Infinity;
      for(const q of coarseQueries){let score=0;for(let j=0;j<64;j++)score+=q[j]*support.coarse[i*64+j];if(score>best)best=score;}
      if(shortlist.length<40){shortlist.push({index:i,score:best});if(shortlist.length<40)continue;}
      else if(best>min)shortlist[minIndex]={index:i,score:best};else continue;
      min=Infinity;for(let k=0;k<shortlist.length;k++)if(shortlist[k].score<min){min=shortlist[k].score;minIndex=k;}
    }
    const queries=[];
    for(const scale of [.9,1,1.1])for(const dx of [-.06,-.03,0,.03,.06])for(const dy of [-.04,-.02,0,.02,.04]){
      const f=detailFeature(samplePatchBilinear(gray,256,256,dx,dy,scale,32));
      queries.push({f,e:detailEdges(f)});
    }
    for(const {index} of shortlist){
      let best=-Infinity,bestGray=0,bestEdge=0;
      for(const q of queries){let grayDot=0,edge=0;for(let j=0;j<1024;j++)grayDot+=q.f[j]*support.features[index*1024+j];for(let j=0;j<2048;j++)edge+=q.e[j]*support.edges[index*2048+j]/256;const score=.3*grayDot+.7*edge;if(score>best){best=score;bestGray=grayDot;bestEdge=edge;}}
      const card=support.cards[support.references[index]],prior=matches.get(card.name);
      if(!prior||best>prior.detailScore)matches.set(card.name,{name:card.name,image:card.large,pitch:card.pitch,detailScore:best,grayScore:bestGray,edgeScore:bestEdge,rotation});
    }
  }
  return [...matches.values()].sort((a,b)=>b.detailScore-a.detailScore).slice(0,8);
}
export function verifyDetailed(image,box,top,state,straight=null){
  if(!state.detail||!top.length)return null;
  // Strong neural or outline evidence remains the fast path.
  if(top[0].score>=.90&&top[0].score-(top[1]?.score??0)>=.15)return null;
  const views=straight?[straight,{image,box}]:[{image,box}],bestByName=new Map();
  for(const view of views)for(const card of detailedCandidates(view.image,view.box,state.detail)){
    const prior=bestByName.get(card.name);
    if(!prior||card.detailScore>prior.detailScore)bestByName.set(card.name,{...card,view});
  }
  const ranked=[...bestByName.values()].sort((a,b)=>b.detailScore-a.detailScore),best=ranked[0];
  if(state.debugDetail)state.debugDetail(ranked.map(({view,...card})=>card));
  // Both tonal layout and signed local edges must agree. These are similarity
  // thresholds, not probabilities. A strong conflict needs stronger verification.
  const conflict=top[0].name!==best?.name&&top[0].score>=.80;
  if(!best||best.grayScore<.65||best.edgeScore<.50||best.detailScore<(conflict ? .78 : .66)||best.detailScore-(ranked[1]?.detailScore??0)<.09)return null;
  const {view,...card}=best;
  return {top:[{...card,score:Math.max(top[0].score+.04,card.detailScore),evidence:'art-detail'},...top.filter(c=>c.name!==card.name)].slice(0,5),view};
}
