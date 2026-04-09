const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  pingInterval: 10000,
  pingTimeout: 5000,
});

app.use(express.static(path.join(__dirname, 'public')));

// ── Game State ──────────────────────────────────────────────────────────────
// In production: Redis or a database. In-memory is fine for this demo.

let currentRound = null;   // { id, question, answer, difficulty, createdAt }
let roundLocked = false;   // mutex: prevents race between concurrent answers
const highScores = {};     // { odisplayName: { wins, streak, bestStreak } }
const connectedUsers = {}; // socketId -> { id, displayName }

// ── Question Generator ─────────────────────────────────────────────────────
// Generates random arithmetic problems with increasing difficulty tiers.

function generateQuestion(difficulty = 1) {
  const tier = Math.min(difficulty, 5);
  const generators = [
    // Tier 1: simple addition/subtraction
    () => {
      const a = randInt(10, 99);
      const b = randInt(10, 99);
      const op = pick(['+', '-']);
      return { text: `${a} ${op} ${b}`, answer: op === '+' ? a + b : a - b };
    },
    // Tier 2: multiplication
    () => {
      const a = randInt(2, 15);
      const b = randInt(2, 15);
      return { text: `${a} × ${b}`, answer: a * b };
    },
    // Tier 3: two-step expressions
    () => {
      const a = randInt(2, 20);
      const b = randInt(2, 20);
      const c = randInt(1, 10);
      return { text: `${a} × ${b} + ${c}`, answer: a * b + c };
    },
    // Tier 4: squares and square roots
    () => {
      const a = randInt(2, 20);
      return { text: `${a}²`, answer: a * a };
    },
    // Tier 5: harder multi-step
    () => {
      const a = randInt(10, 50);
      const b = randInt(2, 12);
      const c = randInt(2, 12);
      return { text: `${a} + ${b} × ${c}`, answer: a + b * c };
    },
  ];

  // Pick from generators up to the current tier
  const pool = generators.slice(0, tier);
  return pick(pool)();
}

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// ── Round Management ────────────────────────────────────────────────────────

let roundNumber = 0;

function startNewRound() {
  roundNumber++;
  const difficulty = Math.ceil(roundNumber / 3); // ramp up every 3 rounds
  const q = generateQuestion(difficulty);

  currentRound = {
    id: uuidv4(),
    questionText: q.text,
    answer: q.answer,
    difficulty,
    createdAt: Date.now(),
    winner: null,
  };
  roundLocked = false;

  // Broadcast new question to all clients
  io.emit('new-question', {
    roundId: currentRound.id,
    questionText: currentRound.questionText,
    difficulty: currentRound.difficulty,
    roundNumber,
    serverTime: Date.now(),
  });

  console.log(`Round ${roundNumber}: "${q.text}" = ${q.answer} (difficulty ${difficulty})`);
}

// ── Socket.IO ───────────────────────────────────────────────────────────────

io.on('connection', (socket) => {
  console.log(`Connected: ${socket.id}`);

  // Client registers with a display name
  socket.on('register', (data) => {
    const displayName = (data.displayName || 'Anon').slice(0, 20);
    const userId = data.userId || socket.id;

    // Reject duplicate display names (different user, same name)
    const nameTaken = Object.values(connectedUsers).some(
      (u) => u.displayName.toLowerCase() === displayName.toLowerCase() && u.id !== userId
    );
    if (nameTaken) {
      socket.emit('register-error', { message: 'That name is already taken. Please choose another.' });
      return;
    }

    connectedUsers[socket.id] = { id: userId, displayName };

    if (!highScores[userId]) {
      highScores[userId] = { displayName, wins: 0, streak: 0, bestStreak: 0 };
    } else {
      highScores[userId].displayName = displayName;
    }

    // Send current state to the newly connected client
    socket.emit('game-state', {
      roundId: currentRound?.id,
      questionText: currentRound?.questionText,
      difficulty: currentRound?.difficulty,
      roundNumber,
      winner: currentRound?.winner,
      highScores: getTopScores(),
      onlineCount: Object.keys(connectedUsers).length,
      serverTime: Date.now(),
    });

    broadcastOnlineCount();
  });

  // CONCURRENCY: roundLocked acts as a mutex. The first correct answer sets
  // roundLocked = true synchronously (Node.js single-threaded event loop),
  // so even if two answers arrive in the same tick, only one wins.
  //
  // NETWORK FAIRNESS: We use the server-side receive timestamp, not the
  // client-reported time. This means the server's reception order is
  // authoritative — a client on a slow connection might be disadvantaged,
  // but this prevents cheating via falsified timestamps.
  // In production, you could subtract measured RTT (ping) to approximate
  // a fairer ordering.
  socket.on('submit-answer', (data) => {
    if (!currentRound || roundLocked) {
      socket.emit('answer-result', { status: 'too-late' });
      return;
    }

    if (data.roundId !== currentRound.id) {
      socket.emit('answer-result', { status: 'wrong-round' });
      return;
    }

    const userAnswer = parseFloat(data.answer);
    if (isNaN(userAnswer) || userAnswer !== currentRound.answer) {
      socket.emit('answer-result', { status: 'incorrect' });
      return;
    }

    // ── Winner! Lock the round immediately ──
    roundLocked = true;

    const user = connectedUsers[socket.id];
    const userId = user?.id || socket.id;
    const displayName = user?.displayName || 'Unknown';

    currentRound.winner = { userId, displayName, answeredAt: Date.now() };

    // Update high scores
    if (highScores[userId]) {
      highScores[userId].wins++;
      highScores[userId].streak++;
      if (highScores[userId].streak > highScores[userId].bestStreak) {
        highScores[userId].bestStreak = highScores[userId].streak;
      }
    }

    // Reset streaks for everyone else
    for (const uid of Object.keys(highScores)) {
      if (uid !== userId) {
        highScores[uid].streak = 0;
      }
    }

    socket.emit('answer-result', { status: 'winner' });

    // Broadcast winner to all
    io.emit('round-winner', {
      roundId: currentRound.id,
      winner: displayName,
      answer: currentRound.answer,
      highScores: getTopScores(),
    });

    // Start next round after a brief pause
    setTimeout(() => startNewRound(), 5000);
  });

  // Ping for latency measurement — clients can display their RTT
  socket.on('ping-check', (data) => {
    socket.emit('pong-check', { clientTimestamp: data.clientTimestamp, serverTimestamp: Date.now() });
  });

  socket.on('disconnect', () => {
    delete connectedUsers[socket.id];
    broadcastOnlineCount();
    console.log(`Disconnected: ${socket.id}`);
  });
});

function broadcastOnlineCount() {
  io.emit('online-count', { count: Object.keys(connectedUsers).length });
}

function getTopScores() {
  return Object.values(highScores)
    .sort((a, b) => b.wins - a.wins || b.bestStreak - a.bestStreak)
    .slice(0, 10);
}

// ── REST endpoint for high scores (optional, for sharing) ───────────────────
app.get('/api/scores', (req, res) => {
  res.json(getTopScores());
});

// ── Start ───────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  startNewRound();
});
