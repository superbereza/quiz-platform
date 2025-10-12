(() => {
  const state = {
    quizzes: [],
    sortField: 'createdAt',
    sortDirection: 'desc',
    selected: new Set()
  };

  const tableBody = document.querySelector('#quizzes-table tbody');
  const selectAllCheckbox = document.querySelector('#select-all');
  const deleteSelectedButton = document.querySelector('#delete-selected');
  const statusLine = document.querySelector('#action-status');
  const totalSizeLine = document.querySelector('#total-size');
  const sortButtons = document.querySelectorAll('.sort-button');

  const intlDate = new Intl.DateTimeFormat('ru-RU', {
    dateStyle: 'medium',
    timeStyle: 'short'
  });

  const formatSize = (bytes) => {
    if (bytes <= 0) {
      return '0 Б';
    }

    const units = ['Б', 'КБ', 'МБ', 'ГБ'];
    const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    const value = bytes / 1024 ** exponent;
    return `${value.toFixed(exponent === 0 ? 0 : 1)} ${units[exponent]}`;
  };

  const formatDate = (isoString) => {
    if (!isoString) {
      return '—';
    }

    const date = new Date(isoString);
    if (Number.isNaN(date.getTime())) {
      return '—';
    }
    return intlDate.format(date);
  };

  const setStatus = (message, type = 'info') => {
    if (!statusLine) {
      return;
    }
    statusLine.textContent = message || '';
    statusLine.dataset.state = type;
  };

  const updateTotalSize = () => {
    if (!totalSizeLine) {
      return;
    }
    const totalQuizzes = state.quizzes.length;
    const totalBytes = state.quizzes.reduce((sum, quiz) => sum + (quiz.sizeBytes || 0), 0);
    totalSizeLine.textContent = `Всего квизов: ${totalQuizzes} • Общий размер: ${formatSize(totalBytes)}`;
  };

  const updateBulkControls = () => {
    if (!deleteSelectedButton || !selectAllCheckbox) {
      return;
    }
    deleteSelectedButton.disabled = state.selected.size === 0;
    if (state.quizzes.length === 0) {
      selectAllCheckbox.checked = false;
      selectAllCheckbox.indeterminate = false;
      return;
    }
    const selectedCount = state.selected.size;
    if (selectedCount === 0) {
      selectAllCheckbox.checked = false;
      selectAllCheckbox.indeterminate = false;
    } else if (selectedCount === state.quizzes.length) {
      selectAllCheckbox.checked = true;
      selectAllCheckbox.indeterminate = false;
    } else {
      selectAllCheckbox.checked = false;
      selectAllCheckbox.indeterminate = true;
    }
  };

  const renderTable = () => {
    if (!tableBody) {
      return;
    }

    const sorted = [...state.quizzes].sort((a, b) => {
      const direction = state.sortDirection === 'asc' ? 1 : -1;
      if (state.sortField === 'sizeBytes') {
        return direction * ((a.sizeBytes || 0) - (b.sizeBytes || 0));
      }
      if (state.sortField === 'createdAt') {
        const aTime = a.createdAt ? new Date(a.createdAt).getTime() : 0;
        const bTime = b.createdAt ? new Date(b.createdAt).getTime() : 0;
        return direction * (aTime - bTime);
      }
      return direction * a.code.localeCompare(b.code, 'ru');
    });

    tableBody.innerHTML = '';

    sorted.forEach((quiz) => {
      const row = document.createElement('tr');
      row.dataset.code = quiz.code;

      const selectCell = document.createElement('td');
      selectCell.className = 'col-select';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.className = 'row-select';
      checkbox.dataset.code = quiz.code;
      checkbox.checked = state.selected.has(quiz.code);
      selectCell.appendChild(checkbox);
      row.appendChild(selectCell);

      const codeCell = document.createElement('td');
      codeCell.className = 'mono';
      codeCell.textContent = quiz.code;
      row.appendChild(codeCell);

      const createdAtCell = document.createElement('td');
      createdAtCell.textContent = formatDate(quiz.createdAt);
      row.appendChild(createdAtCell);

      const questionCountCell = document.createElement('td');
      questionCountCell.textContent = quiz.questionCount ?? 0;
      row.appendChild(questionCountCell);

      const sizeCell = document.createElement('td');
      sizeCell.textContent = formatSize(quiz.sizeBytes || 0);
      row.appendChild(sizeCell);

      const actionCell = document.createElement('td');
      actionCell.className = 'col-actions';
      const deleteButton = document.createElement('button');
      deleteButton.type = 'button';
      deleteButton.className = 'link-button danger';
      deleteButton.textContent = 'Удалить';
      deleteButton.dataset.action = 'delete';
      deleteButton.dataset.code = quiz.code;
      actionCell.appendChild(deleteButton);
      row.appendChild(actionCell);

      tableBody.appendChild(row);
    });

    updateBulkControls();
    updateTotalSize();
  };

  const fetchQuizzes = async () => {
    try {
      const response = await fetch('/api/quizzes');
      if (!response.ok) {
        throw new Error('Не удалось получить данные о квизах');
      }
      const payload = await response.json();
      const items = Array.isArray(payload.quizzes) ? payload.quizzes : [];
      state.quizzes = items.map((item) => ({
        code: item.code,
        createdAt: item.createdAt,
        questionCount: item.questionCount,
        sizeBytes: item.sizeBytes
      }));
      state.selected.forEach((code) => {
        if (!state.quizzes.some((quiz) => quiz.code === code)) {
          state.selected.delete(code);
        }
      });
      renderTable();
      setStatus('Данные обновлены.');
    } catch (error) {
      console.error(error);
      setStatus(error.message || 'Произошла ошибка при загрузке данных.', 'error');
    }
  };

  const applySortButtonState = () => {
    sortButtons.forEach((button) => {
      const indicator = button.querySelector('.sort-indicator');
      const isActive = button.dataset.sort === state.sortField;
      button.classList.toggle('is-active', isActive);
      if (indicator) {
        indicator.textContent = isActive
          ? state.sortDirection === 'asc'
            ? '▲'
            : '▼'
          : '⇅';
      }
    });
  };

  const toggleSort = (field) => {
    if (state.sortField === field) {
      state.sortDirection = state.sortDirection === 'asc' ? 'desc' : 'asc';
    } else {
      state.sortField = field;
      state.sortDirection = field === 'createdAt' ? 'desc' : 'asc';
    }
    applySortButtonState();
    renderTable();
  };

  const deleteSingleQuiz = async (code) => {
    if (!code) {
      return;
    }
    const confirmed = window.confirm(`Удалить квиз ${code}? Действие необратимо.`);
    if (!confirmed) {
      return;
    }
    try {
      const response = await fetch(`/api/quizzes/${encodeURIComponent(code)}`, {
        method: 'DELETE'
      });
      if (!response.ok) {
        throw new Error('Не удалось удалить квиз');
      }
      const payload = await response.json().catch(() => ({}));
      const deletedCode = payload && typeof payload.code === 'string' ? payload.code : code;
      state.selected.delete(code);
      await fetchQuizzes();
      setStatus(`Квиз ${deletedCode} удалён.`, 'success');
    } catch (error) {
      console.error(error);
      setStatus(error.message || 'Ошибка при удалении квиза.', 'error');
    }
  };

  const deleteSelected = async () => {
    if (state.selected.size === 0) {
      return;
    }
    const codes = Array.from(state.selected.values());
    const confirmed = window.confirm(`Удалить ${codes.length} выбранных квизов?`);
    if (!confirmed) {
      return;
    }
    try {
      const response = await fetch('/api/quizzes/bulk-delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ codes })
      });
      if (!response.ok) {
        throw new Error('Не удалось удалить выбранные квизы');
      }
      const payload = await response.json().catch(() => ({}));
      const deleted = Array.isArray(payload.deleted) ? payload.deleted.length : codes.length;
      state.selected.clear();
      await fetchQuizzes();
      setStatus(`Удалено квизов: ${deleted}.`, 'success');
    } catch (error) {
      console.error(error);
      setStatus(error.message || 'Ошибка при пакетном удалении.', 'error');
    }
  };

  if (selectAllCheckbox) {
    selectAllCheckbox.addEventListener('change', () => {
      if (selectAllCheckbox.checked) {
        state.quizzes.forEach((quiz) => state.selected.add(quiz.code));
      } else {
        state.selected.clear();
      }
      updateBulkControls();
      renderTable();
    });
  }

  if (deleteSelectedButton) {
    deleteSelectedButton.addEventListener('click', () => {
      deleteSelected();
    });
  }

  if (tableBody) {
    tableBody.addEventListener('change', (event) => {
      const target = event.target;
      if (!(target instanceof HTMLInputElement) || target.type !== 'checkbox') {
        return;
      }
      const { code } = target.dataset;
      if (!code) {
        return;
      }
      if (target.checked) {
        state.selected.add(code);
      } else {
        state.selected.delete(code);
      }
      updateBulkControls();
    });

    tableBody.addEventListener('click', (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) {
        return;
      }
      if (target.dataset.action === 'delete') {
        const { code } = target.dataset;
        deleteSingleQuiz(code);
      }
    });
  }

  sortButtons.forEach((button) => {
    button.addEventListener('click', () => {
      toggleSort(button.dataset.sort);
    });
  });

  applySortButtonState();
  fetchQuizzes();
})();
