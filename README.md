# Duet

Listen to the same songs at the same time with a friend, from anywhere.

## Run locally
    npm install
    npm start        # http://localhost:3000

## Use
1. Open the site, enter your name, press "Start a new room".
2. Press "Copy link" and send it to your friend.
3. Either of you can add songs (your own audio files). Play, pause, seek and skip are shared.

## Put it online (so a friend in another country can join)
Deploy this folder to any Node host (Render, Railway, Fly.io). Start command: `npm start`.
The host must support WebSockets and the service must keep running while you listen.
Uploaded files are stored on the server's disk and deleted an hour after a room is empty.

## Free music search (optional)
Search uses Jamendo's free Creative Commons catalogue.
1. Create a free app at https://devportal.jamendo.com and copy the client id.
2. Start the server with it:  `JAMENDO_CLIENT_ID=your_id npm start`
   (on a host like Render, add it as an environment variable named JAMENDO_CLIENT_ID).
Without the key, search shows a setup message and file uploads still work.

## Install on your phone
Open the site over https, then:
- iPhone (Safari): Share button, then "Add to Home Screen".
- Android (Chrome): menu, then "Install app" / "Add to Home screen".
It opens full screen with its own icon and shows play/pause/next controls on the lock screen.
Note: installing and the service worker only work on https (any normal host provides this) or on localhost.

## Deploy on Render (free)
1. Put this folder in a GitHub repo (`git init`, commit, push).
2. On render.com: New > Blueprint (or Web Service), pick the repo. `render.yaml` sets everything up.
3. Optional: add the env var `JAMENDO_CLIENT_ID` for music search.
4. Open the URL Render gives you. That is the link you share.
Free web services on Render sleep after a while without traffic and take about a minute to wake,
and their disk is wiped on restart, so uploaded songs may need to be added again.
