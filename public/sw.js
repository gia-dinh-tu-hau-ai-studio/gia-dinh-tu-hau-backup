const CACHE="tu-hau-shell-v4";
const OFFLINE_PAGE="/";
const SHELL=["/manifest.webmanifest","/logo-transparent.png"];
self.addEventListener("install",event=>{self.skipWaiting();event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(SHELL)));});
self.addEventListener("activate",event=>event.waitUntil(Promise.all([caches.keys().then(keys=>Promise.all(keys.filter(key=>key!==CACHE).map(key=>caches.delete(key)))),self.clients.claim()])));
self.addEventListener("fetch",event=>{
  const request=event.request;
  if(request.method!=="GET")return;
  const url=new URL(request.url);
  if(url.origin!==self.location.origin)return;
  if(request.mode==="navigate"){
    event.respondWith(fetch(request).then(async response=>{
      if(response.ok){
        const copy=response.clone();
        const html=await copy.text();
        if(!html.includes("/@vite/client")&&!html.includes("@vite/client")){
          const cache=await caches.open(CACHE);
          await cache.put(OFFLINE_PAGE,response.clone());
        }
      }
      return response;
    }).catch(async()=>await caches.match(OFFLINE_PAGE)||Response.error()));
    return;
  }
  event.respondWith(caches.match(request).then(cached=>cached||fetch(request).then(response=>{if(response.ok){const copy=response.clone();caches.open(CACHE).then(cache=>cache.put(request,copy));}return response;})));
});
