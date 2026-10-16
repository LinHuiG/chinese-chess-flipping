// Only immutable, signed artifact hashes name checkpoints. Never publish a partial package.
export async function downloadPackage(url,artifact,store,progress=()=>{}){
  const key='partial:'+artifact.sha256,saved=await store.get('state',key);
  let blob=saved instanceof Blob&&saved.size<=artifact.size?saved:new Blob(),size=blob.size;
  progress(size,artifact.size);
  if(size===artifact.size)return blob.text();
  const response=await fetch(url,{cache:'no-store',redirect:'error',headers:size?{Range:`bytes=${size}-`}:{},signal:AbortSignal.timeout(150000)});
  if(response.status===206){
    const range=/^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range')||'');
    if(!range||+range[1]!==size||+range[2]!==artifact.size-1||+range[3]!==artifact.size){await store.put('state',key,null);throw Error('插件续传范围无效，请重试');}
  }else if(response.status===200){blob=new Blob();size=0;}
  else throw Error('插件下载失败：'+response.status+'，重试可继续下载');
  if(Number(response.headers.get('content-length'))>artifact.size-size)throw Error('插件文件大小异常');
  const reader=response.body.getReader();let chunks=[],pending=0,last=performance.now(),invalid=false;
  async function checkpoint(){if(!pending)return;blob=new Blob([blob,...chunks]);chunks=[];pending=0;await store.put('state',key,blob);last=performance.now();}
  try{
    while(true){const {done,value}=await reader.read();if(done)break;if(size+value.length>artifact.size){invalid=true;throw Error('插件文件超过声明大小');}chunks.push(value);size+=value.length;pending+=value.length;progress(size,artifact.size);if(pending>=524288||performance.now()-last>500)await checkpoint();}
  }finally{await reader.cancel().catch(()=>{});if(invalid)await store.put('state',key,null);else await checkpoint();}
  if(size!==artifact.size)throw Error('插件下载中断，重试可继续下载');
  return new TextDecoder('utf-8',{fatal:true}).decode(await blob.arrayBuffer());
}
