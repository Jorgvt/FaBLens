(() => {
  if(window.__fabLensNeural)return;
  window.__fabLensNeural=true;
  let root,video,timer,busy=false,lastTime=-1,lastSize='',status,boxLayer,panel,quick,enabled=false,pinned=false,hoverName='',hideTimer,lastPointer,tracks=[],lastCount=0;
  let panelHeading,panelImage,panelAltBtn,panelNote,panelRetryBtn;
  const preloadedImages=new Set();
  let heroButton,heroPanel,heroSelects=[],heroLabels=[],heroOptions=[],heroAuto=[null,null],heroSelections=['none','none'],heroAxis='x',heroEnabled=true,heroEpoch=0,pageKey=location.href;
  let heroTip,tipDismissed=false;
  let frameCanvas,positionPending=false,requestSerial=0,activeRequest=null,displayed=null;
  const sessionKey=Date.now().toString(36)+Math.random().toString(36);
  const el=(tag,cls='',label='')=>{const node=document.createElement(tag);node.className=cls;node.textContent=label;return node;};
  const button=(parent,label,fn)=>{const node=el('button','',label);node.type='button';node.onclick=fn;parent.append(node);return node;};
  chrome.runtime.onMessage.addListener(message=>{if(message.type==='FAB_TOGGLE')setEnabled(!enabled);
    if(message.type==='FAB_PROGRESS'&&activeRequest&&message.requestId===activeRequest.id&&enabled&&!document.hidden&&heroEpoch===activeRequest.epoch&&location.href===activeRequest.page&&video===activeRequest.video&&Math.abs(video.currentTime-activeRequest.time)<12){render(message.result);lastCount=message.result.boxes.length;}
  });
  function pickVideo(){return [...document.querySelectorAll('video')].filter(v=>v.getBoundingClientRect().width>200).sort((a,b)=>b.getBoundingClientRect().width-a.getBoundingClientRect().width)[0];}
  function mount(){
    if(root)return;
    video=pickVideo();if(!video)return;
    root=el('div');root.id='fab-neural-root';document.documentElement.append(root);
    quick=el('button','fab-neural-quick');quick.type='button';quick.setAttribute('aria-pressed','false');quick.title='Enable FaB Lens';quick.setAttribute('aria-label','Enable FaB Lens');
    const icon=el('img');icon.src=chrome.runtime.getURL('icons/activation.png');icon.alt='';quick.append(icon);
    quick.onclick=()=>setEnabled(!enabled);root.append(quick);
    status=el('div','fab-neural-status');status.hidden=true;status.setAttribute('role','status');root.append(status);
    boxLayer=el('div','fab-neural-boxes');root.append(boxLayer);
    panel=el('div','fab-neural-panel');panel.hidden=true;panel.setAttribute('role','region');panel.setAttribute('aria-label','Card preview');root.append(panel);
    panel.style.left=Math.max(8,innerWidth-316)+'px';panel.style.top='64px';
    panel.onpointerenter=()=>clearTimeout(hideTimer);
    panel.onpointerleave=()=>{if(!pinned)hideTimer=setTimeout(()=>{panel.hidden=true;hoverName='';},220);};
    mountPanelTemplate();
    document.addEventListener('pointermove',event=>{lastPointer={x:event.clientX,y:event.clientY};if(!positionPending){positionPending=true;requestAnimationFrame(()=>{positionPending=false;positionQuick();});}},{passive:true});
    mountHeroes();
    document.addEventListener('keydown',event=>{if(event.key!=='Escape'||!enabled)return;if(!heroPanel.hidden){heroPanel.hidden=true;heroButton.setAttribute('aria-expanded','false');refreshHeroes();heroButton.focus();}else{panel.hidden=true;pinned=false;hoverName='';}});
    document.addEventListener('fullscreenchange',()=>{(document.fullscreenElement||document.documentElement).append(root);positionQuick();});
    window.addEventListener('resize',()=>{positionQuick();panel.style.left=Math.max(8,Math.min(parseFloat(panel.style.left)||8,innerWidth-panel.offsetWidth-8))+'px';panel.style.top=Math.max(8,Math.min(parseFloat(panel.style.top)||8,innerHeight-80))+'px';});
    scheduleTick(200);positionQuick();
  }
  function scheduleTick(delay=60){
    clearTimeout(timer);
    timer=setTimeout(tick,delay);
  }
  function setEnabled(next){
    mount();if(!root)return;
    enabled=next;quick.setAttribute('aria-pressed',String(enabled));quick.classList.toggle('active',enabled);
    quick.title=enabled?'Disable FaB Lens':'Enable FaB Lens';quick.setAttribute('aria-label',quick.title);
    status.hidden=!enabled;heroButton.hidden=!enabled;if(!enabled){heroPanel.hidden=true;heroButton.setAttribute('aria-expanded','false');}refreshHeroes();
    if(!enabled){clearTimeout(timer);boxLayer.replaceChildren();displayed=null;panel.hidden=true;pinned=false;hoverName='';status.textContent='';tracks=[];resetHeroes(false);return;}
    status.textContent='Loading card detector…';lastTime=-1;tick();
  }
  function positionQuick(){
    if(!root||!video)return;
    const r=videoRect(),over=lastPointer&&lastPointer.x>=r.left&&lastPointer.x<r.left+r.width&&lastPointer.y>=r.top&&lastPointer.y<r.top+r.height;
    quick.hidden=!over&&!enabled;
    quick.style.left=Math.max(4,r.left+r.width-43)+'px';quick.style.top=Math.max(4,r.top+12)+'px';
    if(heroButton){heroButton.style.left=Math.max(4,r.left+r.width-185)+'px';heroButton.style.top=Math.max(4,r.top+12)+'px';heroPanel.style.left=Math.max(8,Math.min(innerWidth-328,r.left+r.width-328))+'px';heroPanel.style.top=Math.max(8,Math.min(innerHeight-300,r.top+80))+'px';}
    if(heroTip){heroTip.style.left=Math.max(8,Math.min(innerWidth-304,r.left+r.width-304))+'px';heroTip.style.top=Math.max(8,Math.min(innerHeight-180,r.top+84))+'px';}
    status.style.left=Math.max(4,r.left+r.width-225)+'px';status.style.top=Math.max(4,r.top+52)+'px';
  }
  function videoRect(){
    const rect=video.getBoundingClientRect(),ratio=video.videoWidth/video.videoHeight;
    if(!ratio)return rect;
    const w=Math.min(rect.width,rect.height*ratio),h=w/ratio;
    return {left:rect.left+(rect.width-w)/2,top:rect.top+(rect.height-h)/2,width:w,height:h};
  }
  function blobToDataURL(blob){
    return new Promise((resolve,reject)=>{const r=new FileReader();r.onloadend=()=>resolve(r.result);r.onerror=reject;r.readAsDataURL(blob);});
  }
  async function frame(){
    const canvas=frameCanvas||(frameCanvas=document.createElement('canvas')),width=Math.min(1600,video.videoWidth),height=Math.round(width*video.videoHeight/video.videoWidth);if(canvas.width!==width)canvas.width=width;if(canvas.height!==height)canvas.height=height;
    const ctx=canvas.getContext('2d',{willReadFrequently:true});
    try {
      ctx.drawImage(video,0,0,canvas.width,canvas.height);
      const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/jpeg',.85));
      return blob?blobToDataURL(blob):canvas.toDataURL('image/jpeg',.85);
    }
    catch(error) {
      root.style.visibility='hidden';
      let response;try{response=await chrome.runtime.sendMessage({type:'FAB_CAPTURE'});}finally{root.style.visibility='visible';}
      if(!response?.data)throw Error(response?.error||'Unable to capture video. Click the FaB Lens icon in the Chrome toolbar, then try again.');
      const image=new Image();image.src=response.data;await image.decode();
      const r=videoRect();ctx.drawImage(image,r.left*image.width/innerWidth,r.top*image.height/innerHeight,r.width*image.width/innerWidth,r.height*image.height/innerHeight,0,0,canvas.width,canvas.height);
      const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/jpeg',.85));
      return blob?blobToDataURL(blob):canvas.toDataURL('image/jpeg',.85);
    }
  }
  async function analyze(image,heroRequest){
    const init=await chrome.runtime.sendMessage({type:'FAB_ENGINE_READY'});
    if(init?.error)throw Error(init.error);
    try{return await chrome.runtime.sendMessage({type:'FAB_ANALYZE',image,heroContext:heroRequest,requestId:activeRequest?.id});}
    catch(error){await new Promise(resolve=>setTimeout(resolve,300));return chrome.runtime.sendMessage({type:'FAB_ANALYZE',image,heroContext:heroRequest,requestId:activeRequest?.id});}
  }
  let checkCanvas;
  function boxPixelSignature(canvas,box,rWidth,rHeight){
    if(!canvas||!box)return null;
    const c=checkCanvas||(checkCanvas=document.createElement('canvas'));
    c.width=16;c.height=16;
    const ctx=c.getContext('2d',{willReadFrequently:true});
    const sx=box.x/rWidth*canvas.width,sy=box.y/rHeight*canvas.height;
    const sw=box.w/rWidth*canvas.width,sh=box.h/rHeight*canvas.height;
    ctx.drawImage(canvas,sx,sy,sw,sh,0,0,16,16);
    return ctx.getImageData(0,0,16,16).data;
  }
  function isBoxVacant(sigA,sigB){
    if(!sigA||!sigB||sigA.length!==sigB.length)return false;
    let sum=0;
    for(let i=0;i<sigA.length;i+=4){
      sum+=(Math.abs(sigA[i]-sigB[i])+Math.abs(sigA[i+1]-sigB[i+1])+Math.abs(sigA[i+2]-sigB[i+2]))/3;
    }
    return sum/(sigA.length/4)>28;
  }
  async function tick(){
    if(!root||busy||document.hidden)return;
    const current=pickVideo();if(!current)return;
    if(current!==video||pageKey!==location.href){video=current;pageKey=location.href;lastTime=-1;resetHeroes(true);}
    positionQuick();if(!enabled)return;
    if(video.readyState<2||!video.videoWidth){status.textContent='Waiting for video…';scheduleTick(300);return;}
    const r=videoRect(),size=[r.left,r.top,r.width,r.height].map(Math.round).join(':');
    if(Math.abs(video.currentTime-lastTime)<.05&&size===lastSize){
      scheduleTick(video.paused?400:100);
      return;
    }
    if(lastTime>=0&&(video.currentTime<lastTime-.5||video.currentTime-lastTime>12))resetHeroes(false);
    const epoch=heroEpoch,request=heroRequest(),requestVideo=video,requestPage=location.href,captureTime=video.currentTime;
    busy=true;activeRequest={id:sessionKey+':'+(++requestSerial),epoch,page:requestPage,video:requestVideo,time:captureTime};
    try{
      const image=await frame();
      if(displayed?.boxes?.length&&frameCanvas){
        for(const node of boxLayer.children){
          if(node._fabBox&&node._fabSig){
            const curSig=boxPixelSignature(frameCanvas,node._fabBox,displayed.width,displayed.height);
            if(isBoxVacant(node._fabSig,curSig)){
              node.style.opacity='0';
              node.style.pointerEvents='none';
            }
          }
        }
      }
      status.textContent='Scanning cards…';
      const result=await analyze(image,request);
      if(result?.error)throw Error(result.error);
      if(!root||!enabled||epoch!==heroEpoch||requestVideo!==video||requestPage!==location.href||Math.abs(video.currentTime-captureTime)>12)return;
      if(video.currentTime<lastTime-.5||video.currentTime-lastTime>8)tracks=[];
      if(updateHeroes(result)){tracks=[];pinned=false;panel.hidden=true;boxLayer.replaceChildren();displayed=null;lastTime=-1;return;}
      stabilize(result);render(result);
      lastTime=video.currentTime;lastSize=size;
      lastCount=result.boxes.length;updateStatus(result.catalog);
    }catch(error){status.textContent='Recognition unavailable';showError(error.message);console.warn('FaB Lens:',error);}
    finally{
      busy=false;activeRequest=null;
      if(enabled&&!document.hidden)scheduleTick(video?.paused?400:60);
    }
  }
  function selectedHeroes(){return heroSelections.map((v,i)=>v==='auto'?(heroAuto[i]?.name||null):v==='none'?null:v);}
  function heroRequest(){const r=videoRect();return {enabled:heroEnabled,axis:heroAxis,slots:selectedHeroes(),includeOptions:!heroOptions.length,autoSlots:heroSelections.map(v=>v==='auto'),sessionKey,epoch:heroEpoch,pointer:lastPointer?{x:(lastPointer.x-r.left)/r.width,y:(lastPointer.y-r.top)/r.height}:null};}
  function resetHeroes(all=false){
    heroAuto=[null,null];if(all){heroSelections=['none','none'];tipDismissed=false;}heroEpoch++;tracks=[];lastTime=-1;pinned=false;hoverName='';if(panel)panel.hidden=true;if(boxLayer)boxLayer.replaceChildren();displayed=null;
    refreshHeroes();
  }
  function heroChanged(){heroEpoch++;tracks=[];lastTime=-1;hoverName='';pinned=false;panel.hidden=true;boxLayer.replaceChildren();displayed=null;refreshHeroes();tick();}
  function refreshHeroes(){
    if(!heroButton)return;
    const sides=heroAxis==='x'?['Left','Right']:['Top','Bottom'],selected=selectedHeroes();
    if(heroTip)heroTip.hidden=!enabled||tipDismissed||heroPanel.hidden===false||!heroEnabled||selected.filter(Boolean).length===2;
    heroButton.title='Choose both heroes to improve card recognition';
    heroButton.textContent=heroEnabled?'Heroes ('+selected.filter(Boolean).length+'/2)':'Heroes: filter off';
    for(let i=0;i<2;i++){
      const select=heroSelects[i];heroLabels[i].textContent=sides[i];
      const auto=select.options[0];if(auto)auto.textContent=heroAuto[i]?.name?'Auto: '+heroAuto[i].name:heroSelections[i]==='auto'?'Auto: searching…':'Auto (optional)';
      select.value=heroSelections[i];select.setAttribute('aria-label','Hero '+sides[i].toLowerCase());
    }
  }
  function mountHeroes(){
    heroButton=el('button','fab-neural-hero-toggle','Heroes (0/2)');heroButton.hidden=true;heroButton.type='button';heroButton.setAttribute('aria-expanded','false');root.append(heroButton);
    heroPanel=el('div','fab-neural-heroes');heroPanel.hidden=true;heroPanel.id='fab-lens-heroes';heroPanel.setAttribute('role','region');heroPanel.setAttribute('aria-label','Match heroes');heroButton.setAttribute('aria-controls',heroPanel.id);root.append(heroPanel);
    heroButton.onclick=()=>{heroPanel.hidden=!heroPanel.hidden;heroButton.setAttribute('aria-expanded',String(!heroPanel.hidden));refreshHeroes();if(!heroPanel.hidden)heroSelects[0]?.focus();};
    heroTip=el('div','fab-neural-tip');heroTip.hidden=true;
    heroTip.append(el('strong','','Improve your matches'),el('p','','Choose both heroes to narrow down possible cards.'));
    button(heroTip,'Choose heroes',()=>heroButton.click());
    button(heroTip,'Dismiss',()=>{tipDismissed=true;refreshHeroes();}).className='fab-secondary';root.append(heroTip);
    const heading=el('strong','','Match heroes');heroPanel.append(heading);
    const enableLabel=el('label'),check=el('input');check.type='checkbox';check.checked=true;check.onchange=()=>{heroEnabled=check.checked;heroChanged();};enableLabel.append(check,document.createTextNode(' Filter by class and talents'));heroPanel.append(enableLabel);
    const layoutLabel=el('label','','Player layout'),layout=el('select');
    for(const [value,label] of [['x','Left / right'],['y','Top / bottom']]){const opt=el('option','',label);opt.value=value;layout.append(opt);}
    layout.onchange=()=>{heroAxis=layout.value;resetHeroes(true);tick();};layoutLabel.append(layout);heroPanel.append(layoutLabel);
    for(let i=0;i<2;i++){
      const label=el('label'),title=el('span'),select=el('select');heroLabels.push(title);heroSelects.push(select);
      for(const [value,text] of [['auto','Auto: searching…'],['none','Choose a hero… (no filter)']]){const opt=el('option','',text);opt.value=value;select.append(opt);}
      select.onchange=()=>{heroSelections[i]=select.value;heroChanged();};label.append(title,select);heroPanel.append(label);
    }
    button(heroPanel,'New match · reset heroes',()=>{resetHeroes(true);tick();});
    heroPanel.append(el('small','','Choose both heroes for more accurate matches. Cards incompatible with both heroes are excluded. Automatic selection is optional and may be incorrect.'));
    heroPanel.append(el('small','','Class and talent filter only. This does not check bans, formats or every special deck-building restriction.'));
    button(heroPanel,'Done',()=>{heroPanel.hidden=true;heroButton.setAttribute('aria-expanded','false');refreshHeroes();heroButton.focus();});
    refreshHeroes();
  }
  function updateHeroes(result){
    if(result.heroOptions?.length&&!heroOptions.length){
      heroOptions=result.heroOptions;
      for(const select of heroSelects)for(const h of heroOptions){const opt=el('option','',h.name+' — '+h.type);opt.value=h.name;select.append(opt);}
    }
    const before=selectedHeroes().join('|');
    heroAuto=heroAuto.map((state,i)=>heroSelections[i]==='auto'?globalThis.FabHeroContext.advanceAuto(state,result.heroObservations?.[i]||null,Date.now()):null);
    const changed=before!==selectedHeroes().join('|');
    if(changed){tracks=[];hoverName='';}
    refreshHeroes();return changed;
  }
  function updateStatus(catalog){
    if(!enabled)return;
    status.textContent=`${lastCount} cards detected`;
    status.title=catalog?`${catalog.indexed} visual references ready. Bundled catalogue; new cards arrive through extension updates.`:'';
  }
  function overlap(a,b){
    const x=Math.max(0,Math.min(a.x+a.w,b.x+b.w)-Math.max(a.x,b.x));
    const y=Math.max(0,Math.min(a.y+a.h,b.y+b.h)-Math.max(a.y,b.y));
    return x*y/(a.w*a.h+b.w*b.h-x*y||1);
  }
  function stabilize(result){
    const previous=tracks,used=new Set();tracks=[];
    for(const box of result.boxes){
      const place={x:box.x/result.width,y:box.y/result.height,w:box.w/result.width,h:box.h/result.height};
      let match=-1,best=.3;
      for(let i=0;i<previous.length;i++){
        if(used.has(i))continue;
        const score=overlap(place,previous[i].place);
        if(score>best){match=i;best=score;}
      }
      let samples=[];
      if(match>=0){
        used.add(match);
        const old=previous[match];
        if(box.top?.some(card=>old.samples[0].top?.some(earlier=>earlier.name===card.name)))samples=old.samples;
      }
      samples=[{top:box.top||[]},...samples].slice(0,3);
      const current=new Set((box.top||[]).map(card=>card.name)),votes=new Map();
      samples.forEach((sample,age)=>{
        for(const card of sample.top){
          if(!current.has(card.name))continue;
          const score=card.heroPriority??card.score,best=sample.top[0]?.heroPriority??sample.top[0]?.score??0;
          const weight=Math.pow(.7,age)*Math.exp(Math.max(-10,(score-best)/.05));
          const prior=votes.get(card.name);
          votes.set(card.name,{card:age===0||!prior?card:prior.card,weight:(prior?.weight||0)+weight});
        }
      });
      box.top=[...votes.values()].sort((a,b)=>b.weight-a.weight).map(item=>item.card);
      tracks.push({place,samples});
    }
  }
  function render(result){
    // Progress is an update, not a replacement by an incomplete table.
    // Retain old results only where this same frame is still being analyzed.
    const pending=result.pendingBoxes||[];
    const place=(b,r)=>({x:b.x/r.width,y:b.y/r.height,w:b.w/r.width,h:b.h/r.height});
    if(displayed&&pending.length){
      const extra=displayed.boxes.filter(old=>pending.some(b=>overlap(place(old,displayed),place(b,result))>.5)&&!result.boxes.some(b=>overlap(place(old,displayed),place(b,result))>.5));
      result={...result,boxes:[...result.boxes,...extra.map(b=>({...b,x:b.x/displayed.width*result.width,y:b.y/displayed.height*result.height,w:b.w/displayed.width*result.width,h:b.h/displayed.height*result.height}))]};
    }
    const r=videoRect(),previous=[...boxLayer.children],used=new Set();
    for(const box of result.boxes){
      const top=box.top?.[0],normalized=place(box,result);
      let node=previous.find(n=>!used.has(n)&&n._fabPlace&&overlap(n._fabPlace,normalized)>.5);
      if(!node){
        node=el('button');
        node.onfocus=()=>{if(!pinned)showMatch(node._fabBox,false);};
        node.onpointerenter=()=>{clearTimeout(hideTimer);if(!pinned)showMatch(node._fabBox,false);};
        node.onpointerleave=()=>{if(!pinned)hideTimer=setTimeout(()=>{if(!pinned){panel.hidden=true;hoverName='';}},220);};
        node.onclick=()=>{pinned=true;showMatch(node._fabBox,true);};boxLayer.append(node);
      }
      used.add(node);node._fabPlace=normalized;node._fabBox=box;
      node.className='fab-neural-box'+(box.certain?' certain':'');
      node.style.opacity='';node.style.pointerEvents='';
      node.style.left=r.left+normalized.x*r.width+'px';node.style.top=r.top+normalized.y*r.height+'px';
      node.style.width=normalized.w*r.width+'px';node.style.height=normalized.h*r.height+'px';
      node.title=top?top.name:'Detected card';node.setAttribute('aria-label',top?'Enlarge '+top.name:'View possible cards');
      if(frameCanvas&&result.width&&result.height){
        node._fabSig=boxPixelSignature(frameCanvas,box,result.width,result.height);
      }
    }
    for(const node of previous)if(!used.has(node))node.remove();
    displayed=result;
    preloadImages(result.boxes);
    if(lastPointer&&!pinned){
      const box=result.boxes.find(b=>{
        const x=r.left+b.x/result.width*r.width,y=r.top+b.y/result.height*r.height;
        return lastPointer.x>=x&&lastPointer.x<=x+b.w/result.width*r.width&&lastPointer.y>=y&&lastPointer.y<=y+b.h/result.height*r.height;
      });
      if(box){clearTimeout(hideTimer);showMatch(box,false);}
    }
  }
  function preloadImages(boxes){
    if(!boxes)return;
    for(const box of boxes){
      if(!box.top)continue;
      for(const card of box.top.slice(0,3)){
        if(card?.image&&!preloadedImages.has(card.image)){
          preloadedImages.add(card.image);
          const img=new Image();img.referrerPolicy='no-referrer';img.src=card.image;
          if(preloadedImages.size>200){
            const first=preloadedImages.values().next().value;
            preloadedImages.delete(first);
          }
        }
      }
    }
  }
  function mountPanelTemplate(){
    panel.replaceChildren();
    const header=el('div','fab-neural-header');
    panelHeading=el('strong','','');header.append(panelHeading);
    const controls=el('div','fab-neural-controls');
    button(controls,'−',()=>resizePanel(-80)).title='Make preview smaller';
    button(controls,'+',()=>resizePanel(80)).title='Enlarge ventana';
    button(controls,'×',()=>{panel.hidden=true;pinned=false;hoverName='';}).title='Close preview';
    header.append(controls);panel.append(header);
    header.onpointerdown=event=>{
      if(event.button!==0||event.target.closest('button'))return;
      pinned=true;const rect=panel.getBoundingClientRect(),dx=event.clientX-rect.left,dy=event.clientY-rect.top;
      header.setPointerCapture(event.pointerId);header.classList.add('dragging');event.preventDefault();
      header.onpointermove=move=>{
        if(!header.hasPointerCapture(move.pointerId))return;
        panel.style.left=Math.max(0,Math.min(innerWidth-panel.offsetWidth,move.clientX-dx))+'px';
        panel.style.top=Math.max(0,Math.min(innerHeight-panel.offsetHeight,move.clientY-dy))+'px';
      };
      header.onpointerup=header.onpointercancel=()=>header.classList.remove('dragging');
    };
    panelImage=el('img');panelImage.hidden=true;panelImage.decoding='async';panelImage.referrerPolicy='no-referrer';panelImage.onerror=()=>{panelNote.textContent='Card image could not load. Check your connection or try another match.';};
    panel.append(panelImage);
    panelAltBtn=button(panel,'Not this card?',()=>{});panelAltBtn.hidden=true;
    panelRetryBtn=button(panel,'Try again',()=>{panel.hidden=true;lastTime=-1;tick();});panelRetryBtn.hidden=true;
    panelNote=el('small','');panel.append(panelNote);
  }
  function resizePanel(delta){
    pinned=true;
    const width=Math.max(220,Math.min(innerWidth-16,Math.min(650,panel.offsetWidth+delta)));
    panel.style.width=width+'px';
    panel.style.left=Math.max(0,Math.min(parseFloat(panel.style.left)||0,innerWidth-width))+'px';
  }
  function showCandidate(candidates,index){
    const card=candidates[index];
    if(!card)return;
    if(!panelHeading)mountPanelTemplate();
    panel.hidden=false;
    panelHeading.textContent=card.name;
    if(panelImage.src!==card.image)panelImage.src=card.image;
    panelImage.alt=card.name;
    panelImage.hidden=false;
    if(candidates.length>1){
      panelAltBtn.hidden=false;
      panelAltBtn.onclick=()=>{pinned=true;showCandidate(candidates,(index+1)%candidates.length);};
    }else{
      panelAltBtn.hidden=true;
    }
    panelRetryBtn.hidden=true;
    panelNote.textContent='Drag the header to move. Use +, − or the bottom-right corner to resize. Press Esc to close.';
    panelNote.hidden=false;
  }
  function showMatch(box,fix=false){
    const top=box.top||[];
    const key=top.map(candidate=>candidate.name+'@'+candidate.image).join('|');
    if(!fix&&key===hoverName&&!panel.hidden)return;
    hoverName=key;
    if(top.length){showCandidate(top,0);return;}
    if(!panelHeading)mountPanelTemplate();
    panel.hidden=false;
    panelHeading.textContent='Card not identified';
    panelImage.hidden=true;
    panelAltBtn.hidden=true;
    panelRetryBtn.hidden=true;
    panelNote.textContent='No match is available for this image.';
    panelNote.hidden=false;
  }
  function showError(message){
    if(!panelHeading)mountPanelTemplate();
    panel.hidden=false;
    panelHeading.textContent='Recognition unavailable';
    panelImage.hidden=true;
    panelAltBtn.hidden=true;
    panelRetryBtn.hidden=false;
    panelNote.textContent=message;
    panelNote.hidden=false;
  }
  const watch=setInterval(()=>{if(!root&&pickVideo()){clearInterval(watch);mount();}},1000);
})();
