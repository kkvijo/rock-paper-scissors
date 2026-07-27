/* =========================================================
   DOJO DUEL — game logic
   ========================================================= */

// ---------- Element references ----------
const choiceStage   = document.getElementById('choiceStage');
const revealStage   = document.getElementById('revealStage');
const playerSealEl  = document.getElementById('playerSeal');
const computerSealEl= document.getElementById('computerSeal');
const shockwaveEl   = document.getElementById('shockwave');
const resultMessage = document.getElementById('resultMessage');
const postControls  = document.getElementById('postControls');
const playAgainBtn  = document.getElementById('playAgainBtn');
const resetScoreBtn = document.getElementById('resetScoreBtn');
const themeToggle    = document.getElementById('themeToggle');
const themeIcon      = document.getElementById('themeIcon');
const streakBadge    = document.getElementById('streakBadge');
const streakCountEl  = document.getElementById('streakCount');
const bestStreakEl   = document.getElementById('bestStreak');

const playerScoreEl   = document.getElementById('playerScore');
const computerScoreEl = document.getElementById('computerScore');
const drawScoreEl     = document.getElementById('drawScore');

const confettiCanvas = document.getElementById('confettiCanvas');
const ctx = confettiCanvas.getContext('2d');

// ---------- Choice metadata ----------
const CHOICES = {
  rock:     { icon: '🪨', beats: 'scissors', className: 'seal--rock' },
  paper:    { icon: '📄', beats: 'rock',     className: 'seal--paper' },
  scissors: { icon: '✂️', beats: 'paper',    className: 'seal--scissors' }
};

// ---------- Persistent state (localStorage) ----------
const STORAGE_KEY = 'dojoDuelState';

function loadState(){
  try{
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (saved) return saved;
  }catch(e){ /* ignore corrupt storage */ }
  return { playerScore: 0, computerScore: 0, draws: 0, streak: 0, bestStreak: 0, theme: 'dark' };
}

