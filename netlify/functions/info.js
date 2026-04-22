// GetFiles – /.netlify/functions/info
// Node.js 18 serverless function
// Uses yt-dlp-exec (bundles the yt-dlp binary – zero Python config needed)
// Also uses tikwm.com for TikTok and fxtwitter for Twitter/X

const https = require('https');
const http  = require('http');
const { execFile } = require('child_process');
const path  = require('path');
const os    = require('os');
const fs    = require('fs');

/* ── CORS headers ───────────────────────────────────────── */
const CORS = {
  'Access-Control-Allow-Origin' : '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type'                : 'application/json',
};

const ok  = d  => ({ statusCode: 200, headers: CORS, body: JSON.stringify(d) });
const err = (m, s=400) => ({ statusCode: s, headers: CORS, body: JSON.stringify({ error: m }) });

/* ── detect platform ────────────────────────────────────── */
function detectPlatform(url) {
  const u = url.toLowerCase();
  if (/youtu\.be|youtube\.com/.test(u))  return 'youtube';
  if (/instagram\.com/.test(u))           return 'instagram';
  if (/tiktok\.com/.test(u))              return 'tiktok';
  if (/twitter\.com|x\.com/.test(u))      return 'twitter';
  if (/facebook\.com|fb\.watch/.test(u))  return 'facebook';
  return null;
}

/* ── simple https fetch ─────────────────────────────────── */
function fetchJSON(url, options = {}) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const timeout = options.timeout || 15000;
    const postData = options.body || null;

    const urlObj = new URL(url);
    const reqOpts = {
      hostname: urlObj.hostname,
      path    : urlObj.pathname + urlObj.search,
      method  : options.method || 'GET',
      headers : {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept'    : 'application/json',
        ...(postData ? { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(postData) } : {}),
        ...(options.headers || {}),
      },
    };

    const req = lib.request(reqOpts, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error('Invalid JSON response: ' + data.slice(0, 200))); }
      });
    });

    req.setTimeout(timeout, () => { req.destroy(); reject(new Error('Request timed out')); });
    req.on('error', reject);
    if (postData) req.write(postData);
    req.end();
  });
}

