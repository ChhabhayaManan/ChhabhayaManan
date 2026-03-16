# Spotify Setup

This repo includes Vercel API routes for a live Spotify "currently listening" card.

## 1. Deploy the repo to Vercel

Import this repository into Vercel and complete the first deployment.

Your website will become:

`https://YOUR_VERCEL_APP.vercel.app`

## 2. Update the Spotify Developer app

In your Spotify app settings, use:

- `Website`: `https://YOUR_VERCEL_APP.vercel.app`
- `Redirect URI`: `https://YOUR_VERCEL_APP.vercel.app/api/spotify/callback`
- `API/SDK`: `Web API`

## 3. Add Vercel environment variables

Set these in Vercel Project Settings:

- `SPOTIFY_CLIENT_ID`
- `SPOTIFY_CLIENT_SECRET`

Do not add `SPOTIFY_REFRESH_TOKEN` yet.

## 4. Authorize Spotify

Visit:

`https://YOUR_VERCEL_APP.vercel.app/api/spotify/login`

After approving Spotify, the callback page will show your refresh token.

## 5. Finish the setup

Add this final environment variable in Vercel:

- `SPOTIFY_REFRESH_TOKEN`

Then redeploy the project.

## 6. Show it in the README

Replace `YOUR_VERCEL_APP` in the README Spotify section with your real Vercel domain.
