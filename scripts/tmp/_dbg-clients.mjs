// Diagnostica: per OGNI client youtubei.js risolve lo stream audio e verifica
// con una Range request se googlevideo risponde 200/206 o 403.
import { execSync } from 'child_process';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sh = (c, i = false) => { try { return execSync(c, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim(); } catch (e) { if (i) return ''; throw e; } };
const ADB = process.env.ADB ?? 'adb';
const dev = sh(`${ADB} devices`).split('\n').slice(1).map((l) => l.split('\t')).find(([id, st]) => id && st === 'device');
if (!dev) { console.log('no device'); process.exit(1); }
const A = `${ADB} -s ${dev[0]}`;
sh(`${A} shell monkey -p com.masterhype.app -c android.intent.category.LAUNCHER 1`, true);
await sleep(2000);
let pid = sh(`${A} shell pidof com.masterhype.app`, true);
sh(`${A} forward tcp:9229 localabstract:webview_devtools_remote_${pid}`, true);
const pages = await (await fetch('http://127.0.0.1:9229/json')).json();
const page = pages.find((p) => p.type === 'page' && p.url.includes('localhost'));
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0; const pend = new Map();
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); } };
const ev = async (e, timeout = 120_000) => {
  const i = ++id;
  const r = await new Promise((res) => { pend.set(i, res); ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression: e, awaitPromise: true, returnByValue: true, timeout } })); });
  const v = r.result?.result;
  if (v && v.value !== undefined) return v.value;
  if (r.result?.exceptionDetails) return 'ERR: ' + (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text);
  return JSON.stringify(r.result).slice(0, 300);
};

// trova il nome reale del chunk youtubei.js (web-*.js) tra le risorse caricate
const chunk = await ev(`(performance.getEntriesByType('resource').map(r=>r.name.split('/').pop()).find(n=>/^web-.*\\.js$/.test(n))) || 'NESSUNO — direct mai caricato'`);
console.log('chunk yt:', chunk);

const res = await ev(`(async()=>{
  const H = Capacitor.Plugins.CapacitorHttp;
  const get = async (u) => { const r = await H.request({url:u, method:'GET', headers:{Range:'bytes=0-0'}, responseType:'arraybuffer', connectTimeout:15000, readTimeout:15000}); return r.status; };
  const d = await import('/assets/${chunk}');
  const yt = await d.Innertube.create({ fetch: (input,init)=>{ 
      const url = typeof input==='string'?input:(input.url??String(input));
      const method = (init?.method ?? (typeof input==='object'?input.method:'GET')??'GET').toUpperCase();
      const headers = {...(init?.headers?Object.fromEntries(new Headers(init.headers).entries()):{})};
      delete headers['accept-encoding'];
      return H.request({url,method,headers,data:init?.body,responseType:'arraybuffer',connectTimeout:15000,readTimeout:60000}).then(r=>{
        const ct=String(Object.entries(r.headers??{}).find(([k])=>k.toLowerCase()==='content-type')?.[1]??'');
        const enc=new TextEncoder(); let body=null;
        if(typeof r.data==='string'){ if(ct.includes('json')||r.status>=400) body=enc.encode(r.data); else { try{const b=atob(r.data);const by=new Uint8Array(b.length);for(let i=0;i<b.length;i++)by[i]=b.charCodeAt(i);body=by.buffer;}catch{body=enc.encode(r.data);} } }
        else if(r.data!=null) body=enc.encode(JSON.stringify(r.data));
        const st=r.status>=200&&r.status<600?r.status:599;
        if(st===204||st===205||st===304) body=null;
        return new Response(body,{status:st,headers:r.headers});
      });
    }, generate_session_locally:true, retrieve_player:true, lang:'it', location:'IT' });
  const out = [];
  for (const c of ['ANDROID','YTMUSIC_ANDROID','ANDROID_MUSIC','IOS','TV_EMBEDDED','WEB_EMBEDDED','WEB','MWEB']) {
    try {
      const info = await yt.getBasicInfo('9RfVp-GhKfs', { client: c });
      const fmts = [...(info?.streaming_data?.adaptive_formats ?? []), ...(info?.streaming_data?.formats ?? [])];
      const aud = fmts.filter(f=>f.has_audio && !f.has_video).sort((a,b)=>(b.bitrate??0)-(a.bitrate??0));
      if (!aud.length) { out.push({c, err:'no audio fmt', n:fmts.length, ps:String(info?.playability_status?.status)}); continue; }
      let u = aud[0].url;
      if (typeof u !== 'string' || !u) u = await aud[0].decipher(yt.session.player).catch(()=>null);
      if (!u) { out.push({c, err:'no url', n:aud.length}); continue; }
      const st = await get(u).catch(e=>'ERR '+String(e).slice(0,60));
      out.push({c, status: st, n:aud.length, itag:aud[0].itag});
    } catch(e) { out.push({c, err: String(e).slice(0,140)}); }
  }
  return out;
})()`, 180_000);
console.log(JSON.stringify(res, null, 1));
ws.close();
