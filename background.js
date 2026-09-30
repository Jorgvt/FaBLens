let creating;
async function ensureEngine() {
  if(creating)return creating;
  creating=(async()=>{
    const url=chrome.runtime.getURL('engine.html');
    const contexts=await chrome.runtime.getContexts({contextTypes:['OFFSCREEN_DOCUMENT'],documentUrls:[url]});
    if(!contexts.length)await chrome.offscreen.createDocument({url:'engine.html',reasons:['WORKERS'],justification:'Analyze video frames locally to identify cards'});
  })().finally(()=>{creating=null;});
  return creating;
}
chrome.action.onClicked.addListener(async tab=>{
  if(!tab.id||!/^https:\/\/(?:www\.)?(?:youtube\.com|twitch\.tv)\//.test(tab.url||''))return;
  try{await chrome.tabs.sendMessage(tab.id,{type:'FAB_TOGGLE'});}catch(error){console.warn('FaB Lens:',error);}
});
chrome.runtime.onMessage.addListener((message,sender,respond)=>{
  if(message?.type==='FAB_PROGRESS'&&sender.url===chrome.runtime.getURL('engine.html')&&Number.isInteger(message.targetTabId)){
    chrome.tabs.sendMessage(message.targetTabId,{type:'FAB_PROGRESS',requestId:message.requestId,result:message.result}).then(()=>respond({ok:true})).catch(()=>respond({ok:false}));return true;
  }
  if(message?.type==='FAB_HELP'&&sender.tab){chrome.tabs.create({url:chrome.runtime.getURL('help.html')}).then(()=>respond({ok:true}));return true;}
  if(message?.type==='FAB_CAPTURE'&&sender.tab?.windowId){
    chrome.tabs.captureVisibleTab(sender.tab.windowId,{format:'jpeg',quality:88},data=>respond({data,error:chrome.runtime.lastError?.message}));return true;
  }
  if(message?.type==='FAB_ENGINE_READY'){
    ensureEngine().then(()=>respond({ok:true})).catch(e=>respond({error:e.message}));return true;
  }
});
