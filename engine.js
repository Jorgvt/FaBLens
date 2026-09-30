import {frameCache,cropSignature,cachedCard,sameCrop} from './card-cache.js';
import {plausibleCardBox,cardBoundary,keepCard,consistentCardSizes} from './card-presence.js';
import './hero-context.js';
import {buildGlareSearch,verifyGlare} from './glare-match.js';
import {buildDetailSearch,verifyDetailed} from './detail-match.js';
import {straightenCard} from './geometry.js';
import {readPitch,applyPitch} from './pitch.js';
import * as ort from './vendor/ort/ort.wasm.min.mjs';
import {readCachedReferences} from './catalog-cache.js';
import {outlineFeatures,outlineScore,ART_FEATURES,buildOutlineSearch,shortlistOutlines,zonedFeatures,zonedScore} from './art-outline.js';

ort.env.wasm.numThreads=1;
ort.env.wasm.wasmPaths=chrome.runtime.getURL('vendor/ort/');
let ready;
let activeState,embeddingQueue=Promise.resolve(),analysisQueue=Promise.resolve();
const rankMeta=new WeakMap();
let cropCanvas;
const mean=[.485,.456,.406],std=[.229,.224,.225];
const nameKey=s=>s.toLowerCase().replaceAll('đ','d').replaceAll('ð','d').normalize('NFKD').replace(/[\u0300-\u036f]/g,'');

function buildRankMeta(cards){
  const unique=new Map(),nameIds=new Int32Array(cards.length);
  for(let i=0;i<cards.length;i++){
    const k=nameKey(cards[i].name);
    if(!unique.has(k))unique.set(k,unique.size);
    nameIds[i]=unique.get(k);
  }
  return {nameIds,numNames:unique.size};
}

async function createSession(url,options={}){
  try{
    return await ort.InferenceSession.create(url,{executionProviders:['webgpu','wasm'],graphOptimizationLevel:'all',...options});
  }catch(e){
    console.warn('FaB WebGPU init fallback:',e);
    return await ort.InferenceSession.create(url,{executionProviders:['wasm'],...options});
  }
}

function load() {
  if(!ready)ready=(async()=>{
    const [detector,embedder,cardsResponse,vectorsResponse]=await Promise.all([
      createSession(chrome.runtime.getURL('models/card-detector.onnx')),
      createSession(chrome.runtime.getURL('models/embAll2_mnv3s128.onnx')),
      fetch(chrome.runtime.getURL('models/embeddings.json')),
      fetch(chrome.runtime.getURL('models/embeddings.bin'))
    ]);
    if(!cardsResponse.ok||!vectorsResponse.ok)throw Error('FaB card index unavailable');
    const cards=await cardsResponse.json(),vectors=new Float32Array(await vectorsResponse.arrayBuffer());
    if(vectors.length!==cards.length*256)throw Error('FaB card index incomplete');
    const state={detector,embedder,cards,vectors,catalog:{indexed:cards.length,total:0,completed:0,failed:0,busy:false}};
    // Optional support index: failure never prevents the existing recognizer from loading.
    state.outline=null;
    try{
      const [metaResponse,bankResponse]=await Promise.all([
        fetch(chrome.runtime.getURL('models/art-outline.json')),
        fetch(chrome.runtime.getURL('models/art-outline.bin'))
      ]);
      if(!metaResponse.ok||!bankResponse.ok)throw Error('Art support index unavailable');
      const references=await metaResponse.json(),bank=new Int8Array(await bankResponse.arrayBuffer());
      if(bank.length!==references.length*ART_FEATURES||references.some(i=>!Number.isInteger(i)||!cards[i]))throw Error('Art support index incomplete');
      state.outline=buildOutlineSearch(bank,references,cards);
    }catch(error){console.warn('FaB art support:',error);}
    state.detail=null;state.glare=null;
    if(state.outline)try{
      const response=await fetch(chrome.runtime.getURL('models/art-detail.bin'));
      if(!response.ok)throw Error('Detailed art index unavailable');
      const detailRaw=new Uint8Array(await response.arrayBuffer());
      state.detail=buildDetailSearch(detailRaw,state.outline.references,cards);
      state.glare=buildGlareSearch(detailRaw,state.outline.references,cards);
    }catch(error){console.warn('FaB detailed art support:',error);}
    activeState=state;
    await restoreAndSync(state).catch(error=>console.warn('FaB catalogue cache:',error));
    state.pitchVariants=new Map();
    for(const card of state.cards){if(!state.pitchVariants.has(card.name))state.pitchVariants.set(card.name,[]);state.pitchVariants.get(card.name).push(card);}
    let heroExtras={};
    try{const response=await fetch(chrome.runtime.getURL('models/hero-extras.json'));if(response.ok)heroExtras=await response.json();}catch(error){console.warn('FaB hero metadata:',error);}
    state.heroCatalog=globalThis.FabHeroContext.buildCatalog(state.cards,heroExtras);
    return state;
  })().catch(e=>{ready=null;throw e;});
  return ready;
}

