// Pitch is supporting evidence, never a hard exclusion. null means unreadable.
export function classifyPitchBand(rgba,width,height){
  const counts={1:0,2:0,3:0},rows=[];let usable=0,muted=0,bright=0;
  const color=(r,g,b)=>{
    const max=Math.max(r,g,b),min=Math.min(r,g,b),delta=max-min;
    if(max<65||delta<35||delta/max<.34)return null;
    let h=max===r?((g-b)/delta)%6:max===g?(b-r)/delta+2:(r-g)/delta+4;h=(h*60+360)%360;
    if(h<22||h>338)return 1;
    if(h>=38&&h<=72)return 2;
    if(h>=180&&h<=255)return 3;
    return null;
  };
  const x0=Math.floor(width*.24),x1=Math.ceil(width*.76),y0=Math.floor(height*.018),y1=Math.ceil(height*.075);
  for(let y=y0;y<y1;y++){
    const bins=Array.from({length:6},()=>[0,0,0,0]);
    for(let x=x0;x<x1;x++){
      const i=(y*width+x)*4,r=rgba[i],g=rgba[i+1],b=rgba[i+2],max=Math.max(r,g,b),min=Math.min(r,g,b);
      if(max>230)bright++;if(max-min<30)muted++;usable++;
      const c=color(r,g,b),bin=Math.min(5,Math.floor((x-x0)*6/(x1-x0)));bins[bin][0]++;if(c)bins[bin][c]++;
    }
    const support={1:0,2:0,3:0};
    for(const c of [1,2,3])support[c]=bins.filter(bin=>bin[c]/bin[0]>=.55).length/6;
    rows.push(support);
  }
  for(let y=0;y<rows.length;y++)for(const c of [1,2,3]){
    const adjacent=Math.max(rows[y-1]?.[c]||0,rows[y+1]?.[c]||0);
    counts[c]=Math.max(counts[c],Math.min(rows[y][c],adjacent));
  }
  const sorted=[1,2,3].sort((a,b)=>counts[b]-counts[a]);
  if(counts[sorted[0]]>=5/6&&counts[sorted[0]]-counts[sorted[1]]>=.33)return {value:sorted[0],confidence:counts[sorted[0]]};
  // Neutral is weaker evidence: faded foil or a hidden stripe may also look neutral.
  if(usable&&muted/usable>.80&&bright/usable<.60&&counts[sorted[0]]<.34)return {value:0,confidence:.35};
  return {value:null,confidence:0};
}
export function readPitch(image,box,rotation){
  // Do not mistake a side border or the illustration for the top pitch stripe.
  const sideways=Math.abs(rotation)%2===1;
  if((box.w/box.h>1.15&&!sideways)||(box.h/box.w>1.15&&sideways))return {value:null,confidence:0};
  const canvas=new OffscreenCanvas(256,256),ctx=canvas.getContext('2d',{willReadFrequently:true});
  ctx.translate(128,128);ctx.rotate(rotation*Math.PI/2);
  ctx.drawImage(image,box.x,box.y,box.w,box.h,-128,-128,256,256);
  return classifyPitchBand(ctx.getImageData(0,0,256,256).data,256,256);
}
export function pitchAdjustment(expected,reading){
  if(expected==null||reading?.value==null)return 0;
  const weight=reading.value===0?.015:.035;
  return (expected===reading.value?1:-1)*weight*reading.confidence;
}
export function applyPitch(candidates,reading,variants){
  if(reading?.value==null)return candidates.slice(0,5);
  return candidates.map(card=>{
    const choices=variants.get(card.name)||[];
    const current=choices.find(c=>c.large===card.image);
    const matches=choices.filter(c=>c.pitch===reading.value);
    // Choose a matching-pitch printing of the same named card when the stripe is clear.
    const selected=reading.confidence>=.8&&matches.length?(matches.find(c=>c.large===card.image)||matches[0]):current;
    const expected=selected?.pitch??card.pitch;
    return {...card,image:selected?.large||card.image,pitch:expected,score:card.score+pitchAdjustment(expected,reading),pitchObserved:reading.value};
  }).sort((a,b)=>b.score-a.score).slice(0,5);
}
