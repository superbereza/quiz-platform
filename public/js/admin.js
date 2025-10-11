const socket = io();

const connectForm = document.getElementById('admin-connect');
const quizCodeInput = document.getElementById('quiz-code');
const connectStatus = document.getElementById('connect-status');
const tabButtons = Array.from(document.querySelectorAll('[data-tab-target]'));
const tabPanels = Array.from(document.querySelectorAll('.tab-panel'));
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
const restartButton = document.getElementById('restart-quiz');
const gameStatus = document.getElementById('game-status');

let quizCode = '';
let lastScoreboard = [];
let uploadingImage = false;
let dragStartOrder = [];
const MAX_IMAGE_SIZE = 5 * 1024 * 1024;

const getTabButton = (panelId) =>
  tabButtons.find((button) => button.dataset.tabTarget === panelId);

const setActiveTab = (panelId) => {
  tabButtons.forEach((button) => {
    const isActive = button.dataset.tabTarget === panelId;
    button.setAttribute('aria-selected', String(isActive));
    button.classList.toggle('tab-button--active', isActive);
  });

  tabPanels.forEach((panel) => {
    panel.hidden = panel.id !== panelId;
  });
};

const setTabAvailability = (panelId, isEnabled) => {
  const button = getTabButton(panelId);
  if (!button) {
    return;
  }
  button.disabled = !isEnabled;
  if (!isEnabled && button.getAttribute('aria-selected') === 'true') {
    setActiveTab('connect-panel');
  }
};

const enableTab = (panelId) => setTabAvailability(panelId, true);
const disableTab = (panelId) => setTabAvailability(panelId, false);

tabButtons.forEach((button) => {
  button.addEventListener('click', () => {
    if (button.disabled) {
      return;
    }
    const target = button.dataset.tabTarget;
    if (target) {
      setActiveTab(target);
    }
  });
});

