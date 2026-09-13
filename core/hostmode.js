// Pure host-mode helpers (in-app LAN server): config sanitizing, LAN URL
// listing, pair-URL building. No DOM, no IO — os.networkInterfaces() output is
// passed in. UMD: Node (module.exports) + browser (window.CoreHostMode).
function hostConfigView(cfg){
  cfg = cfg || {};
  const mode = (cfg.mode === 'family') ? 'family' : 'mirror';
  const port = parseInt(cfg.port, 10);
  return { enabled: !!cfg.enabled, mode, port: (port > 0 && port < 65536) ? port : 4321 };
}

// interfaces = os.networkInterfaces() shape: { name: [{address, family, internal}] }.
// Returns IPv4 non-internal URLs, home ranges first (192.168.x, then 10.x).
function lanUrls(interfaces, port){
  const out = [];
  const ifs = (interfaces && typeof interfaces === 'object') ? interfaces : {};
  for (const name of Object.keys(ifs)) {
    for (const a of (Array.isArray(ifs[name]) ? ifs[name] : [])) {
      if (!a || a.internal || a.family !== 'IPv4') continue;
      out.push('http://' + a.address + ':' + port);
    }
  }
  const rank = (u) => u.indexOf('http://192.168.') === 0 ? 0 : (u.indexOf('http://10.') === 0 ? 1 : 2);
  return out.sort((a, b) => rank(a) - rank(b));
}

function pairUrl(baseUrl, token){
  const b = String(baseUrl || '').replace(/\/+$/, '');
  return b ? b + '/?pair=' + encodeURIComponent(String(token || '')) : '';
}
if (typeof module!=='undefined'&&module.exports) module.exports={hostConfigView,lanUrls,pairUrl};
if (typeof window!=='undefined') window.CoreHostMode={hostConfigView,lanUrls,pairUrl};
