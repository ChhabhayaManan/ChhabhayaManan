const TOKEN_ENDPOINT = "https://accounts.spotify.com/api/token";
const NOW_PLAYING_ENDPOINT =
  "https://api.spotify.com/v1/me/player/currently-playing?additional_types=track";
const AUDIO_ANALYSIS_ENDPOINT = "https://api.spotify.com/v1/audio-analysis";

const analysisCache = new Map();
const imageCache = new Map();

function getBaseUrl(req) {
  const forwardedProto = req.headers["x-forwarded-proto"];
  const forwardedHost = req.headers["x-forwarded-host"];
  const host = forwardedHost || req.headers.host;
  const proto =
    forwardedProto ||
    (host && (host.includes("localhost") || host.includes("127.0.0.1"))
      ? "http"
      : "https");

  return `${proto}://${host}`;
}

function parseCookies(req) {
  const rawCookie = req.headers.cookie || "";
  return rawCookie.split(";").reduce((cookies, part) => {
    const [key, ...valueParts] = part.trim().split("=");
    if (!key) {
      return cookies;
    }

    cookies[key] = decodeURIComponent(valueParts.join("="));
    return cookies;
  }, {});
}

function encodeClientCredentials() {
  const clientId = process.env.SPOTIFY_CLIENT_ID || "";
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET || "";

  return Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function readCache(cache, key) {
  const entry = cache.get(key);
  if (!entry) {
    return null;
  }

  if (entry.expiresAt <= Date.now()) {
    cache.delete(key);
    return null;
  }

  return entry.value;
}

function writeCache(cache, key, value, ttlMs) {
  cache.set(key, {
    expiresAt: Date.now() + ttlMs,
    value,
  });
  return value;
}

function hashString(value) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash << 5) - hash + value.charCodeAt(index);
    hash |= 0;
  }

  return Math.abs(hash);
}

function pickAlbumArt(images) {
  if (!Array.isArray(images) || images.length === 0) {
    return "";
  }

  const preferred = [...images].sort(
    (left, right) => (right.height || 0) - (left.height || 0)
  );

  return preferred[0] && preferred[0].url ? preferred[0].url : images[0].url || "";
}

function normalizeLoudness(loudness) {
  return clamp((Number(loudness || -60) + 60) / 60, 0, 1);
}

async function exchangeCodeForRefreshToken(code, redirectUri) {
  const params = new URLSearchParams({
    code,
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
  });

  const response = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Basic ${encodeClientCredentials()}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });

  if (!response.ok) {
    throw new Error(`Spotify token exchange failed with ${response.status}`);
  }

  return response.json();
}

async function getAccessToken(refreshToken) {
  const params = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });

  const response = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Basic ${encodeClientCredentials()}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });

  if (!response.ok) {
    throw new Error(`Spotify refresh failed with ${response.status}`);
  }

  const data = await response.json();
  return data.access_token;
}

