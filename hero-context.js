// Class/talent filter, not a complete tournament-legality validator.
// Safe to load as a content script and as an engine ES module.
(() => {
 const classes=new Set('Adjudicator Assassin Bard Brute Guardian Illusionist Mechanologist Merchant Necromancer Ninja Ranger Runeblade Shapeshifter Thief Warrior Wizard'.split(' '));
 const talents=new Set('Chaos Draconic Earth Elemental Ice Lightning Light Mystic Pirate Revered Reviled Royal Shadow'.split(' '));
 const key=s=>String(s||'').toLowerCase().replaceAll('ð','d').replaceAll('đ','d').normalize('NFKD').replace(/[\u0300-\u036f]/g,'');
 function parseType(type){
  if(!type)return null;
  let prefix=type.split(/\b(?:Demi-Hero|Hero|Action|Attack|Defense|Instant|Equipment|Weapon|Resource|Token|Mentor|Block|Macro)\b/)[0].trim();
  if(!prefix&&type==='Hero - Merchant')prefix='Merchant';
  if(!prefix)return null;
  const alternatives=prefix.split('/').map(s=>s.trim().split(/\s+/).filter(w=>w!=='Generic'));
  if(alternatives.some(a=>a.some(w=>!classes.has(w)&&!talents.has(w))))return null;
  return alternatives;
 }
 function buildCatalog(cards,extras={}){
  const metadata=new Map(),heroes=new Map();
  for(const c of cards){
   const k=key(c.name),old=metadata.get(k)||[];
   if(c.type&&!old.some(x=>x.type===c.type))old.push({type:c.type,sets:parseType(c.type),token:/\bToken\b/.test(c.type),hero:/\bHero\b/.test(c.type)});
   metadata.set(k,old);
   if(!/\bHero\b/.test(c.type||'')||/Demi-Hero/.test(c.type)||!parseType(c.type))continue;
   const sets=parseType(c.type),extra=extras[k]||{},tags=[...new Set([...sets.flat(),...(extra.talents||[])])];
   heroes.set(k,{name:c.name,type:c.type,tags,unknownEssence:tags.includes('Elemental')&&!extra.talents?.length,unrestricted:tags.includes('Shapeshifter')});
  }
  return {metadata,heroes,options:[...heroes.values()].sort((a,b)=>a.name.localeCompare(b.name))};
 }
 function compatible(name,hero,catalog){
  if(!hero||hero.unrestricted)return null;
  const rows=catalog.metadata.get(key(name));if(!rows?.length)return null;
  if(rows.some(r=>r.token||r.hero))return null;
  let uncertain=false;
  for(const row of rows){
   if(!row.sets){uncertain=true;continue;}
   for(const requirements of row.sets){
    if(requirements.every(t=>hero.tags.includes(t)))return true;
    if(hero.unknownEssence&&requirements.some(t=>['Earth','Ice','Lightning'].includes(t))&&requirements.filter(t=>!['Earth','Ice','Lightning'].includes(t)).every(t=>hero.tags.includes(t)))uncertain=true;
   }
  }
  return uncertain?null:false;
 }
 function normalizeContext(context,catalog){
  return {enabled:context?.enabled!==false,axis:context?.axis==='y'?'y':'x',slots:[0,1].map(i=>catalog.heroes.get(key(context?.slots?.[i]))||null)};
 }
 function relevantHeroes(box,width,height,context){
  if(!context.enabled)return [];
  const position=context.axis==='x'?(box.x+box.w/2)/width:(box.y+box.h/2)/height;
  if(position<.38)return context.slots[0]?[context.slots[0]]:[];
  if(position>.62)return context.slots[1]?[context.slots[1]]:[];
  // Centre/chain area may contain cards from either player. Unknown opponent => abstain.
  return context.slots.every(Boolean)?context.slots:[];
 }
 function filterCandidates(candidates,box,width,height,context,catalog){
  // With both players known, reject cards incompatible with BOTH everywhere,
  // including previews and cards temporarily moved across the table.
  const heroes=context.enabled&&context.slots.every(Boolean)?context.slots:relevantHeroes(box,width,height,context);
  if(!heroes.length)return candidates;
  return candidates.filter(c=>{
   const rows=catalog.metadata.get(key(c.name));
   if(rows?.some(r=>r.hero)&&context.slots.every(Boolean))return context.slots.some(h=>key(h.name)===key(c.name));
   return !heroes.every(h=>compatible(c.name,h,catalog)===false);
  });
 }
 function applyPrior(top,pool,box,width,height,context,catalog){
  const heroes=relevantHeroes(box,width,height,context);
  const active=context.enabled&&(context.slots.every(Boolean)||heroes.length);
  if(!active)return top.slice(0,5);
  const neutralTop=catalog.metadata.get(key(top[0]?.name))?.some(r=>r.hero||r.token);
  const candidates=new Map();for(const c of [...top,...pool])if(!candidates.has(key(c.name)))candidates.set(key(c.name),c);
  return filterCandidates([...candidates.values()],box,width,height,context,catalog).map(c=>{
   const votes=heroes.map(h=>compatible(c.name,h,catalog)),match=votes.includes(true);
   return {...c,heroCompatible:match?true:null,heroPriority:c.score+(match&&!neutralTop&&c.score>=.45?.055:0)};
  }).sort((a,b)=>b.heroPriority-a.heroPriority).slice(0,5);
 }
 function observations(boxes,width,height,axis,catalog){
  const out=[null,null];
  for(const b of boxes){
   const visual=b.top?.[0], direct=catalog.heroes.has(key(visual?.name));
   const c=direct?visual:b.heroTop?.[0],h=catalog.heroes.get(key(c?.name));
   // Dedicated hero comparison is still gated against the unrestricted visual
   // result, so a random action card cannot become a hero just by filtering.
   const runner=direct?b.top?.[1]:b.heroTop?.[1];
   if(!h||c.score<.68||c.score-(runner?.score??0)<.04||(!direct&&c.score<(visual?.score??0)-.035)||b.w*b.h/(width*height)>.055)continue;
   const position=axis==='x'?(b.x+b.w/2)/width:(b.y+b.h/2)/height;if(position>.4&&position<.6)continue;
   const side=position<.5?0:1;
   if(!out[side]||c.score>out[side].score)out[side]={name:h.name,score:c.score,x:(b.x+b.w/2)/width,y:(b.y+b.h/2)/height};
  }
  return out;
 }
 function advanceAuto(previous,observation,now){
  let state=previous||{name:null,pending:null,hits:0,lastSeen:0};
  // Confirmed profiles stay until a new match, seek/reset or another confirmed
  // hero. A hand covering the card must not silently disable the filter.
  if(!observation)return state.pendingAt&&now-state.pendingAt>12000?{...state,pending:null,hits:0}:state;
  const same=state.pending===observation.name&&now-(state.pendingAt||0)<=12000&&Math.hypot((state.x??observation.x)-observation.x,(state.y??observation.y)-observation.y)<.12;
  const hits=same?state.hits+1:1;
  return {name:hits>=3?observation.name:state.name,pending:observation.name,hits,pendingAt:now,lastSeen:hits>=3||observation.name===state.name?now:state.lastSeen,x:observation.x,y:observation.y};
 }
 globalThis.FabHeroContext=Object.freeze({key,parseType,buildCatalog,compatible,normalizeContext,relevantHeroes,filterCandidates,applyPrior,observations,advanceAuto});
})();