function saveState(){
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

let state = loadState();
let roundInProgress = false;

// ---------- Init UI from state ----------
function renderScores(){
  playerScoreEl.textContent   = state.playerScore;
  computerScoreEl.textContent = state.computerScore;
  drawScoreEl.textContent     = state.draws;
  streakCountEl.textContent   = state.streak;
  bestStreakEl.textContent    = state.bestStreak;
  streakBadge.classList.toggle('active', state.streak > 0);
}

function applyTheme(theme){
  document.body.setAttribute('data-theme', theme);
  themeIcon.textContent = theme === 'dark' ? '☀️' : '🌙';
  state.theme = theme;
  saveState();
}

applyTheme(state.theme || 'dark');
renderScores();

// ---------- Sound effects (Web Audio API — no external files needed) ----------
let audioCtx = null;
function getAudioCtx(){
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return audioCtx;
}

// Plays a short sequence of tones to represent win / lose / draw outcomes.
function playTone(freq, startTime, duration, type='sine', gainPeak=0.18){
  const ac = getAudioCtx();
  const osc = ac.createOscillator();
  const gain = ac.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  osc.connect(gain);
  gain.connect(ac.destination);
  gain.gain.setValueAtTime(0, startTime);
  gain.gain.linearRampToValueAtTime(gainPeak, startTime + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.001, startTime + duration);
  osc.start(startTime);
  osc.stop(startTime + duration);
}

function playSound(outcome){
  const ac = getAudioCtx();
  const now = ac.currentTime;
  if (outcome === 'win'){
    // ascending triumphant chime
    playTone(523.25, now,        0.18, 'triangle');
    playTone(659.25, now + 0.12, 0.18, 'triangle');
    playTone(783.99, now + 0.24, 0.3,  'triangle');
  } else if (outcome === 'lose'){
    // descending low buzz
    playTone(196.00, now,        0.22, 'sawtooth', 0.12);
    playTone(146.83, now + 0.15, 0.3,  'sawtooth', 0.12);
  } else {
    // neutral draw ping
    playTone(392.00, now,        0.16, 'sine', 0.14);
    playTone(392.00, now + 0.18, 0.16, 'sine', 0.14);
  }
}

// ---------- Confetti ----------
let confettiPieces = [];
let confettiAnimating = false;

function resizeCanvas(){
  confettiCanvas.width = window.innerWidth;
  confettiCanvas.height = window.innerHeight;
}
window.addEventListener('resize', resizeCanvas);
resizeCanvas();

function launchConfetti(){
  const colors = ['#d4a537', '#f0c869', '#5fd98a', '#7fb8cf', '#f2685c'];
  confettiPieces = [];
  for (let i = 0; i < 90; i++){
    confettiPieces.push({
      x: Math.random() * confettiCanvas.width,
      y: -20 - Math.random() * confettiCanvas.height * 0.4,
      w: 6 + Math.random() * 6,
      h: 8 + Math.random() * 8,
      color: colors[Math.floor(Math.random() * colors.length)],
      vy: 2 + Math.random() * 3,
      vx: -1.5 + Math.random() * 3,
      rotation: Math.random() * 360,
      vr: -6 + Math.random() * 12
    });
  }
  if (!confettiAnimating){
    confettiAnimating = true;
    requestAnimationFrame(animateConfetti);
  }
  // stop spawning new frames after a few seconds
  clearTimeout(launchConfetti._timer);
  launchConfetti._timer = setTimeout(() => { confettiPieces = []; }, 2600);
}

function animateConfetti(){
  ctx.clearRect(0, 0, confettiCanvas.width, confettiCanvas.height);
  confettiPieces.forEach(p => {
    p.x += p.vx;
    p.y += p.vy;
    p.rotation += p.vr;
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate((p.rotation * Math.PI) / 180);
    ctx.fillStyle = p.color;
    ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
    ctx.restore();
  });
  confettiPieces = confettiPieces.filter(p => p.y < confettiCanvas.height + 30);

  if (confettiPieces.length > 0){
    requestAnimationFrame(animateConfetti);
  } else {
    ctx.clearRect(0, 0, confettiCanvas.width, confettiCanvas.height);
    confettiAnimating = false;
  }
}

// ---------- Game logic ----------
function getComputerChoice(){
  const keys = Object.keys(CHOICES);
  return keys[Math.floor(Math.random() * keys.length)];
}

// returns 'win' | 'lose' | 'draw' from the player's perspective
function judge(player, computer){
  if (player === computer) return 'draw';
  return CHOICES[player].beats === computer ? 'win' : 'lose';
}

function buildSeal(container, choiceKey){
  container.className = 'seal seal--big ' + CHOICES[choiceKey].className;
  container.innerHTML = `<span class="seal-icon">${CHOICES[choiceKey].icon}</span>`;
}

function handleChoice(playerChoice){
  if (roundInProgress) return;
  roundInProgress = true;

  const computerChoice = getComputerChoice();
  const outcome = judge(playerChoice, computerChoice);

  // swap stage: hide choices, show reveal
  choiceStage.hidden = true;
  revealStage.hidden = false;
  resultMessage.className = 'result-message';
  resultMessage.textContent = '';

  buildSeal(playerSealEl, playerChoice);
  buildSeal(computerSealEl, computerChoice);

  // trigger drop-in animation
  playerSealEl.classList.remove('revealing');
  computerSealEl.classList.remove('revealing');
  void playerSealEl.offsetWidth; // reflow to restart animation
  playerSealEl.classList.add('revealing');
  computerSealEl.classList.add('revealing');

  // shockwave pulse at the VS core
  shockwaveEl.classList.remove('pulse');
  void shockwaveEl.offsetWidth;
  shockwaveEl.classList.add('pulse');

  // after the drop-in animation, apply win/lose highlighting + result text
  setTimeout(() => {
    if (outcome === 'win'){
      playerSealEl.classList.add('win');
      computerSealEl.classList.add('lose');
      resultMessage.textContent = 'You Win!';
      resultMessage.classList.add('win');
      state.playerScore++;
      state.streak++;
      if (state.streak > state.bestStreak) state.bestStreak = state.streak;
      launchConfetti();
    } else if (outcome === 'lose'){
      computerSealEl.classList.add('win');
      playerSealEl.classList.add('lose');
      resultMessage.textContent = 'You Lose!';
      resultMessage.classList.add('lose');
      state.computerScore++;
      state.streak = 0;
    } else {
      resultMessage.textContent = "It's a Draw!";
      resultMessage.classList.add('draw');
      state.draws++;
    }

    resultMessage.classList.add('show');
    playSound(outcome);
    renderScores();
    saveState();

    postControls.hidden = false;
    roundInProgress = false;
  }, 550);
}

function resetRound(){
  revealStage.hidden = true;
  choiceStage.hidden = false;
  postControls.hidden = true;
  resultMessage.textContent = '';
  playerSealEl.classList.remove('win', 'lose', 'revealing');
  computerSealEl.classList.remove('win', 'lose', 'revealing');
}

function resetScore(){
  state.playerScore = 0;
  state.computerScore = 0;
  state.draws = 0;
  state.streak = 0;
  // bestStreak intentionally persists as an all-time record
  saveState();
  renderScores();
  resetRound();
}

// ---------- Event wiring ----------
choiceStage.querySelectorAll('.choice-btn').forEach(btn => {
  btn.addEventListener('click', () => handleChoice(btn.dataset.choice));
});

playAgainBtn.addEventListener('click', resetRound);
resetScoreBtn.addEventListener('click', resetScore);

themeToggle.addEventListener('click', () => {
  const next = document.body.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  applyTheme(next);
});

// Keyboard shortcuts: R = rock, P = paper, S = scissors
window.addEventListener('keydown', (e) => {
  const key = e.key.toLowerCase();
  const map = { r: 'rock', p: 'paper', s: 'scissors' };
  if (map[key] && choiceStage.hidden === false){
    handleChoice(map[key]);
  } else if (map[key] && !postControls.hidden){
    // allow rapid re-play via keyboard after a round ends
    resetRound();
    handleChoice(map[key]);
  }
});
