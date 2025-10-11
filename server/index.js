const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

const quizzes = new Map();

const defaultQuiz = (code) => ({
  code,
  adminSocketId: null,
  questions: [],
  currentQuestionIndex: -1,
  questionActive: false,
  answers: new Map(),
  players: new Map()
});

const getOrCreateQuiz = (code) => {
  if (!quizzes.has(code)) {
    quizzes.set(code, defaultQuiz(code));
  }
  return quizzes.get(code);
};

const ensureAdmin = (socket, code) => {
  const quiz = quizzes.get(code);
  if (!quiz || quiz.adminSocketId !== socket.id) {
    socket.emit('errorMessage', 'Вы больше не управляете этим квизом. Перезагрузите страницу.');
    return null;
  }
  return quiz;
};

const sanitizeQuestions = (questions) =>
  questions.map(({ prompt, imageUrl, options }, index) => ({
    index,
    prompt,
    imageUrl,
    options
  }));

app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

io.on('connection', (socket) => {
  socket.on('registerAdmin', ({ code }) => {
    if (!code) {
      socket.emit('errorMessage', 'Нужен код квиза.');
      return;
    }

    const normalizedCode = code.trim().toUpperCase();
    const quiz = getOrCreateQuiz(normalizedCode);
    quiz.adminSocketId = socket.id;
    quiz.currentQuestionIndex = -1;
    quiz.questionActive = false;
    quiz.answers = new Map();

    socket.join(normalizedCode);

    socket.emit('adminState', {
      code: normalizedCode,
      questions: sanitizeQuestions(quiz.questions),
      players: Array.from(quiz.players.values()).map(({ name, score }) => ({ name, score })),
      currentQuestionIndex: quiz.currentQuestionIndex,
      questionActive: quiz.questionActive
    });
  });

  socket.on('addQuestion', ({ code, prompt, imageUrl, options, correctIndex }) => {
    const quiz = ensureAdmin(socket, code);
    if (!quiz) {
      return;
    }

    if (!prompt || !Array.isArray(options) || options.length !== 4) {
      socket.emit('errorMessage', 'Заполните вопрос и четыре варианта ответа.');
      return;
    }

    const trimmedOptions = options.map((opt) => (opt || '').trim());
    if (trimmedOptions.some((opt) => opt.length === 0)) {
      socket.emit('errorMessage', 'Все варианты ответов должны быть заполнены.');
      return;
    }

    const question = {
      prompt: prompt.trim(),
      imageUrl: imageUrl ? imageUrl.trim() : '',
      options: trimmedOptions,
      correctIndex: Number(correctIndex) || 0
    };
    quiz.questions.push(question);

    socket.emit('adminState', {
      code,
      questions: sanitizeQuestions(quiz.questions),
      players: Array.from(quiz.players.values()).map(({ name, score }) => ({ name, score })),
      currentQuestionIndex: quiz.currentQuestionIndex,
      questionActive: quiz.questionActive
    });
  });

  socket.on('launchNextQuestion', ({ code }) => {
    const quiz = ensureAdmin(socket, code);
    if (!quiz) {
      return;
    }

    if (quiz.questionActive) {
      socket.emit('errorMessage', 'Текущий вопрос ещё идёт. Сначала покажите результаты.');
      return;
    }

    if (quiz.questions.length === 0) {
      socket.emit('errorMessage', 'Сначала добавьте вопросы.');
      return;
    }

    if (quiz.currentQuestionIndex >= quiz.questions.length - 1) {
      socket.emit('errorMessage', 'Вопросы закончились.');
      return;
    }

    quiz.currentQuestionIndex += 1;
    quiz.questionActive = true;
    quiz.answers = new Map();
    quiz.players.forEach((player) => {
      player.answeredCurrent = false;
    });

    const question = quiz.questions[quiz.currentQuestionIndex];
    const payload = {
      index: quiz.currentQuestionIndex + 1,
      total: quiz.questions.length,
      prompt: question.prompt,
      imageUrl: question.imageUrl,
      options: question.options
    };

    io.to(code).emit('questionStarted', payload);
  });

  socket.on('revealResults', ({ code }) => {
    const quiz = ensureAdmin(socket, code);
    if (!quiz) {
      return;
    }

    if (!quiz.questionActive) {
      socket.emit('errorMessage', 'Нет активного вопроса.');
      return;
    }

    const question = quiz.questions[quiz.currentQuestionIndex];
    const correctOption = question.correctIndex;

    let correctPlayersCount = 0;
    quiz.answers.forEach((answer) => {
      if (answer.isCorrect) {
        correctPlayersCount += 1;
      }
    });

    quiz.questionActive = false;

    const scoreboard = Array.from(quiz.players.values())
      .map(({ name, score }) => ({ name, score }))
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, 'ru'));

    io.to(code).emit('questionResults', {
      correctOption,
      correctPlayersCount,
      scoreboard,
      isLastQuestion: quiz.currentQuestionIndex === quiz.questions.length - 1
    });
  });

  socket.on('showFinal', ({ code }) => {
    const quiz = ensureAdmin(socket, code);
    if (!quiz) {
      return;
    }

    const scoreboard = Array.from(quiz.players.values())
      .map(({ name, score }) => ({ name, score }))
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, 'ru'));

    io.to(code).emit('quizFinished', {
      scoreboard,
      totalQuestions: quiz.questions.length
    });
  });

  socket.on('joinQuiz', ({ code, name }) => {
    if (!code || !name) {
      socket.emit('joinError', 'Нужны код квиза и логин.');
      return;
    }

    const normalizedCode = code.trim().toUpperCase();
    const quiz = quizzes.get(normalizedCode);
    if (!quiz) {
      socket.emit('joinError', 'Такой квиз не найден.');
      return;
    }

    const playerName = name.trim();
    if (!playerName) {
      socket.emit('joinError', 'Введите логин.');
      return;
    }

    quiz.players.set(socket.id, {
      id: socket.id,
      name: playerName,
      score: 0,
      answeredCurrent: false
    });

    socket.join(normalizedCode);
    socket.emit('joined', {
      code: normalizedCode,
      currentQuestionIndex: quiz.currentQuestionIndex,
      questionActive: quiz.questionActive
    });

    if (quiz.adminSocketId) {
      io.to(quiz.adminSocketId).emit('playersUpdated', Array.from(quiz.players.values()).map(({ name, score }) => ({ name, score })));
    }
  });

  socket.on('submitAnswer', ({ code, optionIndex }) => {
    const quiz = quizzes.get(code);
    if (!quiz || !quiz.questionActive) {
      socket.emit('answerError', 'Сейчас нельзя отвечать.');
      return;
    }

    const player = quiz.players.get(socket.id);
    if (!player) {
      socket.emit('answerError', 'Вы не участвуете в этом квизе.');
      return;
    }

    if (player.answeredCurrent) {
      socket.emit('answerError', 'Ответ уже отправлен.');
      return;
    }

    const question = quiz.questions[quiz.currentQuestionIndex];
    const isCorrect = Number(optionIndex) === question.correctIndex;
    if (isCorrect) {
      player.score += 1;
    }

    player.answeredCurrent = true;
    quiz.answers.set(socket.id, {
      playerId: socket.id,
      name: player.name,
      optionIndex: Number(optionIndex),
      isCorrect
    });

    socket.emit('answerAccepted', {
      isCorrect
    });
  });

  socket.on('disconnect', () => {
    quizzes.forEach((quiz, code) => {
      if (quiz.adminSocketId === socket.id) {
        quiz.adminSocketId = null;
        io.to(code).emit('systemMessage', 'Ведущий отключился. Подождите, пока он вернётся.');
      }

      if (quiz.players.has(socket.id)) {
        quiz.players.delete(socket.id);
        if (quiz.adminSocketId) {
          io.to(quiz.adminSocketId).emit('playersUpdated', Array.from(quiz.players.values()).map(({ name, score }) => ({ name, score })));
        }
      }
    });
  });
});

server.listen(PORT, () => {
  console.log(`Quiz platform listening on port ${PORT}`);
});
