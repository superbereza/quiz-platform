const socket = io();

const connectForm = document.getElementById('admin-connect');
const quizCodeInput = document.getElementById('quiz-code');
const connectStatus = document.getElementById('connect-status');
const questionPanel = document.getElementById('question-panel');
const controlPanel = document.getElementById('control-panel');
const questionForm = document.getElementById('question-form');
const imageUrlInput = document.getElementById('question-image');
const imageUploadInput = document.getElementById('question-image-upload');
const imageUploadStatus = document.getElementById('image-upload-status');
const questionsList = document.getElementById('questions');
const playersList = document.getElementById('players');
const scoreboardTable = document.getElementById('scoreboard');
const launchButton = document.getElementById('launch-question');
const revealButton = document.getElementById('reveal-results');
const finalButton = document.getElementById('final-results');
const gameStatus = document.getElementById('game-status');

let quizCode = '';
let lastScoreboard = [];
let uploadingImage = false;
const MAX_IMAGE_SIZE = 5 * 1024 * 1024;

const setUploadStatus = (message = '', variant = 'idle') => {
  if (!imageUploadStatus) return;
  imageUploadStatus.textContent = message;
  imageUploadStatus.classList.remove('error', 'success', 'loading');
  if (variant !== 'idle') {
    imageUploadStatus.classList.add(variant);
  }
};

if (imageUploadInput) {
  imageUploadInput.addEventListener('change', async (event) => {
    const [file] = event.target.files;
    if (!file) {
      setUploadStatus();
      return;
    }

    if (!['image/jpeg', 'image/png'].includes(file.type)) {
      setUploadStatus('Поддерживаются только JPG и PNG.', 'error');
      imageUploadInput.value = '';
      return;
    }

    if (file.size > MAX_IMAGE_SIZE) {
      setUploadStatus('Файл больше 5 МБ. Выберите изображение поменьше.', 'error');
      imageUploadInput.value = '';
      return;
    }

    uploadingImage = true;
    setUploadStatus('Загружаем картинку...', 'loading');

    const formData = new FormData();
    formData.append('image', file);

    try {
      const response = await fetch('/api/upload-image', {
        method: 'POST',
        body: formData
      });

      if (!response.ok) {
        const errorPayload = await response.json().catch(() => ({}));
        const message = errorPayload.error || 'Не удалось загрузить файл.';
        throw new Error(message);
      }

      const data = await response.json();
      imageUrlInput.value = data.url || '';
      setUploadStatus('Картинка загружена и готова к вопросу!', 'success');
    } catch (error) {
      setUploadStatus(error.message || 'Не удалось загрузить файл.', 'error');
      imageUrlInput.value = '';
    } finally {
      uploadingImage = false;
      imageUploadInput.value = '';
    }
  });
}

connectStatus.textContent =
  'Введите короткий код (например RETRO) и нажмите «Подключиться». Если такого кода ещё нет — квиз создастся автоматически.';

const renderQuestions = (questions) => {
  if (!questionsList) {
    return;
  }

  const safeQuestions = Array.isArray(questions) ? questions : [];
  questionsList.innerHTML = '';

  safeQuestions.forEach((question) => {
    const li = document.createElement('li');

    const promptEl = document.createElement('strong');
    promptEl.textContent = question.prompt || '';
    li.appendChild(promptEl);

    if (question.imageUrl) {
      const br = document.createElement('br');
      const hint = document.createElement('span');
      hint.className = 'hint';
      hint.textContent = `🖼 ${question.imageUrl}`;
      li.append(br, hint);
    }

    questionsList.appendChild(li);
  });
};

const renderPlayers = (players) => {
  playersList.innerHTML = '';
  players.forEach((player) => {
    const li = document.createElement('li');
    li.textContent = `${player.name} — ${player.score}`;
    playersList.appendChild(li);
  });
};

