// Estimate small table-plane tilt from edge directions inside the detected card.
// This is a rotation correction, not a perspective reconstruction.
export function straightenCard(image,box){
  const w=Math.max(32,Math.round(box.w)),h=Math.max(32,Math.round(box.h));
  const sample=new OffscreenCanvas(w,h),s=sample.getContext('2d',{willReadFrequently:true});s.drawImage(image,box.x,box.y,box.w,box.h,0,0,w,h);
  const pixels=s.getImageData(0,0,w,h).data,gray=new Float32Array(w*h);
  for(let i=0;i<gray.length;i++)gray[i]=.299*pixels[4*i]+.587*pixels[4*i+1]+.114*pixels[4*i+2];
  const histogram=new Float32Array(31);let total=0;
  for(let y=Math.ceil(h*.09);y<h*.91-1;y++)for(let x=Math.ceil(w*.09);x<w*.91-1;x++){
    const i=y*w+x,gx=gray[i+1]-gray[i-1],gy=gray[i+w]-gray[i-w],weight=Math.hypot(gx,gy);
    if(weight<30)continue;
    let angle=Math.atan2(gy,gx)*180/Math.PI;
    angle=((angle+45+360)%90)-45;
    if(Math.abs(angle)>30)continue;
    const bin=Math.round((angle+30)/2);histogram[bin]+=Math.min(weight,120);total+=Math.min(weight,120);
  }
  const smooth=Array.from(histogram,(_,i)=>(histogram[i-1]||0)+2*histogram[i]+(histogram[i+1]||0));
  let best=15;for(let i=4;i<=26;i++)if(smooth[i]>smooth[best])best=i;
  const degrees=best*2-30;
  if(Math.abs(degrees)<8||Math.abs(degrees)>22||smooth[best]<smooth[15]*1.35||smooth[best]<total*.16)return null;
  const angle=degrees*Math.PI/180,c=Math.cos(angle),sin=Math.abs(Math.sin(angle)),den=c*c-sin*sin;
  const rw=(box.w*c-box.h*sin)/den,rh=(box.h*c-box.w*sin)/den;
  if(rw<box.w*.48||rh<box.h*.48||rw<20||rh<20)return null;
  const canvas=new OffscreenCanvas(Math.round(rw),Math.round(rh)),ctx=canvas.getContext('2d');
  ctx.translate(canvas.width/2,canvas.height/2);ctx.rotate(-angle);
  ctx.drawImage(image,-(box.x+box.w/2),-(box.y+box.h/2));
  return {image:canvas,box:{x:0,y:0,w:canvas.width,h:canvas.height},degrees};
}
