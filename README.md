# Math Arena

A real-time competitive math quiz app. All connected players see the same math problem, and the first one to answer correctly wins the round. After a winner is decided, a new question pops up automatically.

**Live URL:** _(deployment pending)_

## Tech Stack

- **Backend:** Node.js, Express, Socket.IO
- **Frontend:** Vanilla HTML/CSS/JS — went with no framework to keep things simple and fast to load
- **State:** In-memory (would need Redis/Postgres in production, covered below)
- **Real-time:** WebSockets via Socket.IO, with automatic long-polling fallback

## Getting Started

```bash
npm install
npm start
# Open http://localhost:3000 in multiple tabs to test
```

Port defaults to 3000, configurable via the `PORT` env variable.

## Design Decisions

### Handling Concurrency

This was the trickiest part to think through. When two players submit the correct answer almost simultaneously, who wins?

The approach I went with: a server-side `roundLocked` flag that gets flipped to `true` the instant a correct answer is processed. Since Node.js processes events on a single thread, there's no way for two answer handlers to run at the same time — one will always see `roundLocked === false` first and claim the win, the other gets a "too late" response.

Every submission also includes a `roundId`, so if someone's answer arrives after the round has already moved on, it gets rejected cleanly instead of causing weird state issues.

Worth noting: if this needed to scale horizontally across multiple server instances, this approach breaks down. You'd need something like Redis `SETNX` or a database-level atomic check (`UPDATE ... WHERE winner IS NULL`) to guarantee a single winner across processes.

### Network Conditions & Fairness

The server's receive-time is what counts — not anything the client sends. This prevents cheating via faked timestamps, but it does give lower-latency players a real edge.

To make this at least transparent, each client pings the server every 5 seconds and displays their RTT in the header. You'll know if you're disadvantaged. A more sophisticated approach would subtract estimated RTT from arrival time to level the playing field, but RTT measurement is noisy and I didn't want to over-engineer it for a demo. Definitely something I'd explore in production though.

Socket.IO also handles disconnects gracefully — auto-reconnects with backoff, and re-syncs the current game state when you come back.

### Dynamic Questions

Questions are generated randomly on the server with 5 difficulty tiers that unlock as rounds progress (every 3 rounds bumps the tier up):

| Tier | Type | Example |
|------|------|---------|
| 1 | Addition/Subtraction | `76 + 34` |
| 2 | Multiplication | `12 × 9` |
| 3 | Two-step | `14 × 7 + 3` |
| 4 | Squares | `17²` |
| 5 | Multi-step | `42 + 8 × 11` |

### High Scores

The leaderboard tracks total wins, current win streak, and best streak. If someone else wins, your streak resets. It adds a nice competitive layer on top of the per-round gameplay.

### Duplicate Names

Display names have to be unique among currently connected players (case-insensitive check). If someone tries to join with a name that's already in use, the server rejects the registration and the login screen shows an error message so they can pick a different name.

## Corners Cut & Production Notes

Since this was built as a time-boxed exercise, here's what I simplified and what I'd change for a real deployment:

- **State storage** — Everything's in memory right now (scores, game state, connections). A server restart wipes it all. Production would use Redis for ephemeral game state and Postgres for persistent user data and scores.

- **Authentication** — It's just a display name right now, with a UUID stored in localStorage for identity. A real version needs proper auth — OAuth, session management, etc.

- **Horizontal scaling** — Single Node.js process. For multiple instances, Socket.IO has a Redis adapter that lets servers share events and state across processes.

- **Question quality** — The random arithmetic generator does the job but gets repetitive. Would want a curated question bank with categories and maybe ELO-based difficulty matching.

- **Anti-cheat** — Currently there's just round-ID validation. Would add rate limiting on submissions, and potentially flag suspiciously fast answers server-side.

- **Testing** — No automated tests. Would want unit tests for the question generator, integration tests for Socket.IO events, and load testing for the concurrency path.

- **Security** — Minimal input sanitization. Production needs Helmet.js, CORS policies, rate limiting, and CSP headers.

- **Monitoring** — Just console.log for now. Would set up structured logging and error tracking (Sentry or similar).

## Project Structure

```
server.js           - Express + Socket.IO server, game logic, question generation
public/
  index.html        - Login screen and game UI
  style.css         - Dark theme, responsive layout
  app.js            - Client-side socket handling and UI updates
package.json
Procfile            - For Heroku/Railway deployment
```