function appendReferences(state,items){
  if(!items.length)return;
  const next=new Float32Array(state.vectors.length+items.length*256);next.set(state.vectors);
  items.forEach((item,i)=>next.set(item.vector,state.vectors.length+i*256));
  state.vectors=next;state.cards=state.cards.concat(items.map(item=>item.card));
  state.catalog.indexed=state.cards.length;
}
function embedBatch(state,batch,count){
  const result=embeddingQueue.then(async()=>{
    // Bound model activations instead of running up to 90 crops in one batch.
    const combined=new Float32Array(count*256),stride=3*128*128;
    for(let start=0;start<count;start+=12){
      const length=Math.min(12,count-start),input=new ort.Tensor('float32',batch.subarray(start*stride,(start+length)*stride),[length,3,128,128]);
      let outputs;
      try{outputs=await state.embedder.run({[state.embedder.inputNames[0]]:input});combined.set(outputs[state.embedder.outputNames[0]].data,start*256);}
      finally{input.dispose?.();if(outputs)for(const tensor of Object.values(outputs))tensor.dispose?.();}
    }
    return {[state.embedder.outputNames[0]]:{data:combined}};
  });
  embeddingQueue=result.catch(()=>{});return result;
}
// Restore only references already calculated by an earlier version. Never download a catalogue.
async function restoreAndSync(state){
  const response=await fetch(chrome.runtime.getURL('models/pending-catalog.json'));
  if(!response.ok)return;
  const missing=await response.json(),allowed=new Map(missing.map(card=>[card.large,card]));
  const bundled=new Set(state.cards.map(card=>card.large));
  const saved=await readCachedReferences();
  const usable=saved.filter(item=>allowed.has(item.url)&&!bundled.has(item.url)&&item.vector?.length===256&&Array.from(item.vector).every(Number.isFinite));
  appendReferences(state,usable.map(item=>({...item,card:allowed.get(item.url)})));
}

