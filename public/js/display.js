const socket = io();

const displayForm = document.getElementById('display-form');
const displayCodeInput = document.getElementById('display-code');
const displayStatus = document.getElementById('display-status');
const connectPanel = document.getElementById('connect-panel');

const waitingPanel = document.getElementById('waiting-panel');
const questionPanel = document.getElementById('question-panel');
const resultsPanel = document.getElementById('results-panel');
const finalPanel = document.getElementById('final-panel');

const questionCounter = document.getElementById('question-counter');
const questionTitle = document.getElementById('question-title');
const questionText = document.getElementById('question-text');
const questionImageWrapper = document.getElementById('question-image-wrapper');
const questionImage = document.getElementById('question-image');
const questionOptions = document.getElementById('question-options');

const resultsCounter = document.getElementById('results-counter');
const resultsQuestion = document.getElementById('results-question');
const resultsImageWrapper = document.getElementById('results-image-wrapper');
const resultsImage = document.getElementById('results-image');
const resultsBreakdown = document.getElementById('results-breakdown');
const resultsSummary = document.getElementById('results-summary');
const displayScoreboard = document.getElementById('display-scoreboard');
const nextHint = document.getElementById('next-hint');

const finalTitle = document.getElementById('final-title');
const finalScoreboard = document.getElementById('final-scoreboard');
const finalHint = document.getElementById('final-hint');

let quizCode = '';

const params = new URLSearchParams(window.location.search);
if (params.get('quiz')) {
  const codeFromQuery = params.get('quiz').toUpperCase();
  displayCodeInput.value = codeFromQuery;
  quizCode = codeFromQuery;
}

const hideAllStages = () => {
  waitingPanel.hidden = true;
  questionPanel.hidden = true;
  resultsPanel.hidden = true;
  finalPanel.hidden = true;
};

const renderOptions = (options) => {
  questionOptions.innerHTML = '';
  options.forEach((option, index) => {
    const li = document.createElement('li');
    li.innerHTML = `<span class="badge">${index + 1}</span> ${option}`;
    questionOptions.appendChild(li);
  });
};

const renderBreakdown = ({ options, optionCounts, correctOption }) => {
  resultsBreakdown.innerHTML = '';
  if (!options || !optionCounts) return;

  const maxCount = Math.max(...optionCounts, 1);

  options.forEach((option, index) => {
    const count = optionCounts[index] || 0;
    const percentage = Math.round((count / maxCount) * 100);
    const li = document.createElement('li');
    li.className = 'breakdown-row';
    if (index === correctOption) {
      li.classList.add('correct');
    }
    li.innerHTML = `
      <div class="breakdown-label"><span class="badge">${index + 1}</span> ${option}</div>
      <div class="breakdown-bar" style="width: ${percentage}%"></div>
      <div class="breakdown-count">${count}</div>
    `;
    resultsBreakdown.appendChild(li);
  });
};

const renderScoreboard = (table, rows) => {
  table.innerHTML = '';
  if (!rows || rows.length === 0) {
    return;
  }
  const header = document.createElement('tr');
  header.innerHTML = '<th>#</th><th>Игрок</th><th>Очки</th>';
  table.appendChild(header);
  rows.forEach((row, index) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${index + 1}</td><td>${row.name}</td><td>${row.score}</td>`;
    table.appendChild(tr);
  });
};

const resetToWaiting = () => {
  hideAllStages();
  waitingPanel.hidden = false;
  resultsSummary.textContent = '';
  nextHint.textContent = '';
  displayScoreboard.innerHTML = '';
  resultsBreakdown.innerHTML = '';
  finalScoreboard.innerHTML = '';
};

displayForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const code = displayCodeInput.value.trim().toUpperCase();
  if (!code) {
    displayStatus.textContent = 'Введите код квиза.';
    return;
  }

  quizCode = code;
  displayStatus.textContent = 'Подключаемся к трансляции...';
  socket.emit('registerDisplay', { code });
});

socket.on('displayState', ({ status, code, message }) => {
  if (status === 'error') {
    displayStatus.textContent = message || 'Не удалось подключиться.';
    return;
  }

  if (status === 'connected' && code) {
    displayStatus.textContent = `Экран подключён к квизу ${code}.`;
    connectPanel.classList.add('connected');
    displayCodeInput.value = code;
    displayCodeInput.readOnly = true;
    quizCode = code;
    return;
  }

  if (status === 'waiting') {
    displayStatus.textContent = 'Ждём действий ведущего.';
    resetToWaiting();
  }
});

socket.on('questionStarted', ({ index, total, prompt, imageUrl, options }) => {
  hideAllStages();
  questionPanel.hidden = false;

  questionCounter.textContent = `Вопрос ${index} / ${total}`;
  questionTitle.textContent = 'Вопрос';
  questionText.textContent = prompt;

  if (imageUrl) {
    questionImageWrapper.hidden = false;
    questionImage.src = imageUrl;
  } else {
    questionImageWrapper.hidden = true;
    questionImage.src = '';
  }

  renderOptions(options);
  displayStatus.textContent = 'В эфире — активный вопрос!';
});

socket.on('questionResults', ({ question, correctOption, correctPlayersCount, optionCounts, totalAnswers, scoreboard, isLastQuestion }) => {
  hideAllStages();
  resultsPanel.hidden = false;

  if (question) {
    resultsCounter.textContent = `Вопрос ${question.index} / ${question.total}`;
    resultsQuestion.textContent = question.prompt;
    if (question.imageUrl) {
      resultsImageWrapper.hidden = false;
      resultsImage.src = question.imageUrl;
    } else {
      resultsImageWrapper.hidden = true;
      resultsImage.src = '';
    }
    renderBreakdown({ options: question.options, optionCounts, correctOption });
  }

  const summaryParts = [];
  summaryParts.push(`Правильный ответ: вариант ${correctOption + 1}.`);
  summaryParts.push(`Правильно ответили ${correctPlayersCount} из ${totalAnswers || 0}.`);
  resultsSummary.textContent = summaryParts.join(' ');

  renderScoreboard(displayScoreboard, scoreboard);
  nextHint.textContent = isLastQuestion
    ? 'Это был последний вопрос — попросите ведущего показать финал!'
    : 'Готовьтесь к следующему вопросу. Ведущий решает, когда продолжить.';
  displayStatus.textContent = 'Показаны результаты вопроса.';
});

socket.on('quizFinished', ({ scoreboard, totalQuestions }) => {
  hideAllStages();
  finalPanel.hidden = false;
  const winners = scoreboard && scoreboard.length > 0 ? scoreboard.filter((row) => row.score === scoreboard[0].score) : [];
  const winnerNames = winners.map((row) => row.name).join(', ');
  finalTitle.textContent = `Квиз завершён! Всего вопросов: ${totalQuestions}.`;
  finalHint.textContent = winners.length > 0 ? `Победители: ${winnerNames}.` : 'Ни один игрок не набрал очки — загадка века!';
  renderScoreboard(finalScoreboard, scoreboard);
  displayStatus.textContent = 'Показана финальная статистика.';
});

socket.on('quizRestarted', ({ message }) => {
  resetToWaiting();
  displayStatus.textContent = message || 'Ведущий начал игру заново. Ждём новый вопрос.';
});

socket.on('disconnect', () => {
  displayStatus.textContent = 'Соединение потеряно. Проверьте интернет и перезагрузите страницу.';
});
