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
  createdAt: new Date().toISOString(),
  adminSocketId: null,
  questions: [],
  currentQuestionIndex: -1,
  questionActive: false,
  answers: new Map(),
  players: new Map(),
  playerRecords: new Map(),
  displaySockets: new Set(),
  activeQuestionPayload: null,
  lastResults: null,
  finalResults: null
});

const normalizePlayerName = (name) => name.trim().toLowerCase();

const listPlayerSummaries = (quiz) =>
  Array.from(quiz.playerRecords.values()).map(({ name, score }) => ({ name, score }));

const buildScoreboard = (quiz) =>
  listPlayerSummaries(quiz).sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, 'ru'));

const persistentDir = path.join(__dirname, '..', 'data');
const quizzesFilePath = path.join(persistentDir, 'quizzes.json');

fs.mkdirSync(persistentDir, { recursive: true });

const serializeQuiz = (quiz) => ({
  code: quiz.code,
  createdAt: quiz.createdAt,
  questions: quiz.questions,
  currentQuestionIndex: quiz.currentQuestionIndex,
  playerRecords: Array.from(quiz.playerRecords.entries()).map(([key, record]) => ({
    key,
    name: record.name,
    score: record.score
  })),
  lastResults: quiz.lastResults,
  finalResults: quiz.finalResults
});

const deserializeQuiz = (rawQuiz) => {
  if (!rawQuiz || !rawQuiz.code) {
    return null;
  }

  const quiz = defaultQuiz(rawQuiz.code);
  quiz.createdAt = rawQuiz.createdAt || quiz.createdAt;
  quiz.questions = Array.isArray(rawQuiz.questions) ? rawQuiz.questions : [];
  if (typeof rawQuiz.currentQuestionIndex === 'number') {
    const maxIndex = quiz.questions.length - 1;
    quiz.currentQuestionIndex = Math.min(Math.max(rawQuiz.currentQuestionIndex, -1), maxIndex);
  }
  quiz.questionActive = false;
  const playerRecords = Array.isArray(rawQuiz.playerRecords) ? rawQuiz.playerRecords : [];
  playerRecords.forEach((record) => {
    if (!record || !record.key) {
      return;
    }
    quiz.playerRecords.set(record.key, {
      name: record.name || record.key,
      score: typeof record.score === 'number' ? record.score : 0,
      answeredCurrent: false,
      lastAnswerCorrect: null,
      socketId: null,
      key: record.key
    });
  });
  quiz.lastResults = rawQuiz.lastResults || null;
  quiz.finalResults = rawQuiz.finalResults || null;
  return quiz;
};

const writeQuizzesToDisk = () => {
  const payload = {
    version: 1,
    quizzes: Array.from(quizzes.values()).map(serializeQuiz)
  };

  const tmpPath = `${quizzesFilePath}.tmp`;
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2), 'utf-8');
    fs.renameSync(tmpPath, quizzesFilePath);
  } catch (error) {
    console.error('Failed to persist quizzes:', error);
    try {
      if (fs.existsSync(tmpPath)) {
        fs.unlinkSync(tmpPath);
      }
    } catch (cleanupError) {
      console.error('Failed to clean up temp persistence file:', cleanupError);
    }
  }
};

let persistTimeout = null;
const schedulePersist = () => {
  if (persistTimeout) {
    clearTimeout(persistTimeout);
  }
  persistTimeout = setTimeout(() => {
    persistTimeout = null;
    writeQuizzesToDisk();
  }, 250);
};

const loadPersistedQuizzes = () => {
  if (!fs.existsSync(quizzesFilePath)) {
    return;
  }

  try {
    const rawContent = fs.readFileSync(quizzesFilePath, 'utf-8');
    const parsed = JSON.parse(rawContent);
    const storedQuizzes = parsed && Array.isArray(parsed.quizzes) ? parsed.quizzes : [];
    storedQuizzes.forEach((storedQuiz) => {
      const quiz = deserializeQuiz(storedQuiz);
      if (quiz) {
        quizzes.set(quiz.code, quiz);
      }
    });
  } catch (error) {
    console.error('Failed to load quizzes from disk:', error);
  }
};

loadPersistedQuizzes();

