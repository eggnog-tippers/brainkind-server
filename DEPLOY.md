# Deploying the Brainkind push server

This lets Brainkind send reminders even when your phone is locked and the
app is closed. It only needs to be set up once. Free hosting is enough for
one person's use.

## 1. Create a free Render account (or Railway/Fly.io — steps are similar)

Go to https://render.com and sign up (GitHub login is easiest).

## 2. Upload this `brainkind-server` folder

- Create a new GitHub repo and push these files to it
  (`server.js`, `package.json`, `generate-vapid-keys.js`), **or**
- On Render, choose "New Web Service" → "Public Git repository" and point
  it at a repo containing these files.

## 3. Generate your VAPID keys

Locally (needs Node installed on your computer):

```
npm install
npm run generate-keys
```

This prints a public and private key. Keep them somewhere safe — you'll
need both in step 4, and the public one again inside the Brainkind app.

## 4. Set environment variables on Render

In your Render service settings → Environment, add:

- `VAPID_PUBLIC_KEY` — from step 3
- `VAPID_PRIVATE_KEY` — from step 3
- `VAPID_SUBJECT` — `mailto:youremail@example.com` (any contact email)

Build command: `npm install`
Start command: `npm start`

## 5. Deploy

Render will give you a URL like `https://brainkind-server.onrender.com`
once it's live. Test it by visiting `https://your-url/api/health` — it
should show `{"ok":true}`.

## 6. Connect the app

In Brainkind, tap the ⚙️ next to "Background reminders", paste your
server's URL, and tap "Enable reminders". Allow notifications when your
browser asks.

## Notes

- Free Render services can go to sleep after inactivity and take a few
  seconds to wake on the next request — reminders may lag slightly right
  after a quiet period. A paid tier (or Railway/Fly.io) avoids this.
- Data (your subscription + schedule) is stored in a simple `data.json`
  file on the server. Fine for personal use; if the server restarts on a
  host with no persistent disk, that file may reset — Render's free tier
  does have a persistent disk, so this shouldn't be an issue there.
- Nothing here uses a database or account system — anyone with your
  server's URL and your exact push subscription can't do much, but avoid
  sharing the URL publicly since it's your own private reminder channel.
