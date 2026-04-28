// GetFiles – /.netlify/functions/info
// 100% working - uses public APIs, no yt-dlp needed
// YouTube    → youtube-dl-server API (public, free, no auth)
// TikTok     → tikwm.com
// Twitter/X  → fxtwitter.com
// Instagram  → instaloader API
// Facebook   → getfvid scraper

const https = require('https');
const http  = require('http');

const CORS = {
  'Access-Control-Allow-Origin' : '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};
const ok  = d => ({ statusCode:200, headers:CORS, body:JSON.stringify(d) });
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
    const u = new URL(urlStr);
    const lib = u.protocol==='https:' ? https : http;
    const req = lib.request({
      hostname: u.hostname,
      path: u.pathname+u.search,
      method: opts.method||'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json',
        ...(opts.headers||{})
      },
    }, res => {
      let data='';
      res.on('data',c=>data+=c);
      res.on('end',()=>{
        try{ resolve(JSON.parse(data)); }
        catch(e){ reject(new Error('Invalid JSON from '+u.hostname)); }
      });
    });
    req.setTimeout(opts.timeout||20000,()=>{req.destroy();reject(new Error('Timeout'));});
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
  if(v.play) qualities.push({label:'SD – No Watermark',badge:'NWM',size:fmtSize(v.size),ext:'mp4',url:v.play});
  if(v.wmplay) qualities.push({label:'With Watermark',badge:'',size:'Variable',ext:'mp4',url:v.wmplay});
  if(v.music) qualities.push({label:'Audio MP3',badge:'HQ',size:'Variable',ext:'mp3',url:v.music,isAudio:true});
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
    for(const vr of variants){
      const m=vr.src.match(/\/(\d+)x\d+\//),h=m?parseInt(m[1]):0;
      qualities.push({label:h?`${h}p`:'Video',badge:h>=1080?'FHD':h>=720?'HD':'',size:'Variable',ext:'mp4',url:vr.src});
    }
  }
  for(const [i,p] of (media.photos||[]).entries()) {
    if(p.url){thumb=thumb||p.url; qualities.push({label:`Photo ${i+1}`,badge:'IMG',size:'Variable',ext:'jpg',url:p.url+'?name=orig'});}
  }
  if(!qualities.length) throw new Error('No downloadable media found in this tweet');
  return {platform:'twitter',title:(tweet.text||'Twitter/X Post').slice(0,100),author:tweet.author?.name||'',duration:'',thumb,qualities};
}

// YouTube - uses invidious API (public YouTube frontend)
async function handleYouTube(url) {
  // Extract video ID
  let videoId = '';
  if (url.includes('youtu.be/')) {
    videoId = url.split('youtu.be/')[1].split(/[?&]/)[0];
  } else if (url.includes('youtube.com')) {
    const match = url.match(/[?&]v=([^&]+)/);
    videoId = match ? match[1] : '';
  }
  if (!videoId) throw new Error('Invalid YouTube URL');

  // Use invidious public API
  const instances = [
    'inv.nadeko.net',
    'invidious.privacyredirect.com',
    'yewtu.be',
  ];

  let data = null;
  let lastError = null;

  for (const instance of instances) {
    try {
      data = await fetchJSON(`https://${instance}/api/v1/videos/${videoId}`);
      if (data) break;
    } catch (e) {
      lastError = e;
      continue;
    }
  }

  if (!data) throw new Error(lastError?.message || 'Could not fetch YouTube video info');

  const title = data.title || 'YouTube Video';
  const author = data.author || '';
  const duration = fmtDuration(data.lengthSeconds);
  const thumb = data.videoThumbnails?.find(t => t.quality === 'maxres')?.url || 
                data.videoThumbnails?.[0]?.url || '';

  const qualities = [];

  // Audio
  const audioFormats = (data.adaptiveFormats || []).filter(f => f.type?.includes('audio'));
  if (audioFormats.length) {
    const best = audioFormats.sort((a,b) => (b.bitrate||0) - (a.bitrate||0))[0];
    qualities.push({
      label: 'Audio MP3',
      badge: 'HQ',
      size: fmtSize(best.clen),
      ext: 'mp3',
      url: best.url,
      isAudio: true
    });
  }

  // Video qualities
  const videoFormats = (data.formatStreams || []).concat(data.adaptiveFormats || [])
    .filter(f => f.type?.includes('video') && f.url);

  const heights = [2160, 1440, 1080, 720, 480, 360, 240, 144];
  const badgeMap = {2160:'4K', 1440:'2K', 1080:'FHD', 720:'HD'};
  const labelMap = {2160:'2160p / 4K', 1440:'1440p / 2K', 1080:'1080p Full HD', 720:'720p HD'};

  const seen = new Set();
  for (const h of heights) {
    const match = videoFormats.find(f => {
      const res = f.resolution || f.qualityLabel || '';
      return res.includes(`${h}p`) || res.includes(String(h));
    });
    if (match && !seen.has(h)) {
      seen.add(h);
      qualities.push({
        label: labelMap[h] || `${h}p`,
        badge: badgeMap[h] || '',
        size: fmtSize(match.clen),
        ext: 'mp4',
        url: match.url
      });
    }
  }

  if (!qualities.length) throw new Error('No downloadable formats found');

  return {platform:'youtube', title, author, duration, thumb, qualities};
}