setActiveTab('connect-panel');

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
  dragStartOrder = [];
  questionsList.innerHTML = '';

  safeQuestions.forEach((question, position) => {
    const item = document.createElement('li');
    item.className = 'question-item';
    item.dataset.index = String(question.index);
    item.draggable = safeQuestions.length > 1;

    const dragHandle = document.createElement('span');
    dragHandle.className = 'drag-handle';
    dragHandle.title = 'Перетащите, чтобы изменить порядок';
    if (safeQuestions.length <= 1) {
      dragHandle.classList.add('drag-handle--disabled');
    }

    const numberBadge = document.createElement('span');
    numberBadge.className = 'badge question-number';
    numberBadge.textContent = String(position + 1);

    const content = document.createElement('div');
    content.className = 'question-item__content';

    const promptEl = document.createElement('strong');
    promptEl.className = 'question-item__prompt';
    promptEl.textContent = question.prompt || '';
    content.appendChild(promptEl);

    if (question.imageUrl) {
      const imageHint = document.createElement('div');
      imageHint.className = 'question-item__meta';
      imageHint.textContent = `🖼 ${question.imageUrl}`;
      content.appendChild(imageHint);
    }

    const controls = document.createElement('div');
    controls.className = 'question-item__controls';

    const deleteButton = document.createElement('button');
    deleteButton.type = 'button';
    deleteButton.className = 'question-remove';
    deleteButton.setAttribute('data-action', 'delete');
    deleteButton.textContent = 'Удалить';
    controls.appendChild(deleteButton);

    item.appendChild(dragHandle);
    item.appendChild(numberBadge);
    item.appendChild(content);
    item.appendChild(controls);

    questionsList.appendChild(item);
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

if (restartButton) {
  restartButton.addEventListener('click', () => {
    if (!quizCode || restartButton.disabled) return;
    const confirmation = window.confirm('Перезапустить квиз? Очки игроков обнулятся.');
    if (!confirmation) {
      return;
    }
    socket.emit('restartQuiz', { code: quizCode });
  });
}

if (questionsList) {
  questionsList.addEventListener('click', (event) => {
    const target = event.target.closest('.question-remove');
    if (!target) {
      return;
    }

    if (!quizCode) {
      connectStatus.textContent = 'Сначала подключитесь к квизу.';
      return;
    }

    const item = target.closest('.question-item');
    if (!item) {
      return;
    }

    const questionIndex = Number(item.dataset.index);
    if (Number.isNaN(questionIndex)) {
      return;
    }

    const confirmed = window.confirm('Удалить этот вопрос из списка?');
    if (!confirmed) {
      return;
    }

    socket.emit('deleteQuestion', { code: quizCode, index: questionIndex });
  });

  questionsList.addEventListener('dragstart', (event) => {
    const item = event.target.closest('.question-item');
    if (!item || !item.draggable) {
      return;
    }

    dragStartOrder = Array.from(questionsList.querySelectorAll('.question-item')).map((element) =>
      Number(element.dataset.index)
    );
    item.classList.add('dragging');
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', item.dataset.index);
  });

  questionsList.addEventListener('dragover', (event) => {
    event.preventDefault();

    const dragging = questionsList.querySelector('.dragging');
    if (!dragging) {
      return;
    }

    const target = event.target.closest('.question-item');
    if (!target || target === dragging) {
      return;
    }

    const rect = target.getBoundingClientRect();
    const shouldInsertAfter = event.clientY - rect.top > rect.height / 2;

    if (shouldInsertAfter) {
      questionsList.insertBefore(dragging, target.nextSibling);
    } else {
      questionsList.insertBefore(dragging, target);
    }
  });

  const finalizeDrag = () => {
    const dragging = questionsList.querySelector('.dragging');
    if (dragging) {
      dragging.classList.remove('dragging');
    }
  };

  questionsList.addEventListener('drop', (event) => {
    event.preventDefault();
    if (!quizCode) {
      finalizeDrag();
      return;
    }

    const newOrder = Array.from(questionsList.querySelectorAll('.question-item')).map((element) =>
      Number(element.dataset.index)
    );

    finalizeDrag();

    if (newOrder.length <= 1) {
      return;
    }

    const hasAllItems =
      newOrder.length === dragStartOrder.length &&
      newOrder.every((value) => dragStartOrder.includes(value));

    if (!hasAllItems) {
      dragStartOrder = [];
      return;
    }

    const orderChanged = newOrder.some((value, index) => value !== dragStartOrder[index]);

    dragStartOrder = [];

    if (!orderChanged) {
      return;
    }

    socket.emit('reorderQuestions', { code: quizCode, order: newOrder });
  });

  questionsList.addEventListener('dragend', finalizeDrag);
}

socket.on('adminState', ({ code, questions, players, currentQuestionIndex, questionActive }) => {
  quizCode = code;
  connectStatus.textContent = `Вы управляете квизом ${code}. Добавьте вопросы и зовите игроков!`;
  enableTab('question-panel');
  enableTab('control-panel');
  setActiveTab('question-panel');
  renderQuestions(questions);
  renderPlayers(players);
  if (!questionActive) {
    launchButton.disabled = false;
    revealButton.disabled = true;
  }
  if (restartButton) {
    restartButton.disabled = false;
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
  if (restartButton) {
    restartButton.disabled = false;
  }
});

socket.on('questionResults', ({ correctOption, correctPlayersCount, scoreboard, isLastQuestion }) => {
  gameStatus.textContent = `Вопрос завершён. Правильных ответов: ${correctPlayersCount}. Правильный вариант: ${correctOption + 1}.`;
  launchButton.disabled = isLastQuestion;
  revealButton.disabled = true;
  finalButton.disabled = !isLastQuestion;
  lastScoreboard = scoreboard;
  renderScoreboard(scoreboard);
  if (restartButton) {
    restartButton.disabled = false;
  }
});

socket.on('quizFinished', ({ scoreboard, totalQuestions }) => {
  lastScoreboard = scoreboard;
  renderScoreboard(scoreboard);
  gameStatus.textContent = `Финал! Всего вопросов: ${totalQuestions}. Победитель: ${scoreboard[0] ? scoreboard[0].name : '—'}.`;
  launchButton.disabled = true;
  revealButton.disabled = true;
  finalButton.disabled = true;
  if (restartButton) {
    restartButton.disabled = false;
  }
});

socket.on('quizRestarted', ({ scoreboard, message }) => {
  lastScoreboard = scoreboard || [];
  renderScoreboard(lastScoreboard);
  launchButton.disabled = false;
  revealButton.disabled = true;
  finalButton.disabled = true;
  if (restartButton) {
    restartButton.disabled = false;
  }
  const statusText = message || 'Квиз сброшен. Всё готово к новому началу!';
  gameStatus.textContent = statusText;
  renderPlayers(Array.isArray(scoreboard) ? scoreboard : []);
});

socket.on('errorMessage', (message) => {
  connectStatus.textContent = message;
});

socket.on('disconnect', () => {
  connectStatus.textContent = 'Связь потеряна. Проверьте интернет и обновите страницу.';
  quizCode = '';
  disableTab('question-panel');
  disableTab('control-panel');
  setActiveTab('connect-panel');
});