const getOrCreateQuiz = (code) => {
  if (!quizzes.has(code)) {
    quizzes.set(code, defaultQuiz(code));
  }
  const quiz = quizzes.get(code);
  quiz.players = quiz.players || new Map();
  quiz.playerRecords = quiz.playerRecords || new Map();
  return quiz;
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

app.use(express.json());
app.use('/uploads', express.static(uploadsDir));
app.use(express.static(publicDir));

const measureQuizSize = (quiz) => {
  const serialized = serializeQuiz(quiz);
  return Buffer.byteLength(JSON.stringify(serialized), 'utf-8');
};

const dropQuiz = (code) => {
  const quiz = quizzes.get(code);
  if (!quiz) {
    return false;
  }

  io.to(code).emit('systemMessage', 'Квиз удалён администратором.');
  io.in(code).socketsLeave(code);
  quizzes.delete(code);
  schedulePersist();
  return true;
};

app.get(['/display', '/display.html'], (_req, res) => {
  res.sendFile(path.join(publicDir, 'display.html'));
});

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.get('/api/quizzes', (_req, res) => {
  const summary = Array.from(quizzes.values()).map((quiz) => ({
    code: quiz.code,
    createdAt: quiz.createdAt,
    questionCount: Array.isArray(quiz.questions) ? quiz.questions.length : 0,
    sizeBytes: measureQuizSize(quiz)
  }));

  res.json({ quizzes: summary });
});

app.delete('/api/quizzes/:code', (req, res) => {
  const { code } = req.params;
  if (!code) {
    res.status(400).json({ error: 'Неверный код квиза.' });
    return;
  }

  const normalizedCode = code.trim().toUpperCase();
  if (!dropQuiz(normalizedCode)) {
    res.status(404).json({ error: 'Квиз не найден.' });
    return;
  }

  res.json({ success: true, code: normalizedCode });
});

app.post('/api/quizzes/bulk-delete', (req, res) => {
  const { codes } = req.body || {};
  if (!Array.isArray(codes) || codes.length === 0) {
    res.status(400).json({ error: 'Передайте массив кодов для удаления.' });
    return;
  }

  const normalizedCodes = codes
    .map((value) => (typeof value === 'string' ? value.trim().toUpperCase() : ''))
    .filter((value) => value.length > 0);

  const uniqueCodes = Array.from(new Set(normalizedCodes));
  const deleted = uniqueCodes.filter((code) => dropQuiz(code));

  res.json({ success: true, deleted });
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

    schedulePersist();

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
      players: listPlayerSummaries(quiz),
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

    schedulePersist();

    socket.emit('adminState', {
      code,
      questions: sanitizeQuestions(quiz.questions),
      players: listPlayerSummaries(quiz),
      currentQuestionIndex: quiz.currentQuestionIndex,
      questionActive: quiz.questionActive
    });
  });

  socket.on('deleteQuestion', ({ code, index }) => {
    const quiz = ensureAdmin(socket, code);
    if (!quiz) {
      return;
    }

    if (quiz.questionActive) {
      socket.emit('errorMessage', 'Нельзя удалять вопрос, пока он идёт в эфире.');
      return;
    }

    const questionIndex = Number(index);
    if (Number.isNaN(questionIndex) || questionIndex < 0 || questionIndex >= quiz.questions.length) {
      return;
    }

    quiz.questions.splice(questionIndex, 1);

    if (quiz.questions.length === 0) {
      quiz.currentQuestionIndex = -1;
    } else if (quiz.currentQuestionIndex >= questionIndex) {
      quiz.currentQuestionIndex = Math.max(-1, quiz.currentQuestionIndex - 1);
    }

    quiz.activeQuestionPayload = null;
    quiz.lastResults = null;
    quiz.finalResults = null;

    schedulePersist();

    socket.emit('adminState', {
      code,
      questions: sanitizeQuestions(quiz.questions),
      players: listPlayerSummaries(quiz),
      currentQuestionIndex: quiz.currentQuestionIndex,
      questionActive: quiz.questionActive
    });
  });

  socket.on('reorderQuestions', ({ code, order }) => {
    const quiz = ensureAdmin(socket, code);
    if (!quiz) {
      return;
    }

    if (quiz.questionActive) {
      socket.emit('errorMessage', 'Нельзя менять порядок во время активного вопроса.');
      return;
    }

    if (!Array.isArray(order) || order.length !== quiz.questions.length) {
      return;
    }

    const normalizedOrder = order.map((value) => Number(value));
    if (normalizedOrder.some((value) => Number.isNaN(value) || value < 0 || value >= quiz.questions.length)) {
      return;
    }

    const uniqueValues = new Set(normalizedOrder);
    if (uniqueValues.size !== quiz.questions.length) {
      return;
    }

    const previousQuestions = quiz.questions.slice();
    const currentQuestion =
      quiz.currentQuestionIndex >= 0 && quiz.currentQuestionIndex < previousQuestions.length
        ? previousQuestions[quiz.currentQuestionIndex]
        : null;

    quiz.questions = normalizedOrder.map((value) => previousQuestions[value]);

    if (currentQuestion) {
      const newIndex = quiz.questions.findIndex((question) => question === currentQuestion);
      quiz.currentQuestionIndex = newIndex;
    } else if (quiz.questions.length === 0) {
      quiz.currentQuestionIndex = -1;
    } else if (quiz.currentQuestionIndex >= quiz.questions.length) {
      quiz.currentQuestionIndex = quiz.questions.length - 1;
    }

    quiz.activeQuestionPayload = null;
    quiz.lastResults = null;
    quiz.finalResults = null;

    schedulePersist();

    socket.emit('adminState', {
      code,
      questions: sanitizeQuestions(quiz.questions),
      players: listPlayerSummaries(quiz),
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
    quiz.playerRecords.forEach((player) => {
      player.answeredCurrent = false;
      player.lastAnswerCorrect = null;
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

    schedulePersist();

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

    const scoreboard = buildScoreboard(quiz);

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

    schedulePersist();

    io.to(code).emit('questionResults', resultPayload);
  });

  socket.on('showFinal', ({ code }) => {
    const quiz = ensureAdmin(socket, code);
    if (!quiz) {
      return;
    }

    const scoreboard = buildScoreboard(quiz);

    const finalPayload = {
      scoreboard,
      totalQuestions: quiz.questions.length
    };

    quiz.finalResults = finalPayload;

    schedulePersist();

    io.to(code).emit('quizFinished', finalPayload);
  });

  socket.on('restartQuiz', ({ code }) => {
    const quiz = ensureAdmin(socket, code);
    if (!quiz) {
      return;
    }

    quiz.currentQuestionIndex = -1;
    quiz.questionActive = false;
    quiz.answers = new Map();
    quiz.activeQuestionPayload = null;
    quiz.lastResults = null;
    quiz.finalResults = null;

    quiz.playerRecords.forEach((player) => {
      player.score = 0;
      player.answeredCurrent = false;
      player.lastAnswerCorrect = null;
    });

    schedulePersist();

    const scoreboard = buildScoreboard(quiz);
    const message = 'Ведущий начал игру заново. Ждите новый вопрос!';

    io.to(code).emit('quizRestarted', { scoreboard, message });

    socket.emit('adminState', {
      code,
      questions: sanitizeQuestions(quiz.questions),
      players: listPlayerSummaries(quiz),
      currentQuestionIndex: quiz.currentQuestionIndex,
      questionActive: quiz.questionActive
    });

    if (quiz.adminSocketId) {
      io.to(quiz.adminSocketId).emit('playersUpdated', listPlayerSummaries(quiz));
    }
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

    const playerKey = normalizePlayerName(playerName);
    let playerRecord = quiz.playerRecords.get(playerKey);

    if (playerRecord && playerRecord.socketId && playerRecord.socketId !== socket.id) {
      const previousSocketId = playerRecord.socketId;
      quiz.players.delete(previousSocketId);
      const previousSocket = io.sockets.sockets.get(previousSocketId);
      if (previousSocket) {
        previousSocket.emit('systemMessage', 'Ваш логин был использован с другого устройства.');
        previousSocket.disconnect(true);
      }
    }

    if (playerRecord) {
      playerRecord.name = playerName;
      playerRecord.key = playerRecord.key || playerKey;
      playerRecord.socketId = socket.id;
    } else {
      playerRecord = {
        name: playerName,
        score: 0,
        answeredCurrent: false,
        lastAnswerCorrect: null,
        socketId: socket.id,
        key: playerKey
      };
      quiz.playerRecords.set(playerKey, playerRecord);
    }

    quiz.players.set(socket.id, playerRecord);

    schedulePersist();

    socket.join(normalizedCode);
    socket.emit('joined', {
      code: normalizedCode,
      currentQuestionIndex: quiz.currentQuestionIndex,
      questionActive: quiz.questionActive,
      answeredCurrent: Boolean(playerRecord.answeredCurrent)
    });

    if (quiz.finalResults) {
      socket.emit('quizFinished', quiz.finalResults);
    } else if (quiz.questionActive && quiz.activeQuestionPayload) {
      socket.emit('questionStarted', quiz.activeQuestionPayload);
      if (playerRecord.answeredCurrent) {
        const existingAnswer = quiz.answers.get(playerRecord.key);
        if (existingAnswer) {
          socket.emit('answerAccepted', {
            isCorrect: existingAnswer.isCorrect,
            optionIndex: existingAnswer.optionIndex
          });
        } else {
          socket.emit('answerError', 'Ответ уже отправлен.');
        }
      }
    } else if (quiz.lastResults) {
      socket.emit('questionResults', quiz.lastResults);
    }

    if (quiz.adminSocketId) {
      io.to(quiz.adminSocketId).emit('playersUpdated', listPlayerSummaries(quiz));
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

    player.key = player.key || normalizePlayerName(player.name);
    const question = quiz.questions[quiz.currentQuestionIndex];
    const selectedIndex = Number(optionIndex);
    const isCorrect = selectedIndex === question.correctIndex;
    if (isCorrect) {
      player.score += 1;
    }

    player.answeredCurrent = true;
    player.lastAnswerCorrect = isCorrect;
    quiz.answers.set(player.key, {
      playerId: player.key,
      name: player.name,
      optionIndex: selectedIndex,
      isCorrect
    });

    schedulePersist();

    socket.emit('answerAccepted', {
      isCorrect,
      optionIndex: selectedIndex
    });
  });

  socket.on('disconnect', () => {
    quizzes.forEach((quiz, code) => {
      if (quiz.adminSocketId === socket.id) {
        quiz.adminSocketId = null;
        io.to(code).emit('systemMessage', 'Ведущий отключился. Подождите, пока он вернётся.');
      }

      const playerRecord = quiz.players.get(socket.id);
      if (playerRecord) {
        quiz.players.delete(socket.id);
        if (playerRecord.socketId === socket.id) {
          playerRecord.socketId = null;
        }
        if (quiz.adminSocketId) {
          io.to(quiz.adminSocketId).emit('playersUpdated', listPlayerSummaries(quiz));
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
