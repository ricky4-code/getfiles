"""
GetFiles – Netlify Serverless Function (Python)
================================================
Uses yt-dlp which supports 1000+ sites including:
  YouTube, Facebook, Instagram, TikTok, Twitter/X

Netlify runs Python functions natively with the
python3.9+ runtime. yt-dlp is installed via
requirements.txt in the functions folder.
"""

import json
import os
import subprocess
import sys
import re
import urllib.request
import urllib.parse

# ── Install yt-dlp at cold-start if not present ──────────────
def ensure_ytdlp():
    try:
        import yt_dlp  # noqa: F401
        return True
    except ImportError:
        try:
            subprocess.check_call(
                [sys.executable, "-m", "pip", "install", "yt-dlp", "-q",
                 "--target", "/tmp/ytdlp_pkg"],
                timeout=60
            )
            sys.path.insert(0, "/tmp/ytdlp_pkg")
            return True
        except Exception as e:
            print(f"[GetFiles] yt-dlp install failed: {e}", file=sys.stderr)
            return False

ensure_ytdlp()

try:
    import yt_dlp
    YTDLP_OK = True
except ImportError:
    YTDLP_OK = False


# ── CORS headers ──────────────────────────────────────────────
CORS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
}

def respond(data, status=200):
    return {
        "statusCode": status,
        "headers": CORS,
        "body": json.dumps(data, ensure_ascii=False),
    }

def error(msg, status=400):
    return respond({"error": msg}, status)


# ── Detect platform ───────────────────────────────────────────
def detect_platform(url):
    u = url.lower()
    if "youtube.com" in u or "youtu.be" in u:   return "youtube"
    if "instagram.com" in u:                      return "instagram"
    if "tiktok.com" in u:                         return "tiktok"
    if "twitter.com" in u or "x.com" in u:        return "twitter"
    if "facebook.com" in u or "fb.watch" in u:    return "facebook"
    return None


# ── Format duration ───────────────────────────────────────────
def fmt_duration(seconds):
    if not seconds:
        return ""
    try:
        seconds = int(seconds)
        h = seconds // 3600
        m = (seconds % 3600) // 60
        s = seconds % 60
        if h:
            return f"{h}:{m:02d}:{s:02d}"
        return f"{m}:{s:02d}"
    except Exception:
        return ""


# ── Format filesize ───────────────────────────────────────────
def fmt_size(bytes_val):
    if not bytes_val:
        return "Variable"
    try:
        mb = int(bytes_val) / (1024 * 1024)
        if mb >= 1000:
            return f"{mb/1024:.1f} GB"
        return f"{mb:.0f} MB"
    except Exception:
        return "Variable"


# ── TikTok via tikwm.com (no-watermark, free) ────────────────
def handle_tiktok_tikwm(url):
    """
    tikwm.com is a dedicated TikTok API that returns
    no-watermark HD download links reliably.
    """
    api_url = f"https://www.tikwm.com/api/?url={urllib.parse.quote(url)}&hd=1"
    req = urllib.request.Request(
        api_url,
        headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"}
    )
    with urllib.request.urlopen(req, timeout=15) as resp:
        data = json.loads(resp.read().decode())

    if not data or data.get("code") != 0:
        raise ValueError(data.get("msg", "TikTok API error"))

    v = data["data"]
    qualities = []

    if v.get("hdplay"):
        qualities.append({
            "label": "HD – No Watermark",
            "badge": "NWM",
            "size":  fmt_size(v.get("hd_size")),
            "ext":   "mp4",
            "url":   v["hdplay"],
        })
    if v.get("play"):
        qualities.append({
            "label": "SD – No Watermark",
            "badge": "NWM",
            "size":  fmt_size(v.get("size")),
            "ext":   "mp4",
            "url":   v["play"],
        })
    if v.get("wmplay"):
        qualities.append({
            "label": "With Watermark",
            "badge": "",
            "size":  "Variable",
            "ext":   "mp4",
            "url":   v["wmplay"],
        })
    if v.get("music"):
        qualities.append({
            "label":   "Audio MP3",
            "badge":   "HQ",
            "size":    "Variable",
            "ext":     "mp3",
            "url":     v["music"],
            "isAudio": True,
        })

    return {
        "platform": "tiktok",
        "title":    v.get("title", "TikTok Video"),
        "author":   v.get("author", {}).get("nickname", ""),
        "duration": fmt_duration(v.get("duration")),
        "thumb":    v.get("cover") or v.get("origin_cover", ""),
        "qualities": qualities,
    }


