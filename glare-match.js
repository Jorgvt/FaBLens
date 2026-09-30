// Local illumination-invariant art checks. One reference, orientation and crop
// must explain spatially separated tiles in the CURRENT frame.
const GLARE_SIZE=32,GLARE_TILES=16,GLARE_DIMS=1024;
export function glareDescriptor(raw){
  const smooth=new Float32Array(1024),features=new Float32Array(1024),weights=new Float32Array(16);
  for(let y=0;y<32;y++)for(let x=0;x<32;x++){
    let sum=0;for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++)sum+=raw[Math.max(0,Math.min(31,y+dy))*32+Math.max(0,Math.min(31,x+dx))]*(dx===0?2:1)*(dy===0?2:1);
    smooth[y*32+x]=sum/16;
  }
  for(let ty=0;ty<4;ty++)for(let tx=0;tx<4;tx++){
    const tile=ty*4+tx,base=tile*64;let sum=0,sx=0,sy=0,bright=0;
    for(let y=0;y<8;y++)for(let x=0;x<8;x++){
      const at=(ty*8+y)*32+tx*8+x,v=smooth[at];sum+=v;sx+=(x-3.5)*v;sy+=(y-3.5)*v;if(raw[at]>=235)bright++;
    }
    // Subtract a fitted plane, removing slow brightness gradients without using color.
    const mean=sum/64,bx=sx/336,by=sy/336;let norm=0;
    for(let y=0;y<8;y++)for(let x=0;x<8;x++){
      const value=smooth[(ty*8+y)*32+tx*8+x]-mean-bx*(x-3.5)-by*(y-3.5);features[base+y*8+x]=value;norm+=value*value;
    }
    norm=Math.sqrt(norm);
    weights[tile]=norm<12?0:Math.max(.25,1-bright/64);
    if(norm>0)for(let j=0;j<64;j++)features[base+j]/=norm;
  }
  return {features,weights};
}
export function buildGlareSearch(raw,references,cards){
  const numRefs=references.length;
  if(raw.length!==numRefs*1024)throw Error('Glare art index incomplete');
  const bank=new Int8Array(numRefs*1024);
  const temp=new Float32Array(1024),smooth=new Float32Array(1024);
  for(let index=0;index<numRefs;index++){
    const rawOffset=index*1024,bankOffset=index*1024;
    for(let y=0;y<32;y++){
      const row=rawOffset+y*32,trow=y*32;
      temp[trow]=(raw[row]*3+raw[row+1])*.25;
      for(let x=1;x<31;x++)temp[trow+x]=(raw[row+x-1]+raw[row+x]*2+raw[row+x+1])*.25;
      temp[trow+31]=(raw[row+31]*3+raw[row+30])*.25;
    }
    for(let x=0;x<32;x++){
      const v0=(temp[x]*3+temp[32+x])*.25;smooth[x]=v0;
      for(let y=1;y<31;y++)smooth[y*32+x]=(temp[(y-1)*32+x]+temp[y*32+x]*2+temp[(y+1)*32+x])*.25;
      smooth[31*32+x]=(temp[31*32+x]*3+temp[30*32+x])*.25;
    }
    for(let ty=0;ty<4;ty++)for(let tx=0;tx<4;tx++){
      const tile=ty*4+tx,base=tile*64;let sum=0,sx=0,sy=0;
      for(let y=0;y<8;y++){
        const syPos=ty*8+y,yOff=syPos*32+tx*8,yWeight=y-3.5;
        for(let x=0;x<8;x++){const at=yOff+x,v=smooth[at];sum+=v;sx+=(x-3.5)*v;sy+=yWeight*v;}
      }
      const mean=sum/64,bx=sx/336,by=sy/336;let norm=0;
      for(let y=0;y<8;y++){
        const yOff=(ty*8+y)*32+tx*8,yTerm=mean+by*(y-3.5),tRow=base+y*8;
        for(let x=0;x<8;x++){const val=smooth[yOff+x]-yTerm-bx*(x-3.5);temp[tRow+x]=val;norm+=val*val;}
      }
      norm=Math.sqrt(norm);
      if(norm>0){
        const invNorm=127/norm;
        for(let j=0;j<64;j++)bank[bankOffset+base+j]=Math.round(temp[base+j]*invNorm);
      }else{
        for(let j=0;j<64;j++)bank[bankOffset+base+j]=0;
      }
    }
  }
  return {bank,references,cards};
}
function samplePatchBilinear(gray,W,H,dx=0,dy=0,scale=1,targetSize=32){
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
// Reused scratch: scoring is synchronous, never awaits or retains these arrays.
const glareBestScores=new Float64Array(10),glareBestTiles=new Int8Array(10);
export function glareScore(query,support,index){
  let count=0;
  for(let tile=0;tile<16;tile++){
    if(query.weights[tile]<.3)continue;
    let dot=0;const base=tile*64,ref=index*1024+base;
    for(let j=0;j<64;j++)dot+=query.features[base+j]*support.bank[ref+j]/127;
    let position=Math.min(count,10);
    while(position>0&&dot>glareBestScores[position-1])position--;
    if(position<10){
      for(let k=Math.min(count,9);k>position;k--){glareBestScores[k]=glareBestScores[k-1];glareBestTiles[k]=glareBestTiles[k-1];}
      glareBestScores[position]=dot;glareBestTiles[position]=tile;
    }
    count++;
  }
  if(count<10)return {score:0,minimum:0,spread:false};
  let sum=0,weight=0,q0=0,q1=0,q2=0,q3=0;
  for(let i=0;i<10;i++){
    const tile=glareBestTiles[i],w=query.weights[tile];sum+=glareBestScores[i]*w;weight+=w;
    const quadrant=Math.floor(tile/8)*2+Math.floor((tile%4)/2);
    if(quadrant===0)q0++;else if(quadrant===1)q1++;else if(quadrant===2)q2++;else q3++;
  }
  return {score:sum/(weight||1),minimum:glareBestScores[9],spread:q0>=2&&q1>=2&&q2>=2&&q3>=2};
}
export function glareCandidates(image,box,support){
  const names=new Map();
  for(const rotation of (box.w>box.h?[1,3]:[0,2])){
    const c=new OffscreenCanvas(256,256),ctx=c.getContext('2d',{willReadFrequently:true});
    ctx.translate(128,128);ctx.rotate(rotation*Math.PI/2);
    ctx.drawImage(image,box.x,box.y,box.w,box.h,-128,-128,256,256);
    const rgba=ctx.getImageData(0,0,256,256).data,gray=new Float32Array(256*256);
    for(let i=0;i<gray.length;i++)gray[i]=.299*rgba[4*i]+.587*rgba[4*i+1]+.114*rgba[4*i+2];
    const query=glareDescriptor(samplePatchBilinear(gray,256,256,0,0,1,32));
    const shortlist=[];let min=-Infinity,minIndex=0;
    for(let i=0;i<support.references.length;i++){
      const match=glareScore(query,support,i);
      if(shortlist.length<48){shortlist.push({index:i,score:match.score});if(shortlist.length<48)continue;}
      else if(match.score>min)shortlist[minIndex]={index:i,score:match.score};else continue;
      min=Infinity;for(let j=0;j<shortlist.length;j++)if(shortlist[j].score<min){min=shortlist[j].score;minIndex=j;}
    }
    const queries=[];for(const dx of [-.03,0,.03])for(const dy of [-.02,0,.02])queries.push(glareDescriptor(samplePatchBilinear(gray,256,256,dx,dy,1,32)));
    for(const {index} of shortlist){
      let best=null;for(const q of queries){const m=glareScore(q,support,index);if(m.spread&&m.minimum>=.40&&(!best||m.score>best.score))best=m;}
      if(!best)continue;
      const card=support.cards[support.references[index]],old=names.get(card.name);
      if(!old||best.score>old.glareScore)names.set(card.name,{name:card.name,image:card.large,pitch:card.pitch,rotation,glareScore:best.score,minimumTile:best.minimum});
    }
  }
  return [...names.values()].sort((a,b)=>b.glareScore-a.glareScore).slice(0,8);
}
export function verifyGlare(image,box,top,state,straight=null){
  if(!state.glare||!top.length)return null;
  if(top[0].score>=.90&&top[0].score-(top[1]?.score??0)>=.15)return null;
  const names=new Map();
  for(const view of (straight?[{image,box},straight]:[{image,box}]))for(const card of glareCandidates(view.image,view.box,state.glare)){
    const old=names.get(card.name);if(!old||card.glareScore>old.glareScore)names.set(card.name,{...card,view});
  }
  const ranked=[...names.values()].sort((a,b)=>b.glareScore-a.glareScore),best=ranked[0];
  if(state.debugGlare)state.debugGlare(ranked.map(({view,...c})=>c));
  if(!best||best.glareScore<.76||best.glareScore-(ranked[1]?.glareScore??0)<.09)return null;
  const {view,...card}=best;
  return {view,top:[{...card,score:Math.max(top[0].score+.04,card.glareScore),evidence:'art-glare'},...top.filter(c=>c.name!==card.name)].slice(0,5)};
}
