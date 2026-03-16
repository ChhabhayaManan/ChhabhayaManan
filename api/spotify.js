const {
  getCurrentlyPlaying,
  renderErrorCard,
  renderIdleCard,
  renderNowPlayingCard,
} = require("./_lib/spotify");

module.exports = async function handler(req, res) {
  res.setHeader("Content-Type", "image/svg+xml; charset=utf-8");
  res.setHeader(
    "Cache-Control",
    "public, max-age=0, s-maxage=30, stale-while-revalidate=60"
  );

  const refreshToken = process.env.SPOTIFY_REFRESH_TOKEN;
  const clientId = process.env.SPOTIFY_CLIENT_ID;
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;

  if (!clientId || !clientSecret || !refreshToken) {
    res.status(200).send(
      renderErrorCard(
        "Missing SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET, or SPOTIFY_REFRESH_TOKEN"
      )
    );
    return;
  }

  try {
    const track = await getCurrentlyPlaying(refreshToken);

    if (!track) {
      res.status(200).send(renderIdleCard());
      return;
    }

    res.status(200).send(renderNowPlayingCard(track));
  } catch (error) {
    res
      .status(200)
      .send(renderErrorCard("Spotify authentication failed. Refresh the token."));
  }
};
