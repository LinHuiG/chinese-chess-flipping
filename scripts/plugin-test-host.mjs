// In-memory host used by rule/lifecycle unit tests; browser tests exercise the real port boundary.
globalThis.__CYBER_TEST_BOOTSTRAP__={get native(){return globalThis.NativeRoom;},platform:'web',connectionKey:'cyber.identity.test',assets:{'voice-worklet.js':'data:text/javascript,'},invoke(){return true;},storage:new Proxy({}, {
  has:(_,key)=>globalThis.localStorage?.getItem(key)!=null,
  get:(_,key)=>{const value=globalThis.localStorage?.getItem(key);return value==null?undefined:JSON.parse(value);},
  set:(_,key,value)=>{globalThis.localStorage?.setItem(key,JSON.stringify(value));return true;}
})};
globalThis.dispatchEvent??=()=>{};
globalThis.CustomEvent??=class{constructor(type,options){this.type=type;this.detail=options?.detail;}};
// Legacy HTTP fixtures become real Response streams, matching bounded production reads.
let fixtureFetch=globalThis.fetch;
Object.defineProperty(globalThis,'fetch',{configurable:true,get(){return fixtureFetch;},set(fn){fixtureFetch=async(...args)=>{const response=await fn(...args);return response&&!(response instanceof Response)&&typeof response.text==='function'&&!response.body?new Response(await response.text(),{status:response.status||200,headers:response.headers}):response;};}});
