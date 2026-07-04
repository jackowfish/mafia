# mafia

Multiplayer mafia for one saloon table. Everyone gets a face card, the mafia kills by night, the town nominates two suspects, they give their speeches, and the table votes one of them to the gallows.

## The deck

Every card is a face card from a real deck (SVGs from [me.uk/cards](https://www.me.uk/cards/), CC0, tinted to match the app):

| card | position | night action |
| --- | --- | --- |
| A♠ A♣ A♦ | The Mafia | vote on somebody to kill (most fingers wins) |
| A♥ | The Angel | picks somebody to protect |
| K♥ | The Sheriff | investigates one player - learns if they're the mafia |
| K♠ | The Mayor (optional) | runs the table; their card is public so everyone knows they're clean |
| everything else | Townsperson | points at somebody (decoy, so every screen looks the same) |

The black aces come out one at a time as the table grows: 1 mafia at 4-8 players, 2 at 9-12, 3 at 13+. The mafia know each other and can't shoot their own. The Mayor gets a private script of stage directions (what to read at sunrise, when to open nominations, whose speeches to call) plus the phase controls, and still plays - nominates, votes, and can be shot.

## A round

1. Host deals. Everyone gets a card - hold it to peek.
2. Night: every living player secretly picks a player. Kills, saves, and investigations resolve together.
3. Sunrise: the body (or the save) is announced. Talk it out.
4. Nominations: everyone points two fingers. The two most-accused stand trial.
5. Speeches, then the vote. The accused don't vote. Ties go to a coin.
6. The condemned card flips. Mafia hanged → point town. Wrong hunch → point mafia. Next round re-deals.

4-16 players. Rooms expire after 24h idle.

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
- seat the Mayor (K♠)
- flip everyone's card at the end of the round
