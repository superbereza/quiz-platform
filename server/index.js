const fs = require('fs');
const path = require('path');
const express = require('express');
const http = require('http');
const multer = require('multer');
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
  players: new Map(),
  displaySockets: new Set(),
  activeQuestionPayload: null,
  lastResults: null,
  finalResults: null
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

const sendDisplaySnapshot = (socket, quiz) => {
  if (quiz.questionActive && quiz.activeQuestionPayload) {
    socket.emit('questionStarted', quiz.activeQuestionPayload);
    return;
  }

  if (quiz.finalResults) {
    socket.emit('quizFinished', quiz.finalResults);
    return;
  }

  if (quiz.lastResults) {
    socket.emit('questionResults', quiz.lastResults);
    return;
  }

  socket.emit('displayState', {
    code: quiz.code,
    status: 'waiting'
  });
};

const sanitizeQuestions = (questions) =>
  questions.map(({ prompt, imageUrl, options }, index) => ({
    index,
    prompt,
    imageUrl,
    options
  }));

const publicDir = path.join(__dirname, '..', 'public');
const uploadsDir = path.join(__dirname, '..', 'uploads');

fs.mkdirSync(uploadsDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const base = path.basename(file.originalname, ext);
    const safeBase = base
      .normalize('NFKD')
      .replace(/[^a-zA-Z0-9-_]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .toLowerCase() || 'image';
    const stamp = Date.now();
    cb(null, `${safeBase}-${stamp}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (['image/jpeg', 'image/png'].includes(file.mimetype)) {
      cb(null, true);
      return;
    }
    const error = new Error('UNSUPPORTED_FILE_TYPE');
    error.code = 'UNSUPPORTED_FILE_TYPE';
    cb(error);
  }
});

const singleImageUpload = upload.single('image');

app.use('/uploads', express.static(uploadsDir));
app.use(express.static(publicDir));

app.get(['/display', '/display.html'], (_req, res) => {
  res.sendFile(path.join(publicDir, 'display.html'));
});

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.post('/api/upload-image', (req, res) => {
  singleImageUpload(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: 'Файл больше 5 МБ. Выберите изображение поменьше.' });
      }
      if (err.code === 'UNSUPPORTED_FILE_TYPE') {
        return res.status(400).json({ error: 'Поддерживаются только JPG и PNG.' });
      }
      return res.status(400).json({ error: 'Не удалось загрузить файл.' });
    }

    if (!req.file) {
      return res.status(400).json({ error: 'Файл не загружен.' });
    }

    return res.json({ url: `/uploads/${req.file.filename}` });
  });
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
    quiz.displaySockets = quiz.displaySockets || new Set();
    quiz.activeQuestionPayload = null;
    quiz.lastResults = null;
    quiz.finalResults = null;

    socket.join(normalizedCode);

    if (quiz.displaySockets.size > 0) {
      quiz.displaySockets.forEach((displaySocketId) => {
        io.to(displaySocketId).emit('displayState', {
          code: normalizedCode,
          status: 'waiting'
        });
      });
    }

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

    quiz.activeQuestionPayload = null;
    quiz.lastResults = null;
    quiz.finalResults = null;

    const question = quiz.questions[quiz.currentQuestionIndex];
    const payload = {
      index: quiz.currentQuestionIndex + 1,
      total: quiz.questions.length,
      prompt: question.prompt,
      imageUrl: question.imageUrl,
      options: question.options
    };

    quiz.activeQuestionPayload = payload;

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
    const optionCounts = new Array(question.options.length).fill(0);
    quiz.answers.forEach((answer) => {
      if (answer.isCorrect) {
        correctPlayersCount += 1;
      }
      if (typeof answer.optionIndex === 'number' && optionCounts[answer.optionIndex] !== undefined) {
        optionCounts[answer.optionIndex] += 1;
      }
    });

    quiz.questionActive = false;
    quiz.activeQuestionPayload = null;

    const scoreboard = Array.from(quiz.players.values())
      .map(({ name, score }) => ({ name, score }))
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, 'ru'));

    const resultPayload = {
      correctOption,
      correctPlayersCount,
      scoreboard,
      optionCounts,
      totalAnswers: quiz.answers.size,
      question: {
        index: quiz.currentQuestionIndex + 1,
        total: quiz.questions.length,
        prompt: question.prompt,
        imageUrl: question.imageUrl,
        options: question.options
      },
      isLastQuestion: quiz.currentQuestionIndex === quiz.questions.length - 1
    };

    quiz.lastResults = resultPayload;
    quiz.finalResults = null;

    io.to(code).emit('questionResults', resultPayload);
  });

  socket.on('showFinal', ({ code }) => {
    const quiz = ensureAdmin(socket, code);
    if (!quiz) {
      return;
    }

    const scoreboard = Array.from(quiz.players.values())
      .map(({ name, score }) => ({ name, score }))
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, 'ru'));

    const finalPayload = {
      scoreboard,
      totalQuestions: quiz.questions.length
    };

    quiz.finalResults = finalPayload;

    io.to(code).emit('quizFinished', finalPayload);
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

      if (quiz.displaySockets && quiz.displaySockets.has(socket.id)) {
        quiz.displaySockets.delete(socket.id);
      }
    });
  });

  socket.on('registerDisplay', ({ code }) => {
    if (!code) {
      socket.emit('displayState', { status: 'error', message: 'Нужен код квиза.' });
      return;
    }

    const normalizedCode = code.trim().toUpperCase();
    const quiz = getOrCreateQuiz(normalizedCode);

    if (!quiz.displaySockets) {
      quiz.displaySockets = new Set();
    }

    quiz.displaySockets.add(socket.id);
    socket.join(normalizedCode);

    socket.emit('displayState', {
      code: normalizedCode,
      status: 'connected'
    });

    sendDisplaySnapshot(socket, quiz);
  });
});

server.listen(PORT, () => {
  console.log(`Quiz platform listening on port ${PORT}`);
});

const gracefulShutdown = (signal) => {
  console.log(`Received ${signal}, closing quiz platform...`);

  const closeHttpServer = () =>
    new Promise((resolve) => {
      if (!server.listening) {
        resolve();
        return;
      }

      server.close((err) => {
        if (err) {
          console.error('Error while closing HTTP server', err);
        }
        resolve();
      });
    });

  closeHttpServer()
    .catch((err) => {
      console.error('Unexpected error during shutdown', err);
    })
    .finally(() => {
      io.close();
      process.exit(0);
    });

  // Fallback in case sockets prevent a clean exit.
  setTimeout(() => {
    console.warn('Forcing shutdown after graceful timeout.');
    process.exit(0);
  }, 5000).unref();
};

['SIGINT', 'SIGTERM'].forEach((signal) => {
  process.on(signal, () => gracefulShutdown(signal));
});
