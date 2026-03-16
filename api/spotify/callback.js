const {
  escapeXml,
  exchangeCodeForRefreshToken,
  getBaseUrl,
  parseCookies,
} = require("../_lib/spotify");

module.exports = async function handler(req, res) {
  const { code, error, state } = req.query;
  const cookies = parseCookies(req);
  const expectedState = cookies.spotify_auth_state;

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader(
    "Set-Cookie",
    "spotify_auth_state=; Path=/; HttpOnly; Max-Age=0; SameSite=Lax; Secure"
  );

  if (error) {
    res.status(400).send(renderHtml("Spotify authorization failed", error));
    return;
  }

  if (!code || !state || !expectedState || state !== expectedState) {
    res
      .status(400)
      .send(renderHtml("Spotify authorization failed", "State validation failed."));
    return;
  }

  try {
    const redirectUri = `${getBaseUrl(req)}/api/spotify/callback`;
    const tokenData = await exchangeCodeForRefreshToken(code, redirectUri);
    const refreshToken = tokenData.refresh_token;

    if (!refreshToken) {
      res.status(400).send(
        renderHtml(
          "Refresh token was not returned",
          "Spotify did not return a refresh token. Try authorizing again."
        )
      );
      return;
    }

    res.status(200).send(
      renderHtml(
        "Spotify connected",
        "Copy this refresh token into Vercel as SPOTIFY_REFRESH_TOKEN, then redeploy.",
        refreshToken
      )
    );
  } catch (tokenError) {
    res.status(500).send(
      renderHtml(
        "Token exchange failed",
        "Spotify rejected the callback exchange. Double-check your client ID, client secret, and redirect URI."
      )
    );
  }
};

function renderHtml(title, description, refreshToken = "") {
  const safeTitle = escapeXml(title);
  const safeDescription = escapeXml(description);
  const safeToken = escapeXml(refreshToken);

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${safeTitle}</title>
    <style>
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        background: linear-gradient(135deg, #0b1220, #111827);
        color: #e2e8f0;
        font-family: Segoe UI, Arial, sans-serif;
      }
      main {
        width: min(720px, calc(100vw - 32px));
        background: rgba(15, 23, 42, 0.92);
        border: 1px solid #1e293b;
        border-radius: 24px;
        padding: 28px;
        box-sizing: border-box;
        box-shadow: 0 22px 55px rgba(0, 0, 0, 0.35);
      }
      h1 {
        margin: 0 0 12px;
        color: #1db954;
        font-size: 28px;
      }
      p {
        margin: 0 0 16px;
        line-height: 1.6;
        color: #cbd5e1;
      }
      textarea {
        width: 100%;
        min-height: 120px;
        padding: 14px;
        border-radius: 16px;
        border: 1px solid #334155;
        background: #020617;
        color: #f8fafc;
        font-size: 14px;
        resize: vertical;
        box-sizing: border-box;
      }
      code {
        background: #020617;
        padding: 2px 8px;
        border-radius: 8px;
        color: #93c5fd;
      }
      ol {
        margin: 16px 0 0;
        padding-left: 20px;
        color: #cbd5e1;
      }
      li {
        margin: 10px 0;
      }
    </style>
  </head>
  <body>
    <main>
      <h1>${safeTitle}</h1>
      <p>${safeDescription}</p>
      ${
        refreshToken
          ? `<textarea readonly>${safeToken}</textarea>
      <ol>
        <li>Add <code>SPOTIFY_REFRESH_TOKEN</code> in Vercel project environment variables.</li>
        <li>Keep <code>SPOTIFY_CLIENT_ID</code> and <code>SPOTIFY_CLIENT_SECRET</code> set there too.</li>
        <li>Redeploy your Vercel project.</li>
        <li>Use <code>https://YOUR_VERCEL_APP.vercel.app/api/spotify</code> in your GitHub README image tag.</li>
      </ol>`
          : ""
      }
    </main>
  </body>
</html>`;
}
