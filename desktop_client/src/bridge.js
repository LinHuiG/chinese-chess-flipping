(() => {
  const call = (method, ...args) => window.__TAURI_INTERNALS__.invoke('native_call', {method, args});
  // Element fullscreen alone only fills WebView2. Keep the host window in the
  // same state, including Escape and room teardown, in event order.
  let fullscreenChange = Promise.resolve();
  document.addEventListener('fullscreenchange', () => {
    const enabled = !!document.fullscreenElement;
    fullscreenChange = fullscreenChange.then(() => call('windowFullscreen', enabled)).catch(async error => {
      console.error('Windows fullscreen:', error);
      if (document.fullscreenElement) await document.exitFullscreen().catch(() => {});
    });
  });
  let settings = __CYBER_SETTINGS__;
  let saveQueue = Promise.resolve();
  const saveCall = (method, ...args) => {
    const next = saveQueue.then(() => call(method, ...args));
    saveQueue = next.catch(() => {});
    return next;
  };
  window.NativeRoom = {
    platform: 'WINDOWS',
    settings: () => JSON.stringify(settings),
    configure: async text => {const result=await call('configure',text);settings=JSON.parse(result);return true;},
    connect: identity => call('connect',identity),
    disconnect: () => call('disconnect'),
    send: data => call('send',data),
    udpRegister: (id,ticket,port) => call('udpRegister',id,ticket,port),
    openPeer: config => call('openPeer',config),
    sendPeer: (id,data) => call('sendPeer',id,data),
    closePeers: () => call('closePeers'),
    roomActive: name => call('roomActive',name),
    watchSaveRead: () => saveCall('watchSaveRead'),
    watchSaveWrite: text => saveCall('watchSaveWrite',text),
    voiceConfigure: config => call('voiceConfigure',config),
    voiceMicrophone: enabled => call('voiceMicrophone',enabled),
    voiceStop: () => call('voiceStop'),
    mediaConfigure: config => call('mediaConfigure',config),
    mediaRequest: request => call('mediaRequest',request),
    playerCapabilities: {engine:'mpv',embeddedTracks:true},
    playerCommand: command => call('playerCommand',command),
    playerStop: () => call('playerStop'),
    checkUpdate: () => call('checkUpdate'),
    installUpdate: () => call('checkUpdate'),
    exitApp: () => call('exitApp')
  };
})();
