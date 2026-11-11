# Spelling Race

A private 1v1 spelling race. Static site, no backend, no build step.

Open the site, tap Join private room, enter the code (91409), type a name.
The first person in is the referee and the second connects straight to them over WebRTC.
If the referee leaves, the other player takes over and the scores carry on.

## Modes
- Copy: type the word as fast as you can. Every wrong key costs time.
- Fix: the word is shown misspelled. Type it correctly. One try per round.
- Hear: the word is spoken. Spell it. One try per round.

## How timing stays fair
- Both browsers sync clocks with repeated pings and keep the lowest round trip sample.
- The referee sets one shared start instant. Each player measures their own finish from that instant.
- The referee waits a few milliseconds for a possibly faster answer still in flight, then picks the lowest time.

## Develop
```bash
npm test
npm start
```

## Deploy
Import the repo in Vercel. No settings are needed.

Signaling uses the free public PeerJS broker (0.peerjs.com). Words come from `words.js`
(about 7,300 words by frequency plus about 560 commonly misspelled words).