const renderScoreboard = (rows) => {
  scoreboardTable.innerHTML = '';
  if (!rows || rows.length === 0) {
    return;
  }
  const header = document.createElement('tr');
  header.innerHTML = '<th>#</th><th>Игрок</th><th>Очки</th>';
  scoreboardTable.appendChild(header);
  rows.forEach((row, index) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${index + 1}</td><td>${row.name}</td><td>${row.score}</td>`;
    scoreboardTable.appendChild(tr);
  });
};

connectForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const code = quizCodeInput.value.trim().toUpperCase();
  if (!code) {
    connectStatus.textContent = 'Введите код квиза.';
    return;
  }
  quizCode = code;
  connectStatus.textContent = 'Подключаемся...';
  socket.emit('registerAdmin', { code });
});

questionForm.addEventListener('submit', (event) => {
  event.preventDefault();
  if (!quizCode) {
    connectStatus.textContent = 'Сначала подключитесь к квизу.';
    return;
  }
  if (uploadingImage) {
    setUploadStatus('Подождите, картинка ещё загружается.', 'loading');
    return;
  }
  const prompt = document.getElementById('question-text').value;
  const imageUrl = imageUrlInput.value.trim();
  const options = Array.from(document.querySelectorAll('.option-input')).map((input) => input.value);
  const correctIndex = document.getElementById('correct-index').value;

  socket.emit('addQuestion', {
    code: quizCode,
    prompt,
    imageUrl,
    options,
    correctIndex
  });

  questionForm.reset();
  document.getElementById('correct-index').value = '0';
  imageUrlInput.value = '';
  setUploadStatus();
  uploadingImage = false;
  if (imageUploadInput) {
    imageUploadInput.value = '';
  }
});

launchButton.addEventListener('click', () => {
  if (!quizCode) return;
  socket.emit('launchNextQuestion', { code: quizCode });
});

revealButton.addEventListener('click', () => {
  if (!quizCode) return;
  socket.emit('revealResults', { code: quizCode });
});

finalButton.addEventListener('click', () => {
  if (!quizCode) return;
  socket.emit('showFinal', { code: quizCode });
});

socket.on('adminState', ({ code, questions, players, currentQuestionIndex, questionActive }) => {
  quizCode = code;
  connectStatus.textContent = `Вы управляете квизом ${code}. Добавьте вопросы и зовите игроков!`;
  questionPanel.hidden = false;
  controlPanel.hidden = false;
  renderQuestions(questions);
  renderPlayers(players);
  if (!questionActive) {
    launchButton.disabled = false;
    revealButton.disabled = true;
  }
  if (currentQuestionIndex >= 0) {
    gameStatus.textContent = `Последний активный вопрос: ${currentQuestionIndex + 1}`;
  }
  if (players && players.length > 0) {
    lastScoreboard = players;
    renderScoreboard(players);
  }
});

socket.on('playersUpdated', (players) => {
  renderPlayers(players);
});

socket.on('questionStarted', ({ index, total, prompt }) => {
  gameStatus.textContent = `Вопрос ${index} из ${total}: ${prompt}`;
  launchButton.disabled = true;
  revealButton.disabled = false;
  finalButton.disabled = true;
});

socket.on('questionResults', ({ correctOption, correctPlayersCount, scoreboard, isLastQuestion }) => {
  gameStatus.textContent = `Вопрос завершён. Правильных ответов: ${correctPlayersCount}. Правильный вариант: ${correctOption + 1}.`;
  launchButton.disabled = isLastQuestion;
  revealButton.disabled = true;
  finalButton.disabled = !isLastQuestion;
  lastScoreboard = scoreboard;
  renderScoreboard(scoreboard);
});

socket.on('quizFinished', ({ scoreboard, totalQuestions }) => {
  lastScoreboard = scoreboard;
  renderScoreboard(scoreboard);
  gameStatus.textContent = `Финал! Всего вопросов: ${totalQuestions}. Победитель: ${scoreboard[0] ? scoreboard[0].name : '—'}.`;
  launchButton.disabled = true;
  revealButton.disabled = true;
  finalButton.disabled = true;
});

socket.on('errorMessage', (message) => {
  connectStatus.textContent = message;
});

socket.on('disconnect', () => {
  connectStatus.textContent = 'Связь потеряна. Проверьте интернет и обновите страницу.';
});