# ── Twitter via fxtwitter API ─────────────────────────────────
def handle_twitter_fx(url):
    """
    fxtwitter.com provides a free JSON API for public tweets
    including all video variants and photos.
    """
    clean = re.sub(r'\?.*$', '', url)
    clean = clean.replace("x.com", "twitter.com")
    api_url = clean.replace("twitter.com", "api.fxtwitter.com")

    req = urllib.request.Request(
        api_url,
        headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"}
    )
    with urllib.request.urlopen(req, timeout=15) as resp:
        data = json.loads(resp.read().decode())

    tweet = data.get("tweet", {})
    if not tweet:
        raise ValueError("Tweet not found or is from a private account")

    media  = tweet.get("media", {})
    thumb  = ""
    qualities = []

    # Videos
    for vid in media.get("videos", []):
        thumb = thumb or vid.get("thumbnail_url", "")
        variants = sorted(
            vid.get("variants", []),
            key=lambda x: x.get("bitrate", 0), reverse=True
        )
        for vr in variants:
            src = vr.get("src", "")
            if not src or src.endswith(".m3u8"):
                continue
            m = re.search(r"/(\d+)x\d+/", src)
            height = m.group(1) if m else ""
            h = int(height) if height else 0
            qualities.append({
                "label": f"{height}p HD" if height else "Video",
                "badge": "FHD" if h >= 1080 else ("HD" if h >= 720 else ""),
                "size":  "Variable",
                "ext":   "mp4",
                "url":   src,
            })

    # Photos
    for i, photo in enumerate(media.get("photos", []), 1):
        photo_url = photo.get("url", "")
        if photo_url:
            thumb = thumb or photo_url
            qualities.append({
                "label": f"Photo {i} (Original)",
                "badge": "IMG",
                "size":  "Variable",
                "ext":   "jpg",
                "url":   photo_url + "?name=orig",
            })

    if not qualities:
        raise ValueError("No downloadable media found in this tweet")

    return {
        "platform": "twitter",
        "title":    tweet.get("text", "Twitter/X Post")[:80],
        "author":   tweet.get("author", {}).get("name", ""),
        "duration": "",
        "thumb":    thumb,
        "qualities": qualities,
    }