/* ── format helpers ─────────────────────────────────────── */
function fmtDuration(sec) {
  if (!sec) return '';
  sec = parseInt(sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return h ? `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}` : `${m}:${String(s).padStart(2,'0')}`;
}

function fmtSize(bytes) {
  if (!bytes) return 'Variable';
  const mb = bytes / (1024 * 1024);
  if (mb >= 1024) return `${(mb/1024).toFixed(1)} GB`;
  return `${Math.round(mb)} MB`;
}

/* ══════════════════════════════════════════════════════════
   TikTok  →  tikwm.com  (free, no-watermark, reliable)
══════════════════════════════════════════════════════════ */
async function handleTikTok(url) {
  const data = await fetchJSON(
    `https://www.tikwm.com/api/?url=${encodeURIComponent(url)}&hd=1`
  );

  if (!data || data.code !== 0) {
    throw new Error(data?.msg || 'TikTok API error – make sure the video is public');
  }

  const v = data.data;
  const qualities = [];

  if (v.hdplay)  qualities.push({ label:'HD – No Watermark', badge:'NWM', size: fmtSize(v.hd_size),  ext:'mp4', url: v.hdplay });
  if (v.play)    qualities.push({ label:'SD – No Watermark', badge:'NWM', size: fmtSize(v.size),     ext:'mp4', url: v.play   });
  if (v.wmplay)  qualities.push({ label:'With Watermark',    badge:'',    size:'Variable',             ext:'mp4', url: v.wmplay });
  if (v.music)   qualities.push({ label:'Audio MP3',         badge:'HQ',  size:'Variable',             ext:'mp3', url: v.music, isAudio: true });

  return {
    platform : 'tiktok',
    title    : v.title   || 'TikTok Video',
    author   : v.author?.nickname || '',
    duration : fmtDuration(v.duration),
    thumb    : v.cover   || v.origin_cover || '',
    qualities,
  };
}

/* ══════════════════════════════════════════════════════════
   Twitter/X  →  fxtwitter API  (free, no auth needed)
══════════════════════════════════════════════════════════ */
async function handleTwitter(url) {
  const clean  = url.replace('x.com', 'twitter.com').replace(/\?.*$/, '');
  const apiUrl = clean.replace('twitter.com', 'api.fxtwitter.com');

  const data  = await fetchJSON(apiUrl);
  const tweet = data?.tweet;
  if (!tweet) throw new Error('Tweet not found or account is private');

  const media = tweet.media || {};
  let thumb   = '';
  const qualities = [];

  // Videos
  for (const vid of (media.videos || [])) {
    thumb = thumb || vid.thumbnail_url || '';
    const variants = (vid.variants || [])
      .filter(v => v.src && !v.src.endsWith('.m3u8'))
      .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));

    for (const vr of variants) {
      const m = vr.src.match(/\/(\d+)x\d+\//);
      const h = m ? parseInt(m[1]) : 0;
      qualities.push({
        label: h ? `${h}p` : 'Video',
        badge: h >= 1080 ? 'FHD' : h >= 720 ? 'HD' : '',
        size : 'Variable',
        ext  : 'mp4',
        url  : vr.src,
      });
    }
  }

  // Photos
  for (const [i, photo] of (media.photos || []).entries()) {
    if (photo.url) {
      thumb = thumb || photo.url;
      qualities.push({ label:`Photo ${i+1}`, badge:'IMG', size:'Variable', ext:'jpg', url: photo.url + '?name=orig' });
    }
  }

  if (!qualities.length) throw new Error('No downloadable media found in this tweet');

  return {
    platform : 'twitter',
    title    : (tweet.text || 'Twitter/X Post').slice(0, 100),
    author   : tweet.author?.name || '',
    duration : '',
    thumb,
    qualities,
  };
}

/* ══════════════════════════════════════════════════════════
   YouTube / Facebook / Instagram  →  yt-dlp binary
   yt-dlp-exec ships the binary inside node_modules
══════════════════════════════════════════════════════════ */
function runYtDlp(url) {
  return new Promise((resolve, reject) => {
    // Try yt-dlp-exec bundled binary first, then system yt-dlp
    let ytdlpPath;
    try {
      ytdlpPath = require('yt-dlp-exec').ytDlpPath;
    } catch(e) {
      ytdlpPath = 'yt-dlp'; // fall back to system PATH
    }

    const args = [
      url,
      '--dump-json',
      '--no-playlist',
      '--no-warnings',
      '--socket-timeout', '20',
      '--http-header', 'User-Agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    ];

    execFile(ytdlpPath, args, { timeout: 55000, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        const msg = stderr || error.message || 'yt-dlp error';
        return reject(new Error(msg.split('\n').find(l => l.includes('ERROR')) || msg.slice(0, 300)));
      }
      try {
        // yt-dlp can output multiple JSON lines (playlists) – take first
        const firstLine = stdout.trim().split('\n')[0];
        resolve(JSON.parse(firstLine));
      } catch(e) {
        reject(new Error('Could not parse yt-dlp output'));
      }
    });
  });
}

