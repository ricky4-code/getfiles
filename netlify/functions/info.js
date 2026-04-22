// GetFiles – /.netlify/functions/info
// Node.js 18 – TikTok via tikwm, Twitter via fxtwitter, YouTube/FB/IG via yt-dlp

const https   = require('https');
const http    = require('http');
const { execFile } = require('child_process');
const fs      = require('fs');
const path    = require('path');

const CORS = {
  'Access-Control-Allow-Origin' : '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};
const ok  = d    => ({ statusCode:200, headers:CORS, body:JSON.stringify(d) });
const err = (m,s=400) => ({ statusCode:s, headers:CORS, body:JSON.stringify({error:m}) });


function detectPlatform(url) {
  const u = url.toLowerCase();
  if (/youtu\.be|youtube\.com/.test(u))  return 'youtube';
  if (/instagram\.com/.test(u))           return 'instagram';
  if (/tiktok\.com/.test(u))              return 'tiktok';
  if (/twitter\.com|x\.com/.test(u))      return 'twitter';
  if (/facebook\.com|fb\.watch/.test(u))  return 'facebook';
  return null;
}

function fmtDuration(sec) {
  if (!sec) return '';
  sec = parseInt(sec);
  const h=Math.floor(sec/3600), m=Math.floor((sec%3600)/60), s=sec%60;
  return h ? `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}` : `${m}:${String(s).padStart(2,'0')}`;
}
function fmtSize(b) {
  if (!b) return 'Variable';
  const mb=b/1048576;
  return mb>=1024 ? `${(mb/1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}

function fetchJSON(urlStr, opts={}) {
  return new Promise((resolve,reject) => {
    const u   = new URL(urlStr);
    const lib = u.protocol==='https:' ? https : http;
    const req = lib.request({
      hostname: u.hostname,
      path    : u.pathname+u.search,
      method  : opts.method||'GET',
      headers : { 'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 'Accept':'application/json', ...(opts.headers||{}) },
    }, res => {
      let data='';
      res.on('data',c=>data+=c);
      res.on('end',()=>{ try{resolve(JSON.parse(data))}catch(e){reject(new Error('Bad JSON from '+u.hostname+': '+data.slice(0,100)))} });
    });
    req.setTimeout(opts.timeout||15000,()=>{req.destroy();reject(new Error('Timeout: '+u.hostname));});
    req.on('error',reject);
    req.end();
  });
}

// TikTok
async function handleTikTok(url) {
  const data = await fetchJSON(`https://www.tikwm.com/api/?url=${encodeURIComponent(url)}&hd=1`);
  if (!data||data.code!==0) throw new Error(data?.msg||'TikTok API error');
  const v=data.data, qualities=[];
  if(v.hdplay) qualities.push({label:'HD – No Watermark',badge:'NWM',size:fmtSize(v.hd_size),ext:'mp4',url:v.hdplay});
  if(v.play)   qualities.push({label:'SD – No Watermark',badge:'NWM',size:fmtSize(v.size),   ext:'mp4',url:v.play});
  if(v.wmplay) qualities.push({label:'With Watermark',   badge:'',   size:'Variable',          ext:'mp4',url:v.wmplay});
  if(v.music)  qualities.push({label:'Audio MP3',        badge:'HQ', size:'Variable',          ext:'mp3',url:v.music,isAudio:true});
  return {platform:'tiktok',title:v.title||'TikTok Video',author:v.author?.nickname||'',duration:fmtDuration(v.duration),thumb:v.cover||v.origin_cover||'',qualities};
}

// Twitter/X
async function handleTwitter(url) {
  const clean=url.replace('x.com','twitter.com').replace(/\?.*$/,'');
  const data=await fetchJSON(clean.replace('twitter.com','api.fxtwitter.com'));
  const tweet=data?.tweet;
  if(!tweet) throw new Error('Tweet not found or account is private');
  const media=tweet.media||{}; let thumb=''; const qualities=[];
  for(const vid of (media.videos||[])) {
    thumb=thumb||vid.thumbnail_url||'';
    const variants=(vid.variants||[]).filter(v=>v.src&&!v.src.endsWith('.m3u8')).sort((a,b)=>(b.bitrate||0)-(a.bitrate||0));
    for(const vr of variants){ const m=vr.src.match(/\/(\d+)x\d+\//),h=m?parseInt(m[1]):0; qualities.push({label:h?`${h}p`:'Video',badge:h>=1080?'FHD':h>=720?'HD':'',size:'Variable',ext:'mp4',url:vr.src}); }
  }
  for(const [i,p] of (media.photos||[]).entries()) { if(p.url){thumb=thumb||p.url; qualities.push({label:`Photo ${i+1}`,badge:'IMG',size:'Variable',ext:'jpg',url:p.url+'?name=orig'});} }
  if(!qualities.length) throw new Error('No downloadable media found in this tweet');
  return {platform:'twitter',title:(tweet.text||'Twitter/X Post').slice(0,100),author:tweet.author?.name||'',duration:'',thumb,qualities};
}

// yt-dlp – find binary
function findYtDlp() {
  const locations = [
    path.join('/var/task/node_modules/yt-dlp-exec/bin/yt-dlp'),
    path.join('/var/task/node_modules/yt-dlp-exec/bin/yt-dlp.exe'),
    '/opt/buildhome/.local/bin/yt-dlp',
    '/usr/local/bin/yt-dlp',
    '/usr/bin/yt-dlp',
  ];
  for(const loc of locations) {
    try { if(fs.existsSync(loc)){ console.log('[yt-dlp] found at',loc); return loc; } } catch(_){}
  }
  // Try require
  try {
    const pkg = require('yt-dlp-exec');
    const p   = pkg.ytDlpPath || (pkg.default && pkg.default.ytDlpPath);
    if(p && fs.existsSync(p)){ console.log('[yt-dlp] from package:',p); return p; }
  } catch(_){}
  console.log('[yt-dlp] falling back to PATH');
  return 'yt-dlp';
}

function runYtDlp(url) {
  return new Promise((resolve,reject)=>{
    const bin  = findYtDlp();
    const args = [url,'--dump-json','--no-playlist','--no-warnings','-q','--socket-timeout','20','--no-check-certificates','--http-header','User-Agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0'];
    console.log('[GetFiles] execFile:', bin, url.slice(0,60));
    execFile(bin, args, {timeout:50000, maxBuffer:15*1024*1024, env:{...process.env,HOME:'/tmp',TMPDIR:'/tmp'}}, (error,stdout,stderr)=>{
      if(error){
        const lines=(stderr||error.message||'').split('\n');
        const line =lines.find(l=>l.includes('ERROR:')||l.includes('error:'))||lines[0]||error.message;
        return reject(new Error(line.replace(/^\[.*?\]\s*/,'').trim().slice(0,200)));
      }
      const first=(stdout||'').trim().split('\n')[0];
      if(!first) return reject(new Error('yt-dlp returned no output – URL may be unsupported'));
      try{resolve(JSON.parse(first))}catch{reject(new Error('Could not parse yt-dlp output'));}
    });
  });
}

async function handleYtDlp(url, platform) {
  const info=await runYtDlp(url);
  const title=info.title||'Video', uploader=info.uploader||info.channel||'', duration=fmtDuration(info.duration), formats=info.formats||[];
  let thumb=info.thumbnail||'';
  if(info.thumbnails?.length){ const b=info.thumbnails.filter(t=>t.url).sort((a,b)=>((b.width||0)*(b.height||0))-((a.width||0)*(a.height||0)))[0]; if(b?.url)thumb=b.url; }
  const qualities=[];

  if(platform==='youtube'){
    const af=formats.filter(f=>f.vcodec==='none'&&f.acodec!=='none'&&f.url&&!f.url.includes('.m3u8'));
    if(af.length){ const b=af.sort((a,b)=>(b.abr||0)-(a.abr||0))[0]; qualities.push({label:'Audio MP3',badge:'HQ',size:fmtSize(b.filesize||b.filesize_approx),ext:'mp3',url:b.url,isAudio:true}); }
    const hts=[2160,1440,1080,720,480,360,240,144], bm={2160:'4K',1440:'2K',1080:'FHD',720:'HD'}, lm={2160:'2160p / 4K',1440:'1440p / 2K',1080:'1080p Full HD',720:'720p HD'};
    for(const h of hts){
      const c=formats.filter(f=>f.height===h&&f.vcodec!=='none'&&f.url&&!f.url.includes('.m3u8'));
      if(!c.length)continue;
      const ch=c.find(f=>f.acodec!=='none')||c[0];
      qualities.push({label:lm[h]||`${h}p`,badge:bm[h]||'',size:fmtSize(ch.filesize||ch.filesize_approx),ext:ch.ext||'mp4',url:ch.url});
    }
  } else {
    const af=formats.filter(f=>f.vcodec==='none'&&f.acodec!=='none'&&f.url&&!f.url.includes('.m3u8'));
    if(af.length){ const b=af.sort((a,b)=>(b.abr||0)-(a.abr||0))[0]; qualities.push({label:'Audio MP3',badge:'HQ',size:fmtSize(b.filesize),ext:'mp3',url:b.url,isAudio:true}); }
    const vf=formats.filter(f=>f.vcodec!=='none'&&f.url&&!f.url.includes('.m3u8')).sort((a,b)=>(b.height||0)-(a.height||0));
    const seen=new Set();
    for(const f of vf){
      const h=f.height||0; if(seen.has(h))continue; seen.add(h);
      qualities.push({label:h?`${h}p`:(f.format_note||'Video'),badge:h>=1080?'FHD':h>=720?'HD':h>=360?'SD':'',size:fmtSize(f.filesize||f.filesize_approx),ext:f.ext||'mp4',url:f.url});
      if(qualities.length>=6)break;
    }
  }
  if(!qualities.length) throw new Error('No downloadable formats found. The video may be private or region-locked.');
  return {platform,title,author:uploader,duration,thumb,qualities};
}

exports.handler = async (event) => {
  if(event.httpMethod==='OPTIONS') return {statusCode:200,headers:CORS,body:''};
  try {
    const body=event.body?JSON.parse(event.body):{};
    let url=(body.url||(event.queryStringParameters||{}).url||'').trim();
    if(!url) return err('Missing url parameter');
    if(!/^https?:\/\//i.test(url)) url='https://'+url;
    const platform=detectPlatform(url);
    if(!platform) return err('Unsupported URL. Paste a YouTube, Facebook, Instagram, TikTok or Twitter/X link.');
    console.log(`[GetFiles] platform=${platform} url=${url.slice(0,80)}`);
    let result;
    if(platform==='tiktok')       result=await handleTikTok(url);
    else if(platform==='twitter') result=await handleTwitter(url);
    else                           result=await handleYtDlp(url,platform);
    return ok(result);
  } catch(e) {
    console.error('[GetFiles] ERROR:',e.message);
    let msg=e.message||'An unexpected error occurred';
    if(/sign in|login|cookie/i.test(msg))            msg='This video requires login. Only public videos can be downloaded.';
    else if(/private/i.test(msg))                    msg='This video is private and cannot be downloaded.';
    else if(/not available|unavailable/i.test(msg))  msg='This video is unavailable (deleted or region-locked).';
    else if(/copyright/i.test(msg))                  msg='This video cannot be downloaded due to copyright restrictions.';
    else if(/unable to extract|no video/i.test(msg)) msg='Could not extract video info. The link may be invalid or restricted.';
    return err(msg,500);
  }
};
