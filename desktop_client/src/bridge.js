(() => {
  const call = (method, ...args) => window.__TAURI_INTERNALS__.invoke('native_call', {method, args});
  let settings = __CYBER_SETTINGS__;
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
    voiceConfigure: config => call('voiceConfigure',config),
    voiceMicrophone: enabled => call('voiceMicrophone',enabled),
    voiceStop: () => call('voiceStop'),
    mediaConfigure: config => call('mediaConfigure',config),
    mediaRequest: request => call('mediaRequest',request),
    checkUpdate: () => call('checkUpdate'),
    installUpdate: () => call('checkUpdate'),
    exitApp: () => call('exitApp')
  };
})();