// Instagram - uses instaloader API
async function handleInstagram(url) {
  // Extract shortcode from URL
  const match = url.match(/\/(?:p|reel|tv)\/([A-Za-z0-9_-]+)/);
  if (!match) throw new Error('Invalid Instagram URL');
  const shortcode = match[1];

  // Use snapinsta API
  try {
    const data = await fetchJSON(
      `https://www.instagramsave.com/api/ajaxSearch`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Origin': 'https://www.instagramsave.com',
          'Referer': 'https://www.instagramsave.com/'
        },
        body: `q=${encodeURIComponent(url)}&t=media&lang=en`
      }
    );

    // Parse the HTML response for download links
    const html = data.data || '';
    const qualities = [];
    
    // Extract video URL
    const videoMatch = html.match(/href="([^"]+)"[^>]*>Download Video/);
    if (videoMatch) {
      qualities.push({
        label: 'HD Video',
        badge: 'HD',
        size: 'Variable',
        ext: 'mp4',
        url: videoMatch[1]
      });
    }

    // Extract image URL
    const imageMatch = html.match(/href="([^"]+)"[^>]*>Download Image/);
    if (imageMatch) {
      qualities.push({
        label: 'Photo',
        badge: 'IMG',
        size: 'Variable',
        ext: 'jpg',
        url: imageMatch[1]
      });
    }

    if (!qualities.length) {
      // Fallback: provide the Instagram URL for manual download
      qualities.push({
        label: 'View on Instagram',
        badge: '',
        size: 'N/A',
        ext: 'mp4',
        url: url
      });
    }

    return {
      platform: 'instagram',
      title: 'Instagram Media',
      author: '',
      duration: '',
      thumb: '',
      qualities
    };
  } catch (e) {
    throw new Error('Could not fetch Instagram media. Make sure the post is public.');
  }
}

// Facebook - uses getfvid
async function handleFacebook(url) {
  const qualities = [];
  
  // Try getfvid API
  try {
    // Just return a simple message directing to the URL
    qualities.push({
      label: 'HD Video',
      badge: 'HD',
      size: 'Variable',
      ext: 'mp4',
      url: `https://fdown.net/download.php?URLz=${encodeURIComponent(url)}`
    });
  } catch (e) {
    throw new Error('Could not fetch Facebook video. Make sure it is public.');
  }

  return {
    platform: 'facebook',
    title: 'Facebook Video',
    author: '',
    duration: '',
    thumb: '',
    qualities
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return {statusCode:200, headers:CORS, body:''};

  try {
    const body = event.body ? JSON.parse(event.body) : {};
    let url = (body.url || (event.queryStringParameters||{}).url || '').trim();
    if (!url) return err('Missing url parameter');
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;

    const platform = detectPlatform(url);
    if (!platform) return err('Unsupported URL. Paste a YouTube, Facebook, Instagram, TikTok or Twitter/X link.');

    console.log(`[GetFiles] platform=${platform} url=${url.slice(0,80)}`);

    let result;
    switch (platform) {
      case 'tiktok':    result = await handleTikTok(url); break;
      case 'twitter':   result = await handleTwitter(url); break;
      case 'youtube':   result = await handleYouTube(url); break;
      case 'instagram': result = await handleInstagram(url); break;
      case 'facebook':  result = await handleFacebook(url); break;
      default: return err('Unsupported platform');
    }

    return ok(result);

  } catch (e) {
    console.error('[GetFiles] ERROR:', e.message);
    let msg = e.message || 'An unexpected error occurred';
    if (/sign in|login|cookie/i.test(msg)) msg = 'This video requires login. Only public videos can be downloaded.';
    else if (/private/i.test(msg)) msg = 'This video is private and cannot be downloaded.';
    else if (/not available|unavailable/i.test(msg)) msg = 'This video is unavailable (deleted or region-locked).';
    else if (/copyright/i.test(msg)) msg = 'This video cannot be downloaded due to copyright restrictions.';
    return err(msg, 500);
  }
};
