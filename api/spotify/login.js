const crypto = require("crypto");
const { getBaseUrl } = require("../_lib/spotify");

const SPOTIFY_SCOPE = "user-read-currently-playing";

module.exports = async function handler(req, res) {
  const clientId = process.env.SPOTIFY_CLIENT_ID;
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    res.status(500).send(
      "Missing SPOTIFY_CLIENT_ID or SPOTIFY_CLIENT_SECRET in Vercel environment variables."
    );
    return;
  }

  const state = crypto.randomBytes(16).toString("hex");
  const redirectUri = `${getBaseUrl(req)}/api/spotify/callback`;
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: SPOTIFY_SCOPE,
    show_dialog: "true",
    state,
  });

  res.setHeader(
    "Set-Cookie",
    `spotify_auth_state=${state}; Path=/; HttpOnly; Max-Age=600; SameSite=Lax; Secure`
  );
  res.writeHead(302, {
    Location: `https://accounts.spotify.com/authorize?${params.toString()}`,
  });
  res.end();
};
