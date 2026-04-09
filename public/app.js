// ── Elements ────────────────────────────────────────────────────────────────
const loginScreen   = document.getElementById('login-screen');
const gameScreen    = document.getElementById('game-screen');
const nameInput     = document.getElementById('name-input');
const joinBtn       = document.getElementById('join-btn');
const playerName    = document.getElementById('player-name');
const onlineCount   = document.getElementById('online-count');
const latencyDisp   = document.getElementById('latency-display');
const roundLabel    = document.getElementById('round-label');
const diffLabel     = document.getElementById('difficulty-label');
const questionText  = document.getElementById('question-text');
const answerForm    = document.getElementById('answer-form');
const answerInput   = document.getElementById('answer-input');
const submitBtn     = document.getElementById('submit-btn');
const feedback      = document.getElementById('feedback');
const winnerBanner  = document.getElementById('winner-banner');
const winnerText    = document.getElementById('winner-text');
const scoresBody    = document.getElementById('scores-body');
const noScores      = document.getElementById('no-scores');

// ── State ───────────────────────────────────────────────────────────────────
let socket = null;
let currentRoundId = null;
let userId = sessionStorage.getItem('mathArenaUserId');
if (!userId) {
  userId = crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2);
  sessionStorage.setItem('mathArenaUserId', userId);
}

const loginError = document.getElementById('login-error');

// ── Login ───────────────────────────────────────────────────────────────────
function join() {
  loginError.classList.add('hidden');
  const name = nameInput.value.trim();
  if (!name) { nameInput.focus(); return; }
  joinBtn.disabled = true;
  joinBtn.textContent = 'Connecting...';
  localStorage.setItem('mathArenaName', name);
  playerName.textContent = name;
  connectSocket(name);
}

function showGameScreen() {
  loginScreen.classList.add('hidden');
  gameScreen.classList.remove('hidden');
}

function backToLogin(message) {
  gameScreen.classList.add('hidden');
  loginScreen.classList.remove('hidden');
  joinBtn.disabled = false;
  joinBtn.textContent = 'Join Game';
  if (message) {
    loginError.textContent = message;
    loginError.classList.remove('hidden');
  }
  nameInput.value = '';
  nameInput.focus();
}

joinBtn.addEventListener('click', join);
nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') join(); });


// ── Socket Connection ───────────────────────────────────────────────────────
function connectSocket(displayName) {
  socket = io({ reconnection: true, reconnectionDelay: 1000, reconnectionAttempts: Infinity });

  socket.on('connect', () => {
    socket.emit('register', { displayName, userId });
    startLatencyPing();
  });

  socket.on('register-error', (data) => {
    socket.disconnect();
    socket = null;
    backToLogin(data.message || 'Name taken — try another');
  });

  socket.on('game-state', (data) => {
    // Registration succeeded — switch to game screen
    showGameScreen();
    if (data.questionText) {
      setQuestion(data);
    }
    if (data.winner) {
      showWinner(data.winner.displayName, null);
    }
    updateScores(data.highScores);
    updateOnline(data.onlineCount);
  });

  socket.on('new-question', (data) => {
    setQuestion(data);
    hideWinner();
    enableForm();
    clearFeedback();
    answerInput.value = '';
    answerInput.focus();
  });

  socket.on('scores-update', (data) => {
    updateScores(data.highScores);
  });

  socket.on('answer-result', (data) => {
    if (data.status === 'incorrect') {
      showFeedback('Incorrect — try again!', 'incorrect');
      answerInput.select();
    } else if (data.status === 'winner') {
      showFeedback('You got it! 🎉', 'winner');
      disableForm();
    } else if (data.status === 'too-late') {
      showFeedback('Too late — someone else answered first.', 'too-late');
      disableForm();
    } else if (data.status === 'wrong-round') {
      showFeedback('Question has changed — try the new one!', 'too-late');
    }
  });

  socket.on('round-winner', (data) => {
    showWinner(data.winner, data.answer);
    updateScores(data.highScores);
    disableForm();
  });

  socket.on('online-count', (data) => updateOnline(data.count));

  socket.on('pong-check', (data) => {
    const rtt = Date.now() - data.clientTimestamp;
    latencyDisp.textContent = `${rtt} ms`;
    latencyDisp.style.color = rtt < 100 ? 'var(--success)' : rtt < 300 ? 'var(--warning)' : 'var(--danger)';
  });

  socket.on('disconnect', () => {
    latencyDisp.textContent = 'disconnected';
    latencyDisp.style.color = 'var(--danger)';
  });
}

// ── UI Helpers ──────────────────────────────────────────────────────────────
function setQuestion(data) {
  currentRoundId = data.roundId;
  questionText.textContent = data.questionText + ' = ?';
  roundLabel.textContent = `Round ${data.roundNumber}`;
  const stars = '★'.repeat(Math.min(data.difficulty, 5));
  diffLabel.textContent = `Difficulty ${stars}`;
}

function showFeedback(msg, cls) {
  feedback.textContent = msg;
  feedback.className = 'feedback ' + cls;
}

function clearFeedback() {
  feedback.textContent = '';
  feedback.className = 'feedback';
}

function enableForm() {
  answerInput.disabled = false;
  submitBtn.disabled = false;
}

function disableForm() {
  answerInput.disabled = true;
  submitBtn.disabled = true;
}

function showWinner(name, answer) {
  winnerBanner.classList.remove('hidden');
  const answerPart = answer !== null && answer !== undefined ? ` — Answer: ${answer}` : '';
  winnerText.textContent = `${name} won this round!${answerPart}`;
}

function hideWinner() {
  winnerBanner.classList.add('hidden');
}

function updateScores(scores) {
  if (!scores || scores.length === 0) {
    scoresBody.innerHTML = '';
    noScores.classList.remove('hidden');
    return;
  }
  noScores.classList.add('hidden');
  scoresBody.innerHTML = scores.map((s, i) => `
    <tr>
      <td>${i + 1}</td>
      <td>${escapeHtml(s.displayName)}</td>
      <td>${s.wins}</td>
      <td>${s.streak}</td>
      <td>${s.bestStreak}</td>
    </tr>
  `).join('');
}

function updateOnline(count) {
  onlineCount.textContent = `${count} online`;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ── Answer Submission ───────────────────────────────────────────────────────
answerForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const val = answerInput.value.trim();
  if (!val || !socket || !currentRoundId) return;
  socket.emit('submit-answer', { roundId: currentRoundId, answer: val });
});

// ── Latency Ping ────────────────────────────────────────────────────────────
let pingInterval = null;
function startLatencyPing() {
  if (pingInterval) clearInterval(pingInterval);
  pingInterval = setInterval(() => {
    if (socket && socket.connected) {
      socket.emit('ping-check', { clientTimestamp: Date.now() });
    }
  }, 5000);
}
