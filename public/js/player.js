const socket = io();

const joinForm = document.getElementById('join-form');
const joinCodeInput = document.getElementById('join-code');
const joinStatus = document.getElementById('join-status');
const playerNameInput = document.getElementById('player-name');
const joinPanel = document.getElementById('join-panel');
const waitingPanel = document.getElementById('waiting-panel');
const questionPanel = document.getElementById('question-panel');
const questionCounter = document.getElementById('question-counter');
const questionInstructions = document.getElementById('question-instructions');
const optionsContainer = document.getElementById('options');
const answerStatus = document.getElementById('answer-status');
const resultsPanel = document.getElementById('results-panel');
const resultsSummary = document.getElementById('results-summary');
const resultsTable = document.getElementById('results-table');
const finalMessage = document.getElementById('final-message');
const systemMessages = document.getElementById('system-messages');

let quizCode = '';
let playerName = '';
let hasAnsweredCurrent = false;
let pendingAnsweredFlag = false;

const params = new URLSearchParams(window.location.search);
if (params.get('quiz')) {
  const code = params.get('quiz').toUpperCase();
  joinCodeInput.value = code;
  joinCodeInput.readOnly = true;
  document.getElementById('code-label').style.display = 'none';
  quizCode = code;
}

const renderScoreboard = (rows) => {
  resultsTable.innerHTML = '';
  if (!rows || rows.length === 0) {
    return;
  }
  const header = document.createElement('tr');
  header.innerHTML = '<th>#</th><th>Игрок</th><th>Очки</th>';
  resultsTable.appendChild(header);
  rows.forEach((row, index) => {
    const tr = document.createElement('tr');
    if (row.name === playerName) {
      tr.classList.add('highlight');
    }
    tr.innerHTML = `<td>${index + 1}</td><td>${row.name}</td><td>${row.score}</td>`;
    resultsTable.appendChild(tr);
  });
};

joinForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const code = (quizCode || joinCodeInput.value.trim().toUpperCase());
  const name = playerNameInput.value.trim();
  if (!code || !name) {
    joinStatus.textContent = 'Заполните все поля.';
    return;
  }
  quizCode = code;
  playerName = name;
  joinStatus.textContent = 'Подключаемся...';
  socket.emit('joinQuiz', { code, name });
});

const resetQuestionUI = () => {
  optionsContainer.innerHTML = '';
  answerStatus.textContent = '';
};

socket.on('joined', ({ code, answeredCurrent }) => {
  quizCode = code;
  joinPanel.hidden = true;
  waitingPanel.hidden = false;
  joinStatus.textContent = '';
  pendingAnsweredFlag = Boolean(answeredCurrent);
  hasAnsweredCurrent = pendingAnsweredFlag;
  systemMessages.textContent = 'Ждём новый вопрос от ведущего. Следите за экраном трансляции!';
});

socket.on('joinError', (message) => {
  joinStatus.textContent = message;
});

socket.on('questionStarted', ({ index, total, options }) => {
  waitingPanel.hidden = true;
  resultsPanel.hidden = true;
  questionPanel.hidden = false;
  resetQuestionUI();
  hasAnsweredCurrent = pendingAnsweredFlag;
  questionCounter.textContent = `Вопрос ${index} из ${total}`;
  questionInstructions.textContent = 'Смотрите на общий экран и выберите подходящий номер.';

  options.forEach((option, optionIndex) => {
    const button = document.createElement('button');
    button.className = 'option-button';
    button.textContent = `${optionIndex + 1}. ${option}`;
    button.title = option;
    button.addEventListener('click', () => {
      if (hasAnsweredCurrent) return;
      socket.emit('submitAnswer', { code: quizCode, optionIndex });
      hasAnsweredCurrent = true;
      button.classList.add('selected');
      disableOptions();
    });
    optionsContainer.appendChild(button);
  });

  if (hasAnsweredCurrent) {
    disableOptions();
    answerStatus.textContent = 'Ответ уже отправлен. Ждём остальных игроков...';
  }
  pendingAnsweredFlag = false;
});

const disableOptions = () => {
  optionsContainer.querySelectorAll('button').forEach((button) => {
    button.disabled = true;
  });
};

const highlightOption = (optionIndex) => {
  const buttons = optionsContainer.querySelectorAll('button');
  if (typeof optionIndex === 'number' && buttons[optionIndex]) {
    buttons[optionIndex].classList.add('selected');
  }
};

socket.on('answerAccepted', ({ isCorrect, optionIndex }) => {
  hasAnsweredCurrent = true;
  if (typeof optionIndex === 'number') {
    highlightOption(optionIndex);
  }
  disableOptions();
  answerStatus.textContent = isCorrect
    ? 'Верно! Ждём остальных игроков...'
    : 'Ответ принят. Посмотрим, правильный ли он!';
});

socket.on('answerError', (message) => {
  answerStatus.textContent = message;
  if (message && message.toLowerCase().includes('уже отправлен')) {
    hasAnsweredCurrent = true;
    disableOptions();
  }
});

socket.on('questionResults', ({ correctOption, correctPlayersCount, scoreboard, isLastQuestion }) => {
  hasAnsweredCurrent = false;
  pendingAnsweredFlag = false;
  questionPanel.hidden = true;
  resultsPanel.hidden = false;
  resultsSummary.textContent = `Правильный вариант: ${correctOption + 1}. Правильных ответов: ${correctPlayersCount}.`;
  renderScoreboard(scoreboard);
  finalMessage.textContent = isLastQuestion
    ? 'Это был последний вопрос! Ждите финальную статистику от ведущего.'
    : 'Готовьтесь к следующему вопросу — ведущий решает, когда начать.';
});

socket.on('quizFinished', ({ scoreboard, totalQuestions }) => {
  hasAnsweredCurrent = false;
  pendingAnsweredFlag = false;
  waitingPanel.hidden = true;
  questionPanel.hidden = true;
  resultsPanel.hidden = false;
  resultsSummary.textContent = `Квиз завершён! Всего вопросов: ${totalQuestions}.`;
  renderScoreboard(scoreboard);
  if (scoreboard.length > 0) {
    const leaders = scoreboard.filter((row) => row.score === scoreboard[0].score);
    const winnerNames = leaders.map((row) => row.name).join(', ');
    finalMessage.textContent = `Победители: ${winnerNames}!`;
  } else {
    finalMessage.textContent = 'Победителей нет — никто не ответил?';
  }
});

socket.on('quizRestarted', ({ scoreboard, message }) => {
  hasAnsweredCurrent = false;
  pendingAnsweredFlag = false;
  resetQuestionUI();
  questionPanel.hidden = true;
  resultsPanel.hidden = true;
  waitingPanel.hidden = false;
  resultsSummary.textContent = '';
  finalMessage.textContent = '';
  answerStatus.textContent = '';
  if (Array.isArray(scoreboard) && scoreboard.length > 0) {
    renderScoreboard(scoreboard);
  } else {
    resultsTable.innerHTML = '';
  }
  systemMessages.textContent = message || 'Ведущий начал игру заново. Готовьтесь к новому старту!';
});

socket.on('systemMessage', (message) => {
  systemMessages.textContent = message;
});

socket.on('disconnect', () => {
  systemMessages.textContent = 'Соединение потеряно. Попробуйте обновить страницу.';
});