async function handleYtDlp(url, platform) {
  const info = await runYtDlp(url);

  const title    = info.title    || 'Video';
  const uploader = info.uploader || info.channel || '';
  const duration = fmtDuration(info.duration);
  const formats  = info.formats  || [];

  // Best thumbnail
  let thumb = info.thumbnail || '';
  if (info.thumbnails?.length) {
    const best = info.thumbnails
      .filter(t => t.url)
      .sort((a, b) => ((b.width||0)*(b.height||0)) - ((a.width||0)*(a.height||0)))[0];
    if (best) thumb = best.url;
  }

  const qualities = [];

  if (platform === 'youtube') {
    // Audio MP3
    const audioFmts = formats.filter(f => f.vcodec === 'none' && f.acodec !== 'none' && f.url);
    if (audioFmts.length) {
      const best = audioFmts.sort((a,b) => (b.abr||0)-(a.abr||0))[0];
      qualities.push({ label:'Audio MP3', badge:'HQ', size: fmtSize(best.filesize||best.filesize_approx), ext:'mp3', url: best.url, isAudio:true });
    }

    // Video qualities
    const heights   = [2160,1440,1080,720,480,360,240,144];
    const badgeMap  = { 2160:'4K', 1440:'2K', 1080:'FHD', 720:'HD' };
    const labelMap  = { 2160:'2160p / 4K', 1440:'1440p / 2K', 1080:'1080p Full HD', 720:'720p HD' };

    for (const h of heights) {
      const candidates = formats.filter(f => f.height === h && f.vcodec !== 'none' && f.url);
      if (!candidates.length) continue;
      const combined = candidates.filter(f => f.acodec !== 'none');
      const chosen   = combined[0] || candidates[0];
      qualities.push({
        label: labelMap[h] || `${h}p`,
        badge: badgeMap[h] || '',
        size : fmtSize(chosen.filesize || chosen.filesize_approx),
        ext  : chosen.ext || 'mp4',
        url  : chosen.url,
      });
    }
  } else {
    // Facebook / Instagram – generic
    const audioFmts = formats.filter(f => f.vcodec === 'none' && f.acodec !== 'none' && f.url && !f.url.includes('.m3u8'));
    if (audioFmts.length) {
      const best = audioFmts.sort((a,b)=>(b.abr||0)-(a.abr||0))[0];
      qualities.push({ label:'Audio MP3', badge:'HQ', size: fmtSize(best.filesize), ext:'mp3', url: best.url, isAudio:true });
    }

    const videoFmts = formats
      .filter(f => f.vcodec !== 'none' && f.url && !f.url.includes('.m3u8'))
      .sort((a,b) => (b.height||0)-(a.height||0));

    const seen = new Set();
    for (const f of videoFmts) {
      const h = f.height || 0;
      if (seen.has(h)) continue;
      seen.add(h);
      const badge = h >= 1080 ? 'FHD' : h >= 720 ? 'HD' : h >= 360 ? 'SD' : '';
      qualities.push({ label: h ? `${h}p` : (f.format_note || 'Video'), badge, size: fmtSize(f.filesize), ext: f.ext||'mp4', url: f.url });
      if (qualities.length >= 6) break;
    }
  }

  if (!qualities.length) throw new Error('No downloadable formats found for this URL');

  return { platform, title, author: uploader, duration, thumb, qualities };
}

/* ══════════════════════════════════════════════════════════
   MAIN HANDLER
══════════════════════════════════════════════════════════ */
exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode:200, headers:CORS, body:'' };

  let url;
  try {
    const body = event.body ? JSON.parse(event.body) : {};
    url = (body.url || (event.queryStringParameters || {}).url || '').trim();
    if (!url) return err('Missing url parameter');
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;

    const platform = detectPlatform(url);
    if (!platform) return err('Unsupported URL. Paste a YouTube, Facebook, Instagram, TikTok or Twitter/X link.');

    let result;
    switch (platform) {
      case 'tiktok'  : result = await handleTikTok(url);               break;
      case 'twitter' : result = await handleTwitter(url);              break;
      default        : result = await handleYtDlp(url, platform);      break;
    }

    return ok(result);

  } catch(e) {
    console.error('[GetFiles] ERROR:', e.message);
    let msg = e.message || 'An unexpected error occurred';
    if (/sign in|login/i.test(msg))               msg = 'This video requires a login. Only public videos can be downloaded.';
    else if (/private/i.test(msg))                msg = 'This video is private and cannot be downloaded.';
    else if (/not available|unavailable/i.test(msg)) msg = 'This video is unavailable (may be region-locked or deleted).';
    else if (/copyright/i.test(msg))              msg = 'This video cannot be downloaded due to copyright restrictions.';
    return err(msg, 500);
  }
};
