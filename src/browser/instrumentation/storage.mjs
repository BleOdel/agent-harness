/** Enumerate origin storage through browser APIs; reject unsupported/oversized values. */
export async function observeStorage(page){const result=await page.evaluate(async()=>{
 const bound=(v,n)=>{if(v>n)throw Error('Browser storage observation exceeds its bound.');};
 let nodes=0;
 const encode=v=>{
  bound(++nodes,20000);
  if(v===null||['string','number','boolean','undefined'].includes(typeof v))return v;
  if(v instanceof ArrayBuffer||ArrayBuffer.isView(v)){const bytes=v instanceof ArrayBuffer?new Uint8Array(v):new Uint8Array(v.buffer,v.byteOffset,v.byteLength);bound(bytes.length,65536);return {utf8:new TextDecoder().decode(bytes),base64:btoa(String.fromCharCode(...bytes))};}
  if(v instanceof Date)return v.toISOString();
  if(Array.isArray(v))return v.map(encode);
  if(v instanceof Map)return [...v].map(([k,value])=>[encode(k),encode(value)]);
  if(v instanceof Set)return [...v].map(encode);
  if(typeof v==='object'&&Object.getPrototypeOf(v)===Object.prototype)return Object.fromEntries(Object.entries(v).map(([k,value])=>[k,encode(value)]));
  throw Error('Unsupported browser storage value; privacy observation is incomplete.');
 };
 const serialized=v=>{const text=JSON.stringify(encode(v));bound(text.length,65536);return text;};
 const entries=s=>{bound(s.length,200);return Array.from({length:s.length},(_,i)=>{const k=s.key(i),v=s.getItem(k);bound(k.length,65536);bound(v.length,65536);return [k,v];});};
 const databases=[],cache=[];
 const catalog=await indexedDB.databases();bound(catalog.length,20);
 for(const info of catalog){
  if(!info.name)throw Error('Unnamed database cannot be inspected.');
  const db=await new Promise((resolve,reject)=>{const r=indexedDB.open(info.name);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(Error('Cannot inspect IndexedDB.'));r.onupgradeneeded=()=>{r.transaction.abort();reject(Error('IndexedDB changed during inspection.'));};r.onblocked=()=>reject(Error('IndexedDB inspection blocked.'));});
  try{const stores=[...db.objectStoreNames];bound(stores.length,50);
   for(const name of stores){const records=await new Promise((resolve,reject)=>{const tx=db.transaction(name,'readonly'),store=tx.objectStore(name),rows=[];const cursor=store.openCursor();cursor.onerror=()=>reject(Error('IndexedDB read failed.'));tx.onabort=()=>reject(Error('IndexedDB read aborted.'));cursor.onsuccess=()=>{const c=cursor.result;if(!c){resolve(rows);return;}try{bound(rows.length,199);rows.push([serialized(c.key),serialized(c.value)]);c.continue();}catch(e){tx.abort();reject(e);}};});databases.push([info.name+'/'+name,JSON.stringify(records)]);}
  }finally{db.close();}
 }
 const names=await caches.keys();bound(names.length,20);
 for(const name of names){const store=await caches.open(name),requests=await store.keys();bound(requests.length,200);
  for(const request of requests){const response=await store.match(request);if(!response||response.type==='opaque')throw Error('Cache entry cannot be inspected.');const reader=response.body?.getReader();let size=0;const chunks=[];
   try{if(reader)for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;bound(size,65536);chunks.push(value);}}finally{await reader?.cancel();}
   const bytes=new Uint8Array(size);let at=0;for(const chunk of chunks){bytes.set(chunk,at);at+=chunk.length;}
   cache.push([name+'/'+request.method+' '+request.url,serialized({requestHeaders:[...request.headers],responseHeaders:[...response.headers],body:bytes})]);
  }
 }
 return {local:entries(localStorage),session:entries(sessionStorage),databases,cache};
});const cookies=await page.context().cookies();if(cookies.length>200)throw Error('Cookie observation exceeds its bound.');return {...result,cookies:cookies.map(c=>[c.domain+c.path+' '+c.name,c.value])};}