async function getAudioAnalysis(accessToken, trackId) {
  if (!trackId) {
    return null;
  }

  const cached = readCache(analysisCache, trackId);
  if (cached) {
    return cached;
  }

  const response = await fetch(`${AUDIO_ANALYSIS_ENDPOINT}/${trackId}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    return null;
  }

  const analysis = await response.json();
  return writeCache(analysisCache, trackId, analysis, 1000 * 60 * 60 * 6);
}

async function getImageDataUri(imageUrl) {
  if (!imageUrl) {
    return "";
  }

  const cached = readCache(imageCache, imageUrl);
  if (cached) {
    return cached;
  }

  const response = await fetch(imageUrl);
  if (!response.ok) {
    return "";
  }

  const contentType = response.headers.get("content-type") || "image/jpeg";
  const buffer = Buffer.from(await response.arrayBuffer());
  const dataUri = `data:${contentType};base64,${buffer.toString("base64")}`;

  return writeCache(imageCache, imageUrl, dataUri, 1000 * 60 * 60 * 12);
}

function getBeatStrength(segments, start, duration, confidence) {
  const end = start + duration;
  let peak = -60;
  let total = 0;
  let count = 0;

  for (const segment of segments) {
    const segmentStart = Number(segment.start || 0);
    const segmentEnd = segmentStart + Number(segment.duration || 0);

    if (segmentEnd < start || segmentStart > end) {
      continue;
    }

    const loudness = Number(
      segment.loudness_max ?? segment.loudness_start ?? segment.loudness_max_time ?? -60
    );
    peak = Math.max(peak, loudness);
    total += loudness;
    count += 1;
  }

  const average = count > 0 ? total / count : peak;
  const durationWeight = 1 - clamp((duration - 0.32) / 0.85, 0, 1) * 0.25;
  const loudnessWeight =
    normalizeLoudness(peak) * 0.65 + normalizeLoudness(average) * 0.2;
  const confidenceWeight = clamp(Number(confidence || 0), 0, 1) * 0.15;

  return clamp((loudnessWeight + confidenceWeight) * durationWeight, 0.16, 1);
}

function buildKeyTimes(durations) {
  const totalDuration = durations.reduce((sum, value) => sum + value, 0);
  if (!totalDuration) {
    return null;
  }

  const keyTimes = [0];
  let elapsed = 0;
  for (const duration of durations) {
    elapsed += duration;
    keyTimes.push(elapsed / totalDuration);
  }

  return {
    keyTimes: keyTimes.map((value) => value.toFixed(4)).join(";"),
    totalDuration,
  };
}

function getPhaseRatio(loopDuration, phaseOffset) {
  if (!loopDuration) {
    return 0;
  }

  return clamp(phaseOffset / loopDuration, 0, 0.9999);
}

function interpolateFromFrames(values, keyTimesString, phaseRatio) {
  if (!Array.isArray(values) || values.length === 0) {
    return 0;
  }

  const keyTimes = String(keyTimesString)
    .split(";")
    .map((value) => Number(value));

  for (let index = 0; index < keyTimes.length - 1; index += 1) {
    const start = keyTimes[index];
    const end = keyTimes[index + 1];

    if (phaseRatio < start || phaseRatio > end) {
      continue;
    }

    const range = Math.max(end - start, 0.0001);
    const localPhase = clamp((phaseRatio - start) / range, 0, 1);
    const from = Number(values[index] ?? values[0] ?? 0);
    const to = Number(values[index + 1] ?? values[index] ?? from);

    return from + (to - from) * localPhase;
  }

  return Number(values[0] ?? 0);
}

function buildBeatFrames(analysis, progressMs) {
  if (
    !analysis ||
    !Array.isArray(analysis.beats) ||
    analysis.beats.length < 4 ||
    !Array.isArray(analysis.segments)
  ) {
    return null;
  }

  const progressSeconds = progressMs / 1000;
  const beats = analysis.beats.filter(
    (beat) => Number(beat.duration || 0) > 0 && Number(beat.start || 0) >= 0
  );

  if (beats.length < 4) {
    return null;
  }

  let currentIndex = beats.findIndex(
    (beat) => Number(beat.start || 0) + Number(beat.duration || 0) > progressSeconds
  );
  if (currentIndex === -1) {
    currentIndex = 0;
  }

  const selectedBeats = [];
  for (let index = 0; index < 12; index += 1) {
    selectedBeats.push(beats[(currentIndex + index) % beats.length]);
  }

  const strengthsBase = selectedBeats.map((beat) =>
    getBeatStrength(
      analysis.segments,
      Number(beat.start || 0),
      clamp(Number(beat.duration || 0.48), 0.22, 1.15),
      beat.confidence
    )
  );
  const durations = selectedBeats.map((beat) =>
    clamp(Number(beat.duration || 0.48), 0.22, 1.15)
  );
  const timing = buildKeyTimes(durations);

  if (!timing) {
    return null;
  }

  const currentBeat = selectedBeats[0];
  const currentBeatDuration = clamp(Number(currentBeat.duration || 0.48), 0.22, 1.15);
  const phaseOffset = clamp(
    progressSeconds - Number(currentBeat.start || 0),
    0,
    currentBeatDuration
  );

  return {
    keyTimes: timing.keyTimes,
    loopDuration: Number(timing.totalDuration.toFixed(2)),
    phaseOffset: Number(phaseOffset.toFixed(3)),
    strengths: [...strengthsBase, strengthsBase[0]],
  };
}

function buildFallbackFrames(seedKey, progressMs) {
  const seed = hashString(`${seedKey}|${Math.floor(progressMs / 1000)}`);
  const steps = 10;
  const strengthsBase = Array.from({ length: steps }, (_, index) => {
    const primary = Math.abs(Math.sin(seed * 0.00073 + index * 0.81));
    const secondary = Math.abs(Math.cos(seed * 0.00113 + index * 0.56));
    return clamp(0.24 + (primary * 0.62 + secondary * 0.38) * 0.55, 0.18, 0.92);
  });

  return {
    keyTimes: Array.from({ length: steps + 1 }, (_, index) =>
      (index / steps).toFixed(4)
    ).join(";"),
    loopDuration: 2.8,
    phaseOffset: Number(((progressMs / 1000) % 2.8).toFixed(3)),
    strengths: [...strengthsBase, strengthsBase[0]],
  };
}

function buildWaveformModel({ analysis, isPlaying, progressMs, seedKey }) {
  const frames =
    buildBeatFrames(analysis, progressMs) || buildFallbackFrames(seedKey, progressMs);
  const barCount = 60;
  const minHeight = isPlaying ? 8 : 6;
  const maxHeight = isPlaying ? 54 : 24;
  const phaseRatio = getPhaseRatio(frames.loopDuration, frames.phaseOffset || 0);

  const bars = Array.from({ length: barCount }, (_, index) => {
    const phase = index / Math.max(1, barCount - 1);
    const arch = 0.38 + 0.62 * Math.sin(Math.PI * phase);
    const tilt = 0.82 + 0.18 * Math.cos((phase - 0.5) * Math.PI * 1.4);
    const heights = frames.strengths.map((strength, frameIndex) => {
      const pulse = 0.28 + 0.72 * Math.abs(Math.sin(frameIndex * 0.9 + phase * 8.6));
      const shimmer = 0.55 + 0.45 * Math.abs(Math.cos(frameIndex * 0.48 - phase * 11.2));
      const energy = clamp(strength * arch * pulse + 0.12 * shimmer, 0.08, 1);
      return Math.round(minHeight + (maxHeight - minHeight) * energy * tilt);
    });

    return {
      currentHeight: Math.round(
        interpolateFromFrames(heights, frames.keyTimes, phaseRatio)
      ),
      heights,
      opacity: (0.44 + phase * 0.4).toFixed(2),
    };
  });

  return {
    animate: isPlaying,
    bars,
    keyTimes: frames.keyTimes,
    loopDuration: frames.loopDuration,
    phaseOffset: frames.phaseOffset || 0,
  };
}

async function getCurrentlyPlaying(refreshToken) {
  const accessToken = await getAccessToken(refreshToken);
  const response = await fetch(NOW_PLAYING_ENDPOINT, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (response.status === 204) {
    return null;
  }

  if (!response.ok) {
    throw new Error(`Spotify now playing failed with ${response.status}`);
  }

  const data = await response.json();

  if (!data || !data.item) {
    return null;
  }

  const trackId = data.item.id || "";
  const album = data.item.album ? data.item.album.name || "" : "";
  const title = data.item.name || "Unknown track";
  const artists = Array.isArray(data.item.artists)
    ? data.item.artists.map((artist) => artist.name).join(", ")
    : "";
  const albumArtUrl = pickAlbumArt(data.item.album && data.item.album.images);
  const [albumArtDataUri, analysis] = await Promise.all([
    getImageDataUri(albumArtUrl),
    getAudioAnalysis(accessToken, trackId),
  ]);

  return {
    album,
    albumArtDataUri,
    artists,
    durationMs: data.item.duration_ms || 0,
    externalUrl:
      data.item.external_urls && data.item.external_urls.spotify
        ? data.item.external_urls.spotify
        : "",
    isPlaying: Boolean(data.is_playing),
    progressMs: data.progress_ms || 0,
    title,
    waveform: buildWaveformModel({
      analysis,
      isPlaying: Boolean(data.is_playing),
      progressMs: data.progress_ms || 0,
      seedKey: `${title}|${artists}|${album}|${trackId}`,
    }),
  };
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function truncate(value, maxLength) {
  if (!value || value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength - 3)}...`;
}

function formatTime(milliseconds) {
  if (!milliseconds) {
    return "0:00";
  }

  const totalSeconds = Math.floor(milliseconds / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function renderSpotifyGlyph(x, y, size) {
  const scale = size / 68;
  return `
    <g transform="translate(${x} ${y}) scale(${scale})">
      <circle cx="34" cy="34" r="34" fill="#1DB954" />
      <path d="M16 24c18-7 38-5 52 5" fill="none" stroke="#04110A" stroke-linecap="round" stroke-width="5.5" />
      <path d="M19 36c13-5 29-3 39 3" fill="none" stroke="#04110A" stroke-linecap="round" stroke-width="4.4" />
      <path d="M22 48c8-2.5 18-2 24 1.8" fill="none" stroke="#04110A" stroke-linecap="round" stroke-width="3.7" />
    </g>`;
}

function renderAlbumArt(track) {
  if (track.albumArtDataUri) {
    return `
      <rect x="32" y="54" width="170" height="170" rx="12" fill="#010409" stroke="#30363D" />
      <image href="${escapeXml(track.albumArtDataUri)}" x="32" y="54" width="170" height="170" preserveAspectRatio="xMidYMid slice" image-rendering="optimizeQuality" clip-path="url(#album-art-clip)" />`;
  }

  return `
    <rect x="32" y="54" width="170" height="170" rx="12" fill="#111827" stroke="#30363D" />
    ${renderSpotifyGlyph(83, 104, 68)}
    <text x="117" y="197" text-anchor="middle" fill="#8B949E" font-family="'Avenir Next', 'Helvetica Neue', 'Segoe UI', Arial, sans-serif" font-size="14">No cover art</text>`;
}

function renderWaveform(model) {
  const startX = 228;
  const baseline = 196;
  const barWidth = 6;
  const gap = 3;
  const animationBegin = model.animate
    ? ` begin="-${Number(model.phaseOffset || 0).toFixed(3)}s"`
    : "";

  return model.bars
    .map((bar, index) => {
      const x = startX + index * (barWidth + gap);
      const currentHeight = Math.max(2, Number(bar.currentHeight || bar.heights[0] || 0));
      const y = baseline - currentHeight;
      const heightValues = bar.heights.join(";");
      const yValues = bar.heights.map((value) => baseline - value).join(";");
      const animation = model.animate
        ? `
        <animate attributeName="height" values="${heightValues}" keyTimes="${model.keyTimes}" dur="${model.loopDuration}s" repeatCount="indefinite" calcMode="linear"${animationBegin} />
        <animate attributeName="y" values="${yValues}" keyTimes="${model.keyTimes}" dur="${model.loopDuration}s" repeatCount="indefinite" calcMode="linear"${animationBegin} />`
        : "";

      return `
        <rect x="${x}" y="${y}" width="${barWidth}" height="${currentHeight}" rx="1" fill="url(#wave-gradient)" opacity="${bar.opacity}">${animation}
        </rect>`;
    })
    .join("");
}

function renderCard({
  badgeColor,
  badgeText,
  footerText,
  isPlaying,
  lineOne,
  lineTwo,
  progress,
  progressColor,
  title,
  track,
}) {
  const safeTitle = escapeXml(truncate(title, 30));
  const safeLineOne = escapeXml(truncate(lineOne, 42));
  const safeLineTwo = escapeXml(truncate(lineTwo, 54));
  const safeFooter = escapeXml(truncate(footerText, 36));
  const safeStatus = escapeXml(badgeText);
  const hasLineTwo = Boolean(lineTwo && lineTwo.trim());
  const width = 900;
  const height = 284;
  const progressWidth = Math.max(0, Math.min(1, progress)) * 560;
  const waveform = track && track.waveform ? track.waveform : buildWaveformModel({ analysis: null, isPlaying, progressMs: 0, seedKey: title });
  const progressX = 228;
  const progressY = 220;

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-labelledby="title desc">
  <title id="title">${safeTitle}</title>
  <desc id="desc">${hasLineTwo ? `${safeLineOne} - ${safeLineTwo}` : safeLineOne}</desc>
  <defs>

    <linearGradient id="wave-gradient" x1="228" y1="176" x2="788" y2="176" gradientUnits="userSpaceOnUse">
      <stop stop-color="#1DB954" />
      <stop offset="1" stop-color="#2EA043" />
    </linearGradient>
    <linearGradient id="progress-gradient" x1="228" y1="230" x2="788" y2="230" gradientUnits="userSpaceOnUse">
      <stop stop-color="#1DB954" />
      <stop offset="1" stop-color="#3FB950" />
    </linearGradient>

    <clipPath id="album-art-clip">
      <rect x="32" y="54" width="170" height="170" rx="12" />
    </clipPath>
  </defs>
  <rect width="${width}" height="${height}" rx="16" fill="#0D1117" />
  <rect x="1" y="1" width="${width - 2}" height="${height - 2}" rx="15" fill="#0D1117" stroke="#30363D" />
  <rect x="16" y="16" width="868" height="252" rx="14" fill="#111827" />
  <rect x="16" y="16" width="868" height="252" rx="14" fill="none" stroke="#161B22" />
  ${renderAlbumArt(track || {})}
  <rect x="748" y="34" width="116" height="34" rx="12" fill="${badgeColor}" fill-opacity="0.13" stroke="${badgeColor}" />
  <circle cx="772" cy="51" r="4.5" fill="${badgeColor}">
    ${
      isPlaying
        ? '<animate attributeName="opacity" values="1;0.3;1" dur="1.4s" repeatCount="indefinite" />'
        : ""
    }
  </circle>
  <text x="808" y="56" text-anchor="middle" fill="${badgeColor}" font-family="'Avenir Next', 'Helvetica Neue', 'Segoe UI', Arial, sans-serif" font-size="13" font-weight="600">${safeStatus}</text>
  <text x="228" y="88" fill="#F0F6FC" font-family="'Avenir Next', 'Helvetica Neue', 'Segoe UI', Arial, sans-serif" font-size="36" font-weight="600">${safeTitle}</text>
  <text x="228" y="124" fill="#C9D1D9" font-family="'Avenir Next', 'Helvetica Neue', 'Segoe UI', Arial, sans-serif" font-size="21">${safeLineOne}</text>
  ${hasLineTwo ? `<text x="228" y="150" fill="#8B949E" font-family="'Avenir Next', 'Helvetica Neue', 'Segoe UI', Arial, sans-serif" font-size="15">${safeLineTwo}</text>` : ""}
  <rect x="228" y="${hasLineTwo ? 164 : 142}" width="560" height="1" fill="#30363D" />
  ${renderWaveform(waveform)}
  <rect x="${progressX}" y="${progressY}" width="560" height="4" rx="2" fill="#21262D" />
  <rect x="${progressX}" y="${progressY}" width="${progressWidth}" height="4" rx="2" fill="url(#progress-gradient)" />
  <circle cx="${progressX + progressWidth}" cy="${progressY + 2}" r="4" fill="${progressColor}" ${isPlaying ? 'opacity="1"' : 'opacity="0.85"'} />
  <text x="228" y="246" fill="#8B949E" font-family="'Avenir Next', 'Helvetica Neue', 'Segoe UI', Arial, sans-serif" font-size="14">${safeFooter}</text>
</svg>`;
}

function renderNowPlayingCard(track) {
  const progress =
    track.durationMs > 0 ? clamp(track.progressMs / track.durationMs, 0, 1) : 0;
  const statusText = track.isPlaying ? "LIVE" : "PAUSED";
  const statusColor = track.isPlaying ? "#1DB954" : "#D29922";
  const timing = `${formatTime(track.progressMs)} / ${formatTime(track.durationMs)}`;
  const footer = timing;

  return renderCard({
    badgeColor: statusColor,
    badgeText: statusText,
    footerText: footer,
    isPlaying: track.isPlaying,
    lineOne: track.artists || "Unknown artist",
    lineTwo: "",
    progress,
    progressColor: statusColor,
    title: track.title || "Unknown track",
    track,
  });
}

function renderIdleCard() {
  const track = {
    album: "No active playback",
    albumArtDataUri: "",
    artists: "Spotify is quiet right now",
    durationMs: 0,
    isPlaying: false,
    progressMs: 0,
    title: "Nothing is playing at the moment",
    waveform: buildWaveformModel({
      analysis: null,
      isPlaying: false,
      progressMs: 0,
      seedKey: "spotify-idle",
    }),
  };

  return renderCard({
    badgeColor: "#6E7681",
    badgeText: "IDLE",
    footerText: "Open Spotify and play something to light this up",
    isPlaying: false,
    lineOne: "No active track right now",
    lineTwo: "Come back later for the current song",
    progress: 0,
    progressColor: "#6E7681",
    title: track.title,
    track,
  });
}

function renderErrorCard(message) {
  const track = {
    album: "Finish setup in Vercel",
    albumArtDataUri: "",
    artists: "Spotify widget needs one more step",
    durationMs: 0,
    isPlaying: false,
    progressMs: 0,
    title: "Spotify widget not configured",
    waveform: buildWaveformModel({
      analysis: null,
      isPlaying: false,
      progressMs: 0,
      seedKey: `spotify-error|${message}`,
    }),
  };

  return renderCard({
    badgeColor: "#F85149",
    badgeText: "CHECK SETUP",
    footerText: "Visit /api/spotify/login if you need to reconnect Spotify",
    isPlaying: false,
    lineOne: message,
    lineTwo: "Then redeploy the project in Vercel",
    progress: 0,
    progressColor: "#F85149",
    title: track.title,
    track,
  });
}

module.exports = {
  escapeXml,
  exchangeCodeForRefreshToken,
  getBaseUrl,
  getCurrentlyPlaying,
  parseCookies,
  renderErrorCard,
  renderIdleCard,
  renderNowPlayingCard,
};