# ── yt-dlp handler (YouTube, Facebook, Instagram + fallback) ──
def handle_ytdlp(url, platform):
    """
    yt-dlp is the gold-standard downloader supporting 1800+ sites.
    It extracts real CDN URLs so the browser can download directly.
    """
    if not YTDLP_OK:
        raise RuntimeError("yt-dlp is not available on this server")

    ydl_opts = {
        "quiet":          True,
        "no_warnings":    True,
        "skip_download":  True,
        "noplaylist":     True,
        "extract_flat":   False,
        # Use a realistic browser UA to avoid bot detection
        "http_headers": {
            "User-Agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/120.0.0.0 Safari/537.36"
            ),
        },
    }

    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        info = ydl.extract_info(url, download=False)

    if not info:
        raise ValueError("Could not fetch video information")

    title    = info.get("title", "Video")
    uploader = info.get("uploader") or info.get("channel") or ""
    duration = fmt_duration(info.get("duration"))
    thumb    = info.get("thumbnail", "")

    # Pick best thumbnail (highest resolution)
    thumbs = info.get("thumbnails", [])
    if thumbs:
        best = max(thumbs, key=lambda t: (t.get("width") or 0) * (t.get("height") or 0))
        thumb = best.get("url", thumb)

    formats  = info.get("formats", [])
    qualities = []

    if platform == "youtube":
        # ── Audio MP3 ──
        audio_fmts = [
            f for f in formats
            if f.get("vcodec") == "none" and f.get("acodec") != "none"
            and f.get("ext") in ("m4a", "webm", "mp4", "ogg")
        ]
        if audio_fmts:
            best_audio = max(audio_fmts, key=lambda f: f.get("abr") or 0)
            qualities.append({
                "label":   "Audio MP3",
                "badge":   "HQ",
                "size":    fmt_size(best_audio.get("filesize") or best_audio.get("filesize_approx")),
                "ext":     "mp3",
                "url":     best_audio["url"],
                "isAudio": True,
            })

        # ── Video qualities ──
        target_heights = [2160, 1440, 1080, 720, 480, 360, 240, 144]
        badge_map = {2160: "4K", 1440: "2K", 1080: "FHD", 720: "HD"}

        for height in target_heights:
            # Prefer combined (audio+video) formats
            candidates = [
                f for f in formats
                if f.get("height") == height
                and f.get("vcodec") != "none"
            ]
            if not candidates:
                continue
            # Prefer formats with audio
            combined = [f for f in candidates if f.get("acodec") != "none"]
            chosen = combined[0] if combined else candidates[0]

            label = f"{height}p"
            if height == 1080: label = "1080p Full HD"
            elif height == 720: label = "720p HD"
            elif height == 2160: label = "2160p / 4K"
            elif height == 1440: label = "1440p / 2K"

            qualities.append({
                "label": label,
                "badge": badge_map.get(height, ""),
                "size":  fmt_size(chosen.get("filesize") or chosen.get("filesize_approx")),
                "ext":   chosen.get("ext", "mp4"),
                "url":   chosen["url"],
            })

    else:
        # Generic handler for Facebook, Instagram, etc.
        # Filter to video formats with a real URL
        video_fmts = [
            f for f in formats
            if f.get("url") and f.get("vcodec") != "none"
            and not f["url"].endswith(".m3u8")
        ]
        # Sort by resolution desc
        video_fmts.sort(key=lambda f: (f.get("height") or 0), reverse=True)

        seen_heights = set()
        for f in video_fmts:
            h = f.get("height") or 0
            if h in seen_heights:
                continue
            seen_heights.add(h)
            label = f"{h}p" if h else (f.get("format_note") or "Video")
            badge = "FHD" if h >= 1080 else ("HD" if h >= 720 else ("SD" if h >= 360 else ""))
            qualities.append({
                "label": label,
                "badge": badge,
                "size":  fmt_size(f.get("filesize") or f.get("filesize_approx")),
                "ext":   f.get("ext", "mp4"),
                "url":   f["url"],
            })
            if len(qualities) >= 5:
                break

        # Audio
        audio_fmts = [
            f for f in formats
            if f.get("vcodec") == "none" and f.get("acodec") != "none"
            and f.get("url") and not f["url"].endswith(".m3u8")
        ]
        if audio_fmts:
            best_audio = max(audio_fmts, key=lambda f: f.get("abr") or 0)
            qualities.insert(0, {
                "label":   "Audio MP3",
                "badge":   "HQ",
                "size":    fmt_size(best_audio.get("filesize")),
                "ext":     "mp3",
                "url":     best_audio["url"],
                "isAudio": True,
            })

    # Handle playlist / multiple items (e.g. Instagram carousels)
    entries = info.get("entries", [])
    if entries and not qualities:
        for i, entry in enumerate(entries[:10], 1):
            entry_fmts = entry.get("formats", [])
            best = None
            for f in reversed(entry_fmts):
                if f.get("url") and f.get("vcodec") != "none":
                    best = f
                    break
            if best:
                qualities.append({
                    "label": f"Item {i}",
                    "badge": "HD",
                    "size":  fmt_size(best.get("filesize")),
                    "ext":   best.get("ext", "mp4"),
                    "url":   best["url"],
                })

    if not qualities:
        raise ValueError("No downloadable formats found for this URL")

    return {
        "platform": platform,
        "title":    title,
        "author":   uploader,
        "duration": duration,
        "thumb":    thumb,
        "qualities": qualities,
    }


# ── Main handler ──────────────────────────────────────────────
def handler(event, context):
    # Handle CORS preflight
    if event.get("httpMethod") == "OPTIONS":
        return {"statusCode": 200, "headers": CORS, "body": ""}

    # Parse body
    try:
        body = json.loads(event.get("body") or "{}")
    except Exception:
        body = {}

    url = (
        body.get("url")
        or (event.get("queryStringParameters") or {}).get("url", "")
    ).strip()

    if not url:
        return error("Missing 'url' parameter")

    if not url.startswith(("http://", "https://")):
        url = "https://" + url

    platform = detect_platform(url)
    if not platform:
        return error(
            "Unsupported URL. Please paste a YouTube, Facebook, "
            "Instagram, TikTok or Twitter/X link."
        )

    print(f"[GetFiles] platform={platform} url={url[:80]}", file=sys.stderr)

    try:
        # Use specialised APIs for TikTok and Twitter (faster, more reliable)
        if platform == "tiktok":
            result = handle_tiktok_tikwm(url)
        elif platform == "twitter":
            result = handle_twitter_fx(url)
        else:
            # YouTube, Facebook, Instagram → yt-dlp
            result = handle_ytdlp(url, platform)

        return respond(result)

    except Exception as e:
        msg = str(e)
        print(f"[GetFiles] ERROR: {msg}", file=sys.stderr)

        # Friendly messages for common errors
        if "Sign in" in msg or "login" in msg.lower():
            msg = "This video requires a login to access. Only public videos can be downloaded."
        elif "private" in msg.lower():
            msg = "This video is private and cannot be downloaded."
        elif "not available" in msg.lower() or "unavailable" in msg.lower():
            msg = "This video is not available (may be region-locked or deleted)."
        elif "copyright" in msg.lower():
            msg = "This video cannot be downloaded due to copyright restrictions."

        return error(msg, 500)
