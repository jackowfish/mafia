# mafia

A card dealer and ballot box for in-person mafia. The app shuffles the deck, hands everyone a secret card, and runs the daily trial - everything else (nights, kills, saves, speeches) happens out loud at the table. The game runs until the mafia are the last ones standing or they've all been hanged.

## The deck

Real playing cards (SVGs from [me.uk/cards](https://www.me.uk/cards/), CC0, tinted to match the app). The important roles are always face cards; townsfolk get number cards:

| card | position |
| --- | --- |
| A♠ A♣ A♦ | The Mafia - they know each other |
| A♥ | The Angel |
| K♥ | The Sheriff |
| K♠ | The Mayor - always the host, never shuffled in |
| 2-10, any suit | Townsperson |

The black aces come out one at a time as the table grows: 1 mafia at 4-8 players, 2 at 9-12, 3 at 13+. The host holds the Mayor card, runs the table, and controls the deal and the votes - they're never dealt a playing role. The mayor also gets a private ledger of every hand, so they can referee the nights.

## A round

1. Host deals. Every player gets a card - hold it to peek. Mafia see their partners on screen.
2. The mayor narrates the nights out loud, old-school, and marks night kills with the ☠ button (undo with ↺). The dead can't point fingers or vote, and no phase waits on them - but nobody sees their card.
3. When the town wants blood, the mayor opens nominations: the living point two fingers, and the two most-accused stand trial. A tie for a trial spot goes to a runoff among the tied - never to chance.
4. Speeches out loud, then the mayor calls the vote. Every living player but the accused votes on who hangs.
5. The verdict names the hanged (they're marked dead automatically) and the vote counts - but never their card, and never who voted for whom. The full ballot and every hand are the mayor's alone. Ties hang the jury: the town talks it out and revotes on the same two.
6. The app calls the game itself: town wins when the last mafia falls; mafia wins when they have the numbers (they control every vote and every night). One wrinkle - at parity with the Angel still alive the game isn't over, and only the mayor is told why, since saying so would out the Angel.
7. When it's called, the mayor flips every card face-up, then shuffles up the next round.

4+ players plus the mayor. Rooms expire after 24h idle.

## Run

```
docker build -t mafia .
docker run --rm -p 3000:3000 mafia
```

Open http://localhost:3000.

## Config

| env | default | what |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `REDIS_URL` | `redis://127.0.0.1:6379` | Redis connection string. If unset or pointing at localhost, an in-container Redis is started; otherwise the bundled one stays off. |

## Deploy (HA)

Point `REDIS_URL` at a shared Redis (any non-localhost host) and run as many replicas as you like - Socket.IO uses the Redis adapter so rooms and events are shared across instances.

## House rules (host settings)

- deal the Sheriff (K♥)
- deal the Angel (A♥)