function detectorTensor(canvas) {
  const out=new OffscreenCanvas(640,640),ctx=out.getContext('2d',{willReadFrequently:true});
  ctx.fillStyle='rgb(114,114,114)';ctx.fillRect(0,0,640,640);
  const scale=Math.min(640/canvas.width,640/canvas.height),w=canvas.width*scale,h=canvas.height*scale;
  const px=(640-w)/2,py=(640-h)/2;ctx.drawImage(canvas,px,py,w,h);
  const rgba=ctx.getImageData(0,0,640,640).data,plane=640*640,a=new Float32Array(plane*3);
  for(let i=0;i<plane;i++){a[i]=rgba[4*i]/255;a[plane+i]=rgba[4*i+1]/255;a[2*plane+i]=rgba[4*i+2]/255;}
  return {tensor:a,scale,px,py};
}
function iou(a,b) {
  const w=Math.max(0,Math.min(a.x+a.w,b.x+b.w)-Math.max(a.x,b.x));
  const h=Math.max(0,Math.min(a.y+a.h,b.y+b.h)-Math.max(a.y,b.y));
  const overlap=w*h;return overlap/(a.w*a.h+b.w*b.h-overlap||1);
}
function boxes(output,image,scale,px,py) {
  const data=output.data,count=output.dims[2],all=[];
  for(let i=0;i<count;i++){
    const score=data[count*4+i];if(score<.35)continue;
    const cx=data[i],cy=data[count+i],w=data[count*2+i],h=data[count*3+i];
    const x=Math.max(0,(cx-w/2-px)/scale),y=Math.max(0,(cy-h/2-py)/scale);
    const right=Math.min(image.width,(cx+w/2-px)/scale),bottom=Math.min(image.height,(cy+h/2-py)/scale);
    if(right-x<12||bottom-y<12)continue;
    all.push({x,y,w:right-x,h:bottom-y,detectScore:score});
  }
  all.sort((a,b)=>b.detectScore-a.detectScore);
  const keep=[];
  for(const box of all){if(keep.every(prev=>iou(prev,box)<.45))keep.push(box);if(keep.length===30)break;}
  return keep;
}
function cropTensor(image,box,destination,index,rotation=0) {
  const canvas=cropCanvas||(cropCanvas=new OffscreenCanvas(128,128)),ctx=canvas.getContext('2d',{willReadFrequently:true});
  ctx.setTransform(1,0,0,1,0,0);ctx.clearRect(0,0,128,128);ctx.imageSmoothingQuality='high';
  ctx.translate(64,64);ctx.rotate(rotation*Math.PI/2);ctx.translate(-64,-64);
  ctx.drawImage(image,box.x,box.y,box.w,box.h,0,0,128,128);
  const rgba=ctx.getImageData(0,0,128,128).data,plane=128*128,base=index*plane*3;
  for(let i=0;i<plane;i++)for(let channel=0;channel<3;channel++)destination[base+channel*plane+i]=(rgba[i*4+channel]/255-mean[channel])/std[channel];
}
function rank(query,cards,vectors,limit=30) {
  let meta=rankMeta.get(cards);if(!meta){meta=buildRankMeta(cards);rankMeta.set(cards,meta);}
  const {nameIds,numNames}=meta;
  const bestScores=new Float64Array(numNames);bestScores.fill(-Infinity);
  const bestIndices=new Int32Array(numNames);bestIndices.fill(-1);
  for(let i=0;i<cards.length;i++){
    let dot=0,offset=i*256;
    for(let j=0;j<256;j++)dot+=query[j]*vectors[offset+j];
    const nid=nameIds[i];
    if(dot>bestScores[nid]){bestScores[nid]=dot;bestIndices[nid]=i;}
  }
  const results=[];
  for(let k=0;k<numNames;k++){
    const idx=bestIndices[k];
    if(idx!==-1){const card=cards[idx];results.push({name:card.name,image:card.large,pitch:card.pitch,score:bestScores[k]});}
  }
  results.sort((a,b)=>b.score-a.score);
  return limit===Infinity?results:results.slice(0,limit);
}
function refineWithArt(image,box,rankings,top,state){
  const support=state.outline;
  if(!support||!top.length)return top.slice(0,5);
  // Search shapes even when the neural model is confident or omits the correct card.

  const pool=new Map();
  for(const ranking of rankings)for(const candidate of ranking){
    const key=nameKey(candidate.name),old=pool.get(key);
    if(candidate.score>=.38&&(!old||candidate.score>old.score))pool.set(key,candidate);
  }
  const scores=new Map(),zoneScores=new Map(),queries=[];
  for(let rotation=0;rotation<4;rotation++){
    const upright=new OffscreenCanvas(128,128),u=upright.getContext('2d');
    u.translate(64,64);u.rotate(rotation*Math.PI/2);
    u.drawImage(image,box.x,box.y,box.w,box.h,-64,-64,128,128);
    const patch=new OffscreenCanvas(16,16),ctx=patch.getContext('2d',{willReadFrequently:true});
    ctx.imageSmoothingQuality='low';ctx.drawImage(upright,.07*128,.14*128,.86*128,.47*128,0,0,16,16);
    const rgba=ctx.getImageData(0,0,16,16).data,gray=new Float32Array(256);
    for(let i=0;i<256;i++)gray[i]=Math.round(.299*rgba[4*i]+.587*rgba[4*i+1]+.114*rgba[4*i+2]);
    const query=outlineFeatures(gray);queries.push({query,rotation});
    for(const index of shortlistOutlines(query,support)){
      const card=support.cards[support.references[index]],key=nameKey(card.name);
      const candidate=pool.get(key)||{name:card.name,score:0};
      const score=outlineScore(query,support.bank,index),prior=scores.get(key);
      if(!prior||score>prior.artScore)scores.set(key,{...candidate,image:card.large,artScore:score,rotation});
    }
  }

  const ordered=[...scores.values()].sort((a,b)=>b.artScore-a.artScore),winner=ordered[0];
  if(state.debugArt)state.debugArt(ordered.slice(0,8));
  const neuralClear=top[0].score>=.68&&top[0].score-(top[1]?.score??-1)>=.06;
  const differs=winner&&nameKey(winner.name)!==nameKey(top[0].name);
  // Conflicting strong evidence needs a larger margin than an ambiguous neural guess.
  const minimum=(neuralClear&&differs)?1.50:1.25,margin=(neuralClear&&differs)? .18 : .10;
  if(!winner||winner.artScore<minimum||winner.artScore-(ordered[1]?.artScore??0)<margin){
    for(const {query,rotation} of queries){
      const zoneQuery=zonedFeatures(query);
      for(const index of shortlistOutlines(query,support,192,true)){
        const reference=zonedFeatures(support.bank,16,index*ART_FEATURES);
        const match=zonedScore(zoneQuery,reference);
        if(match.third<1.15)continue;
        const card=support.cards[support.references[index]],key=nameKey(card.name),prior=zoneScores.get(key);
        if(!prior||match.score>prior.zoneScore)zoneScores.set(key,{name:card.name,image:card.large,zoneScore:match.score,thirdZone:match.third,rotation});
      }
    }
    const zones=[...zoneScores.values()].sort((a,b)=>b.zoneScore-a.zoneScore),best=zones[0];
    if(state.debugZones)state.debugZones(zones.slice(0,5));
    const conflicts=neuralClear&&best&&nameKey(best.name)!==nameKey(top[0].name);
    if(!best||best.zoneScore<(conflicts?1.80:1.65)||best.zoneScore-(zones[1]?.zoneScore??0)<.12)return top.slice(0,5);
    return [{...best,score:Math.max(top[0].score+.04,best.zoneScore/2),evidence:'art-zones'},...top.filter(c=>nameKey(c.name)!==nameKey(best.name))].slice(0,5);
  }
  // Ranking score combines evidence; it is not a probability and is never displayed as one.
  const promoted={...winner,score:Math.max(top[0].score+.04,winner.artScore/2),evidence:'art-outline'};
  return [promoted,...top.filter(c=>nameKey(c.name)!==nameKey(winner.name))].slice(0,5);
}

