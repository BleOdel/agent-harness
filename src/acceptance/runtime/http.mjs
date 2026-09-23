/** Host-owned observations: never follow redirects or discard response headers. */
export async function observeHttp(url, options = {}) {
 const {timeoutMs=5000,maxBytes=1024*1024,redirect,signal,...request}=options;
 if(redirect!==undefined&&redirect!=='manual')throw Error('HTTP checks require redirect: manual.');
 for(const [name,value] of Object.entries({timeoutMs,maxBytes}))if(!Number.isInteger(value)||value<1)throw Error(`Invalid ${name}.`);
 const timeout=AbortSignal.timeout(timeoutMs);
 const response=await fetch(url,{...request,redirect:'manual',signal:signal?AbortSignal.any([signal,timeout]):timeout});
 const chunks=[];let size=0;const reader=response.body?.getReader();
 try {if(reader)for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>maxBytes)throw Error('HTTP response exceeds byte limit.');chunks.push(Buffer.from(value));}}
 catch(error){await reader?.cancel().catch(()=>{});throw error;}
 finally {reader?.releaseLock();}
 return {url:response.url,status:response.status,headers:Object.fromEntries(response.headers),text:Buffer.concat(chunks).toString('utf8')};
}
/** Positive JSON requests; use observeHttp for missing/wrong-header and malformed-body probes. */
export async function observeJson(url, options = {}) {
 const {json,...request}=options,method=(request.method??'GET').toUpperCase();
 const headers=new Headers(request.headers);
 if(['POST','PUT','PATCH','DELETE'].includes(method)){
  if(!headers.has('Origin'))headers.set('Origin',new URL(url).origin);
  if(!headers.has('Content-Type'))headers.set('Content-Type','application/json');
 }
 if(Object.hasOwn(options,'json')){
  if(Object.hasOwn(request,'body'))throw Error('Use json or body, not both.');
  request.body=JSON.stringify(json);if(!headers.has('Content-Type'))headers.set('Content-Type','application/json');
 }
 const observation=await observeHttp(url,{...request,method,headers});
 if(!/^application\/(?:[\w!#$&^_.+-]+\+)?json\s*(?:;|$)/i.test(observation.headers['content-type']??''))throw Error('Expected a JSON content type.');
 return {...observation,data:JSON.parse(observation.text)};
}
