// Grayscale art support for ambiguous neural matches. Two normalized 16×16 planes.
export const ART_SIZE=16, ART_FEATURES=512;
const reflect=(i,n)=>i<0?-i:i>=n?2*n-2-i:i;
export function outlineFeatures(gray) {
  const n=ART_SIZE,smoothed=new Float32Array(n*n),out=new Float32Array(ART_FEATURES);
  const at=(a,x,y)=>a[reflect(y,n)*n+reflect(x,n)];
  let mean=0;
  for(let y=0;y<n;y++)for(let x=0;x<n;x++){
    let sum=0;
    for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++)sum+=at(gray,x+dx,y+dy)*(dx===0?2:1)*(dy===0?2:1);
    smoothed[y*n+x]=sum/16;mean+=sum/16;
  }
  mean/=n*n;
  let norm=0;
  for(let i=0;i<n*n;i++){out[i]=smoothed[i]-mean;norm+=out[i]*out[i];}
  norm=Math.sqrt(norm)||1;
  for(let i=0;i<n*n;i++)out[i]/=norm;
  let gradNorm=0;
  for(let y=0;y<n;y++)for(let x=0;x<n;x++){
    const gx=at(out,x+1,y-1)+2*at(out,x+1,y)+at(out,x+1,y+1)-at(out,x-1,y-1)-2*at(out,x-1,y)-at(out,x-1,y+1);
    const gy=at(out,x-1,y+1)+2*at(out,x,y+1)+at(out,x+1,y+1)-at(out,x-1,y-1)-2*at(out,x,y-1)-at(out,x+1,y-1);
    out[n*n+y*n+x]=gx+gy;gradNorm+=(gx+gy)**2;
  }
  gradNorm=Math.sqrt(gradNorm)||1;
  for(let i=n*n;i<out.length;i++)out[i]/=gradNorm;
  return out;
}
export function outlineScore(query,bank,index){
  let sum=0;const offset=index*ART_FEATURES;
  for(let i=0;i<ART_FEATURES;i++)sum+=query[i]*bank[offset+i];
  return sum/127;
}

// Four spatial zones, compared at the same position in the same reference.
// Local centering makes a covered corner affect that corner, not the whole art.
export function zonedFeatures(feature,size=16,offset=0){
  const half=size/2,area=half*half,out=new Float32Array(size*size*2);
  for(let zone=0;zone<4;zone++)for(let plane=0;plane<2;plane++){
    const base=(zone*2+plane)*area;let sum=0,norm=0;
    for(let y=0;y<half;y++)for(let x=0;x<half;x++){
      const value=feature[offset+plane*size*size+(Math.floor(zone/2)*half+y)*size+(zone%2)*half+x];
      out[base+y*half+x]=value;sum+=value;
    }
    const mean=sum/area;
    for(let i=0;i<area;i++){out[base+i]-=mean;norm+=out[base+i]**2;}
    norm=Math.sqrt(norm)||1;
    for(let i=0;i<area;i++)out[base+i]/=norm;
  }
  return out;
}
export function zonedScore(query,reference,offset=0,zoneLength=128){
  const scores=[];
  for(let zone=0;zone<4;zone++){
    let sum=0;const base=zone*zoneLength;
    for(let j=0;j<zoneLength;j++)sum+=query[base+j]*reference[offset+base+j];
    scores.push(sum);
  }
  scores.sort((a,b)=>b-a);
  // At least three spatial zones contribute; never accept a single matching fragment.
  return {score:(scores[0]+scores[1]+scores[2])/3,third:scores[2]};
}

// Coarse shape search across every reference, independent of neural candidates.
// The shortlist saves work; exact 512-value scores still decide the result.
export function coarseOutline(feature,offset=0){
  const out=new Float32Array(128);
  for(let plane=0;plane<2;plane++){
    let norm=0;
    for(let y=0;y<8;y++)for(let x=0;x<8;x++){
      const pos=offset+plane*256+y*32+x*2;
      const value=feature[pos]+feature[pos+1]+feature[pos+16]+feature[pos+17];
      out[plane*64+y*8+x]=value;norm+=value*value;
    }
    norm=Math.sqrt(norm)||1;
    for(let i=0;i<64;i++)out[plane*64+i]/=norm;
  }
  return out;
}
export function buildOutlineSearch(bank,references,cards){
  const coarse=new Float32Array(references.length*128);
  references.forEach((id,index)=>coarse.set(coarseOutline(bank,index*ART_FEATURES),index*128));
  const zonedCoarse=new Float32Array(coarse.length);
  references.forEach((id,index)=>zonedCoarse.set(zonedFeatures(coarse,8,index*128),index*128));
  return {bank,coarse,zonedCoarse,references,cards};
}
export function shortlistOutlines(query,support,limit=256,zones=false){
  const coarseQuery=coarseOutline(query),best=[];
  const zoneQuery=zones?zonedFeatures(coarseQuery,8):null;
  let minIndex=0,minScore=-Infinity;
  for(let index=0;index<support.references.length;index++){
    let score=0,offset=index*128;
    if(zones)score=zonedScore(zoneQuery,support.zonedCoarse,offset,32).score;
    else for(let j=0;j<128;j++)score+=coarseQuery[j]*support.coarse[offset+j];
    if(best.length<limit){best.push({index,score});if(best.length<limit)continue;}
    else if(score>minScore)best[minIndex]={index,score};else continue;
    minScore=Infinity;
    for(let i=0;i<best.length;i++)if(best[i].score<minScore){minScore=best[i].score;minIndex=i;}
  }
  return best.map(item=>item.index);
}