async function analyze(dataUrl,heroInput={},progress=null) {
  const state=await load();
  const {detector,embedder,cards,vectors}=state;
  const heroAPI=globalThis.FabHeroContext,heroContext=heroAPI.normalizeContext(heroInput,state.heroCatalog);
  const response=await fetch(dataUrl),image=await createImageBitmap(await response.blob());
  const canvas=new OffscreenCanvas(image.width,image.height),ctx=canvas.getContext('2d');ctx.drawImage(image,0,0);image.close();
  const {tensor,scale,px,py}=detectorTensor(canvas);
  const detectorInput=new ort.Tensor('float32',tensor,[1,3,640,640]);let detections,found;
  try{detections=await detector.run({[detector.inputNames[0]]:detectorInput});found=consistentCardSizes(boxes(detections[detector.outputNames[0]],canvas,scale,px,py).filter(b=>plausibleCardBox(b,canvas.width,canvas.height)));}
  finally{detectorInput.dispose?.();if(detections)for(const output of Object.values(detections))output.dispose?.();}
  const cache=frameCache(heroInput.sessionKey,heroInput,canvas.width,canvas.height),enriched=[],entries=[],pending=[],matched=new Set();
  const present=()=>({width:canvas.width,height:canvas.height,boxes:enriched.filter(b=>b.presence).map(b=>{
    const top=heroAPI.applyPrior(b.top,b.neuralPool,b,canvas.width,canvas.height,heroContext,state.heroCatalog);
    const {neuralPool,heroTop,presence,...rest}=b;
    return {...rest,top,certain:top[0]?.score>=.62&&top[0].score-(top[1]?.score??-1)>=.04};
  }),pendingBoxes:pending.map(item=>item.box),catalog:state.catalog});
  for(const box of found){
    const pixels=cropSignature(canvas,box),hit=cachedCard(cache,box,pixels,iou,canvas);
    if(hit){enriched.push({...hit.result,...hit.box});entries.push({...hit,misses:0});matched.add(hit);}
    else{
      const visualHit=cache.entries.find(e=>e.result?.presence&&sameCrop(e.pixels,pixels));
      if(visualHit&&keepCard(box,visualHit.result.top,cardBoundary(canvas,box))){
        const result={...visualHit.result,...box,presence:true};
        enriched.push(result);entries.push({box,pixels,result,at:Date.now(),misses:0});
      }else{
        pending.push({box,pixels,newCard:!cache.entries.some(e=>iou(e.box,box)>.4)});
      }
    }
  }
  // A missed detector proposal is not evidence that an unchanged card vanished.
  for(const old of cache.entries){
    if(matched.has(old)||!old.result?.presence||found.some(b=>iou(old.box,b)>.4)||!consistentCardSizes([...found,old.box]).includes(old.box))continue;
    const unchanged=sameCrop(old.pixels,cropSignature(canvas,old.box));
    if(unchanged){enriched.push(old.result);entries.push({...old,misses:0});}
  }
  // New locations first; hovering a changed crop breaks ties.
  const pointer=heroInput.pointer;
  const hover=b=>pointer&&pointer.x>=b.x/canvas.width&&pointer.x<=(b.x+b.w)/canvas.width&&pointer.y>=b.y/canvas.height&&pointer.y<=(b.y+b.h)/canvas.height?1:0;
  pending.sort((a,b)=>Number(b.newCard)-Number(a.newCard)||hover(b.box)-hover(a.box)||b.box.detectScore-a.box.detectScore);
  if(progress)await progress(present());
  while(pending.length){
    const {box,pixels}=pending[0];
    const duplicate=entries.find(e=>e.result&&sameCrop(e.pixels,pixels));
    if(duplicate){
      const result={...box,top:duplicate.result.top,certain:duplicate.result.certain,pitchReading:duplicate.result.pitchReading,presence:duplicate.result.presence,heroTop:duplicate.result.heroTop,neuralPool:duplicate.result.neuralPool};
      enriched.push(result);entries.push({box,pixels,result,at:Date.now(),misses:0});pending.shift();
      if(progress)await progress(present());
      continue;
    }
    const rotations=box.w/box.h>1.15?[0,-1,1]:[0,2],batch=new Float32Array(rotations.length*3*128*128);
    rotations.forEach((r,i)=>cropTensor(canvas,box,batch,i,r));
    const results=await embedBatch(state,batch,rotations.length),embeddings=results[embedder.outputNames[0]].data;
    let activeMatch=null,activeScore=-Infinity,activeRotation=0,activeChosen=0;
    if(cache.entries.length){
      for(let rIdx=0;rIdx<rotations.length;rIdx++){
        const query=embeddings.subarray(rIdx*256,(rIdx+1)*256);
        for(const entry of cache.entries){
          if(!entry.vector||!entry.result?.presence)continue;
          let dot=0;for(let j=0;j<256;j++)dot+=query[j]*entry.vector[j];
          if(dot>activeScore){activeScore=dot;activeMatch=entry;activeRotation=rotations[rIdx];activeChosen=rIdx;}
        }
      }
    }
    if(activeMatch&&activeScore>=.90){
      const boundary=cardBoundary(canvas,box);
      if(keepCard(box,activeMatch.result.top,boundary)){
        const pitchReading=readPitch(canvas,box,activeRotation);
        const top=applyPitch(activeMatch.result.top.map(c=>({...c,rotation:activeRotation})),pitchReading,state.pitchVariants);
        const certain=top[0]?.score>=.62&&top[0].score-(top[1]?.score??-1)>=.04;
        const result={...box,top,certain,pitchReading,presence:true,heroTop:activeMatch.result.heroTop,neuralPool:activeMatch.result.neuralPool};
        enriched.push(result);entries.push({box,pixels,result,at:Date.now(),misses:0,vector:embeddings.slice(activeChosen*256,(activeChosen+1)*256)});pending.shift();
        if(progress)await progress(present());
        continue;
      }
    }
    const rankedFull=rotations.map((rotation,i)=>rank(embeddings.subarray(i*256,(i+1)*256),cards,vectors,Infinity).map(card=>({...card,rotation})));
    const ranked=rankedFull.map(r=>r.slice(0,30)),start=0,offset=ranked.length;
    let chosen=0,top=ranked[0];
    for(let i=1;i<ranked.length;i++)if((ranked[i][0]?.score||0)>(top[0]?.score||0)+.035){top=ranked[i];chosen=i;}
    const neuralPool=heroAPI.filterCandidates(rankedFull[chosen],box,canvas.width,canvas.height,heroContext,state.heroCatalog).slice(0,30);
    const heroMap=new Map();
    if(heroInput.autoSlots?.some(Boolean)!==false)for(const ranking of rankedFull.slice(start,offset))for(const c of ranking){
      if(!state.heroCatalog.heroes.has(heroAPI.key(c.name)))continue;
      const old=heroMap.get(heroAPI.key(c.name));if(!old||c.score>old.score)heroMap.set(heroAPI.key(c.name),c);
    }
    const heroTop=[...heroMap.values()].sort((a,b)=>b.score-a.score).slice(0,2);
    top=refineWithArt(canvas,box,ranked.slice(start,offset),top,state);
    const verification=verifyDetailed(canvas,box,top,state,state.detail?straightenCard(canvas,box):null);
    if(verification)top=verification.top;
    let view=verification?.view||{image:canvas,box};
    const glareVerification=verifyGlare(view.image,view.box,top,state,
      !verification&&state.glare?straightenCard(canvas,box):null);
    if(glareVerification){top=glareVerification.top;view=glareVerification.view;}
    const pitchReading=readPitch(view.image,view.box,top[0]?.rotation??0);
    top=applyPitch(top,pitchReading,state.pitchVariants);
    const certain=top[0]?.score>=.62&&top[0].score-(top[1]?.score??-1)>=.04;
    const result={...box,top,certain,pitchReading,presence:keepCard(box,top,cardBoundary(canvas,box)),heroTop,neuralPool:neuralPool.map(c=>applyPitch([c],pitchReading,state.pitchVariants)[0])};
    enriched.push(result);entries.push({box,pixels,result,at:Date.now(),misses:0,vector:embeddings.slice(chosen*256,(chosen+1)*256)});pending.shift();
    if(progress)await progress(present());
  }
  cache.entries=entries.slice(0,30);
  const heroObservations=heroAPI.observations(enriched.filter(b=>b.presence),canvas.width,canvas.height,heroContext.axis,state.heroCatalog);
  return {...present(),heroObservations,heroOptions:heroInput.includeOptions?state.heroCatalog.options:undefined};
}
chrome.runtime.onMessage.addListener((message,_sender,respond)=>{
  if(message?.type==='FAB_CATALOG_STATUS'){respond(activeState?.catalog||null);return false;}
  if(message?.type!=='FAB_ANALYZE')return false;
  const progress=_sender.tab?.id&&message.requestId?async result=>{try{await chrome.runtime.sendMessage({type:'FAB_PROGRESS',targetTabId:_sender.tab.id,requestId:message.requestId,result});}catch{}}:null;
  const job=analysisQueue.then(()=>analyze(message.image,message.heroContext,progress));
  analysisQueue=job.catch(()=>{});job.then(respond).catch(e=>respond({error:e.message}));
  return true;
});
