"""Bounded local libmpv event-order regression; this does not start CyberRoom.

Run from the repository root with 64-bit Python. MPV_DLL_DIR must contain the
same libmpv runtime used by the app. MEDIA_FIXTURE is a local media file longer
than 80 seconds; the standard local movie.mp4 fixture works. No URLs, account
credentials, user windows or remote servers are opened.

An older seek is allowed to complete without draining events, then a new seek
is sent. Completion requires its command acknowledgement, subsequent SEEK and
PLAYBACK_RESTART, and fresh asynchronous position/seeking replies.
"""
import ctypes as c,pathlib,time,json,os
class E(c.Structure):_fields_=[('id',c.c_int),('error',c.c_int),('tag',c.c_uint64),('data',c.c_void_p)]
class Prop(c.Structure):_fields_=[('name',c.c_char_p),('fmt',c.c_int),('data',c.c_void_p)]
lib=c.WinDLL(str((pathlib.Path(os.environ.get('MPV_DLL_DIR','server/target/msys-media-review/dlls'))/'libmpv-2.dll').resolve(strict=True)),winmode=0x900)
def bind(n,r,*a):f=getattr(lib,n);f.restype=r;f.argtypes=a;return f
create=bind('mpv_create',c.c_void_p);opt=bind('mpv_set_option_string',c.c_int,c.c_void_p,c.c_char_p,c.c_char_p);init=bind('mpv_initialize',c.c_int,c.c_void_p);cmd=bind('mpv_command_async',c.c_int,c.c_void_p,c.c_uint64,c.POINTER(c.c_char_p));wait=bind('mpv_wait_event',c.POINTER(E),c.c_void_p,c.c_double);observe=bind('mpv_observe_property',c.c_int,c.c_void_p,c.c_uint64,c.c_char_p,c.c_int);query=bind('mpv_get_property_async',c.c_int,c.c_void_p,c.c_uint64,c.c_char_p,c.c_int);destroy=bind('mpv_terminate_destroy',None,c.c_void_p)
h=create()
for k,v in {'config':'no','terminal':'no','msg-level':'all=no','load-scripts':'no','vo':'null','ao':'null','idle':'yes','keep-open':'yes','pause':'yes','title':'赛博房间播放器'}.items():assert opt(h,k.encode(),v.encode())>=0
assert init(h)>=0
for name,fmt in [('time-pos',5),('seeking',3),('audio-codec-name',1),('pause',3)]:observe(h,0,name.encode(),fmt)
def command(tag,*args):assert cmd(h,tag,(c.c_char_p*(len(args)+1))(*[a.encode() for a in args],None))>=0
cache={};trace=[];base=time.monotonic()
def drain():
 out=[]
 while True:
  e=wait(h,0).contents
  if e.id==0:break
  row={'ms':round((time.monotonic()-base)*1000,1),'event':e.id}
  if e.id==5:row.update(tag=e.tag,error=e.error)
  if e.id in [3,22] and e.data:
   p=c.cast(e.data,c.POINTER(Prop)).contents;name=p.name.decode();value=None
   if p.data:
    if p.fmt==5:value=c.cast(p.data,c.POINTER(c.c_double))[0]
    elif p.fmt==3:value=bool(c.cast(p.data,c.POINTER(c.c_int))[0])
    elif p.fmt==1:value=c.cast(p.data,c.POINTER(c.c_char_p))[0].decode()
   cache[name]=value;row.update(property=name,value=value,tag=e.tag)
  if e.id in [3,5,20,21,22]:out.append(row)
 return out
try:
 command(100,'loadfile',str(pathlib.Path(os.environ.get('MEDIA_FIXTURE','server/target/watch-fixtures/movie.mp4')).resolve(strict=True)),'replace')
 deadline=time.monotonic()+5
 while time.monotonic()<deadline:
  events=drain()
  if any(e['event']==21 for e in events):break
  time.sleep(.02)
 results=[]
 for n in range(24):
  old,new=1000+n*2,1001+n*2
  command(old,'seek','80','absolute+exact');time.sleep(.2)
  # Same ordering as Player.command() followed by events(): the old completion
  # was left in mpv's queue while a newer operation replaces our local state.
  command(new,'seek','15','absolute+exact')
  flags={'ack':False,'seek':False,'restart':False};samples=[];snapshot={};requested=False
  for tick in range(120):
   events=drain();trace.extend(events)
   for e in events:
    if e['event']==5 and e['tag']==new:flags.update(ack=True,seek=False,restart=False)
    elif e['event']==20 and flags['ack']:flags.update(seek=True,restart=False)
    elif e['event']==21 and flags['ack'] and flags['seek']:flags['restart']=True
    elif e['event']==3 and e['tag']==new+10000:snapshot[e['property']]=e['value']
   if all(flags.values()) and not requested:
    for name,fmt in [('time-pos',5),('seeking',3)]:assert query(h,new+10000,name.encode(),fmt)>=0
    requested=True
   complete=all(flags.values()) and snapshot.get('seeking') is False and snapshot.get('time-pos') is not None
   if complete:samples.append({'tick':tick,'position':snapshot.get('time-pos'),'flags':flags.copy()});break
   time.sleep(.005)
  results.append({'iteration':n,'completed':samples})
 assert all(r['completed'] and abs(r['completed'][0]['position']-15)<.1 for r in results),results
 print(json.dumps({'harnessOnly':True,'fixedAlgorithm':True,'iterations':len(results),'correctConfirmations':len(results),'confirmedPositions':[r['completed'][0]['position'] for r in results], 'eventSequenceSample':[{'event':e['event'],**({'tag':e['tag']} if 'tag' in e else {}),**({'property':e['property'],'value':e['value']} if 'property' in e else {})} for e in trace[:12]]}))
finally:destroy(h)
