let database;
function openDatabase(){
  if(!database)database=new Promise((resolve,reject)=>{
    const request=indexedDB.open('fab-lens-catalog-v1',1);
    request.onupgradeneeded=()=>request.result.createObjectStore('vectors',{keyPath:'url'});
    request.onsuccess=()=>resolve(request.result);
    request.onerror=()=>reject(request.error);
  });
  return database;
}
export async function readCachedReferences(){
  const db=await openDatabase();
  return new Promise((resolve,reject)=>{
    const request=db.transaction('vectors','readonly').objectStore('vectors').getAll();
    request.onsuccess=()=>resolve(request.result);
    request.onerror=()=>reject(request.error);
  });
}
export async function saveCachedReferences(references){
  const db=await openDatabase();
  await new Promise((resolve,reject)=>{
    const transaction=db.transaction('vectors','readwrite');
    const store=transaction.objectStore('vectors');
    for(const reference of references)store.put(reference);
    transaction.oncomplete=()=>resolve();
    transaction.onerror=()=>reject(transaction.error);
    transaction.onabort=()=>reject(transaction.error);
  });
}
