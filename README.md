# Spelling Race

A private spelling race for 2 to 8 players. Static site, no backend, no build step.

Open the site, tap Join private room, enter the code (91409), type a name.
The first person in is the referee and everyone else sends to them through the relay.
The leaderboard ranks players by round wins, then accuracy, then average time.
Players can join mid game (they sit out the current round). If the referee leaves, another player takes over and the scores carry on.

## Modes
- Copy: type the word as fast as you can. Every wrong key costs time.
- Fix: the word is shown misspelled. Type it correctly. One try per round.
- Hear: the word is spoken. Spell it. One try per round.

## How connecting works
- Players talk through public MQTT brokers over secure WebSockets (port 8084/8884/8081), so there are no NAT or relay problems. WebRTC was dropped because the free TURN servers it relied on no longer exist.
- Three brokers are used at once and every message goes to all of them (duplicates are ignored), so one broker being down does not matter. The list is `BROKERS` in `app.js`.
- The earliest present player is the host and referee. Each player's presence is a retained message with a last will, so the broker removes dead players automatically and the next in line takes over.
- A host that never answers is ignored after 8 seconds, so a ghost cannot lock the room.
- Add `?debug=1` to the URL to log what the connection layer is doing. `?broker=ws://localhost:8883` points it at your own broker.

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

The public brokers are free shared test servers. Words come from `words.js`
(about 7,300 words by frequency plus about 560 commonly misspelled words).
