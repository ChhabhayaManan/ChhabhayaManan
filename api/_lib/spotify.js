const TOKEN_ENDPOINT = "https://accounts.spotify.com/api/token";
const NOW_PLAYING_ENDPOINT =
  "https://api.spotify.com/v1/me/player/currently-playing?additional_types=track";

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

  return {
    album: data.item.album ? data.item.album.name : "",
    artists: Array.isArray(data.item.artists)
      ? data.item.artists.map((artist) => artist.name).join(", ")
      : "",
    durationMs: data.item.duration_ms || 0,
    isPlaying: Boolean(data.is_playing),
    progressMs: data.progress_ms || 0,
    title: data.item.name || "Unknown track",
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

  return `${value.slice(0, maxLength - 1)}…`;
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

function renderSpotifyGlyph() {
  return `
    <circle cx="74" cy="100" r="34" fill="#1DB954" />
    <path d="M53 88c20-7 43-4 59 6" fill="none" stroke="#081018" stroke-linecap="round" stroke-width="5.5" />
    <path d="M56 100c15-5 32-3 44 4" fill="none" stroke="#081018" stroke-linecap="round" stroke-width="4.5" />
    <path d="M59 112c10-3 22-2 30 3" fill="none" stroke="#081018" stroke-linecap="round" stroke-width="4" />
  `;
}

function renderCard({
  badgeColor,
  badgeText,
  footerText,
  lineOne,
  lineTwo,
  progress,
  progressColor,
  title,
}) {
  const safeTitle = escapeXml(truncate(title, 34));
  const safeLineOne = escapeXml(truncate(lineOne, 48));
  const safeLineTwo = escapeXml(truncate(lineTwo, 56));
  const safeFooter = escapeXml(truncate(footerText, 60));
  const width = 720;
  const height = 220;
  const progressWidth = Math.max(0, Math.min(1, progress)) * 420;

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-labelledby="title desc">
  <title id="title">${safeTitle}</title>
  <desc id="desc">${safeLineOne} - ${safeLineTwo}</desc>
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="720" y2="220" gradientUnits="userSpaceOnUse">
      <stop stop-color="#0B1220" />
      <stop offset="1" stop-color="#111C34" />
    </linearGradient>
    <linearGradient id="glow" x1="0" y1="0" x2="1" y2="1">
      <stop stop-color="#1DB954" stop-opacity="0.18" />
      <stop offset="1" stop-color="#60A5FA" stop-opacity="0.1" />
    </linearGradient>
  </defs>
  <rect width="${width}" height="${height}" rx="26" fill="url(#bg)" />
  <circle cx="620" cy="32" r="116" fill="url(#glow)" />
  <circle cx="662" cy="182" r="70" fill="#1D4ED8" fill-opacity="0.08" />
  <rect x="28" y="28" width="664" height="164" rx="20" fill="#0F172A" fill-opacity="0.52" stroke="#1E293B" />
  ${renderSpotifyGlyph()}
  <text x="126" y="76" fill="#1DB954" font-family="Segoe UI, Arial, sans-serif" font-size="16" font-weight="700" letter-spacing="0.18em">SPOTIFY</text>
  <rect x="532" y="54" width="132" height="34" rx="17" fill="${badgeColor}" fill-opacity="0.18" stroke="${badgeColor}" />
  <text x="598" y="76" fill="${badgeColor}" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" font-size="14" font-weight="700">${escapeXml(
    badgeText
  )}</text>
  <text x="126" y="112" fill="#F8FAFC" font-family="Segoe UI, Arial, sans-serif" font-size="28" font-weight="700">${safeTitle}</text>
  <text x="126" y="145" fill="#CBD5E1" font-family="Segoe UI, Arial, sans-serif" font-size="18">${safeLineOne}</text>
  <text x="126" y="170" fill="#94A3B8" font-family="Segoe UI, Arial, sans-serif" font-size="15">${safeLineTwo}</text>
  <rect x="126" y="182" width="420" height="8" rx="4" fill="#1E293B" />
  <rect x="126" y="182" width="${progressWidth}" height="8" rx="4" fill="${progressColor}" />
  <text x="565" y="190" fill="#94A3B8" font-family="Segoe UI, Arial, sans-serif" font-size="13">${safeFooter}</text>
</svg>`;
}

function renderNowPlayingCard(track) {
  const progress =
    track.durationMs > 0 ? track.progressMs / track.durationMs : 0;
  const statusText = track.isPlaying ? "LISTENING NOW" : "PAUSED";
  const statusColor = track.isPlaying ? "#1DB954" : "#F59E0B";
  const timing = `${formatTime(track.progressMs)} / ${formatTime(track.durationMs)}`;
  const footer = track.album ? `${track.album} • ${timing}` : timing;

  return renderCard({
    badgeColor: statusColor,
    badgeText: statusText,
    footerText: footer,
    lineOne: track.artists || "Unknown artist",
    lineTwo: "Current Spotify session",
    progress,
    progressColor: statusColor,
    title: track.title || "Unknown track",
  });
}

function renderIdleCard() {
  return renderCard({
    badgeColor: "#64748B",
    badgeText: "OFFLINE",
    footerText: "Spotify is not playing anything right now",
    lineOne: "No active track at the moment",
    lineTwo: "Come back later to catch what is playing",
    progress: 0,
    progressColor: "#64748B",
    title: "Currently offline on Spotify",
  });
}

function renderErrorCard(message) {
  return renderCard({
    badgeColor: "#EF4444",
    badgeText: "SETUP NEEDED",
    footerText: "Finish the Spotify and Vercel setup to enable this card",
    lineOne: message,
    lineTwo: "Visit /api/spotify/login after deploying to Vercel",
    progress: 0,
    progressColor: "#EF4444",
    title: "Spotify widget not configured",
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
