const socket = io();

const joinForm = document.getElementById('join-form');
const joinCodeInput = document.getElementById('join-code');
const joinStatus = document.getElementById('join-status');
const playerNameInput = document.getElementById('player-name');
const joinPanel = document.getElementById('join-panel');
const waitingPanel = document.getElementById('waiting-panel');
const questionPanel = document.getElementById('question-panel');
const questionCounter = document.getElementById('question-counter');
const questionText = document.getElementById('question-text');
const questionImageWrapper = document.getElementById('question-image-wrapper');
const questionImage = document.getElementById('question-image');
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
  hasAnsweredCurrent = false;
};

socket.on('joined', ({ code }) => {
  quizCode = code;
  joinPanel.hidden = true;
  waitingPanel.hidden = false;
  joinStatus.textContent = '';
  systemMessages.textContent = 'Ждём новый вопрос от ведущего.';
});

socket.on('joinError', (message) => {
  joinStatus.textContent = message;
});

socket.on('questionStarted', ({ index, total, prompt, imageUrl, options }) => {
  waitingPanel.hidden = true;
  resultsPanel.hidden = true;
  questionPanel.hidden = false;
  resetQuestionUI();
  questionCounter.textContent = `Вопрос ${index} из ${total}`;
  questionText.textContent = prompt;

  if (imageUrl) {
    questionImageWrapper.hidden = false;
    questionImage.src = imageUrl;
  } else {
    questionImageWrapper.hidden = true;
    questionImage.src = '';
  }

  options.forEach((option, optionIndex) => {
    const button = document.createElement('button');
    button.className = 'option-button';
    button.textContent = `${optionIndex + 1}. ${option}`;
    button.addEventListener('click', () => {
      if (hasAnsweredCurrent) return;
      socket.emit('submitAnswer', { code: quizCode, optionIndex });
      hasAnsweredCurrent = true;
      button.classList.add('selected');
      disableOptions();
    });
    optionsContainer.appendChild(button);
  });
});

const disableOptions = () => {
  optionsContainer.querySelectorAll('button').forEach((button) => {
    button.disabled = true;
  });
};

socket.on('answerAccepted', ({ isCorrect }) => {
  answerStatus.textContent = isCorrect
    ? 'Верно! Ждём остальных игроков...'
    : 'Ответ принят. Посмотрим, правильный ли он!';
});

socket.on('answerError', (message) => {
  answerStatus.textContent = message;
});

socket.on('questionResults', ({ correctOption, correctPlayersCount, scoreboard, isLastQuestion }) => {
  questionPanel.hidden = true;
  resultsPanel.hidden = false;
  resultsSummary.textContent = `Правильный вариант: ${correctOption + 1}. Правильных ответов: ${correctPlayersCount}.`;
  renderScoreboard(scoreboard);
  finalMessage.textContent = isLastQuestion
    ? 'Это был последний вопрос! Ждите финальную статистику от ведущего.'
    : 'Готовьтесь к следующему вопросу — ведущий решает, когда начать.';
});

socket.on('quizFinished', ({ scoreboard, totalQuestions }) => {
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

socket.on('systemMessage', (message) => {
  systemMessages.textContent = message;
});

socket.on('disconnect', () => {
  systemMessages.textContent = 'Соединение потеряно. Попробуйте обновить страницу.';
});
