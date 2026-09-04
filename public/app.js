const state = {
  examList: [],
  selectedExam: null,
  sessionQuestions: [],
  currentIndex: 0,
  responses: {},
  revealed: new Set(),
  finished: false,
  imageData: [],
  currentImageIndex: 0,
  editingQuestionId: null,
  selectedDragItemId: null,
  mode: "practice",
  sessionConfig: {},
  examEndsAt: null,
  timerHandle: null
};

const $ = id => document.getElementById(id);
const views = ["examListView", "configureView", "examView", "editView"];

function makeId(prefix = "id") {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function showView(id) {
  views.forEach(v => $(v).classList.toggle("hidden", v !== id));
  $("homeBtn").classList.toggle("hidden", id === "examListView");
}

async function api(url, options = {}) {
  const res = await fetch(url, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Request failed (${res.status})`);
  }
  return res.status === 204 ? null : res.json();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

function getQuestionImages(question) {
  if (Array.isArray(question.images) && question.images.length) return question.images.filter(Boolean);
  return question.image ? [question.image] : [];
}

function questionTypeLabel(type) {
  if (type === "multiple") return "Select all that apply";
  if (type === "dragdrop") return "Drag & Drop / Matching";
  return "Select one";
}

function shuffled(arr) {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

async function loadExamList() {
  state.examList = await api("/api/exams");
  const host = $("examList");
  host.innerHTML = "";
  if (!state.examList.length) {
    host.innerHTML = `<div class="card"><p>No exams found. Create your first exam.</p></div>`;
    return;
  }
  for (const exam of state.examList) {
    const card = document.createElement("article");
    card.className = "exam-card";
    card.innerHTML = `
      <h3>${escapeHtml(exam.title)}</h3>
      <p>${escapeHtml(exam.description || "No description")}</p>
      <div class="count">${exam.questionCount} question${exam.questionCount === 1 ? "" : "s"}</div>`;
    card.addEventListener("click", () => openExam(exam.id));
    host.appendChild(card);
  }
}

async function openExam(id) {
  stopTimer();
  state.selectedExam = await api(`/api/exams/${id}`);
  $("configureTitle").textContent = state.selectedExam.title;
  $("configureDescription").textContent = state.selectedExam.description || "";
  configureForExamSize();
  setMode("practice");
  $("configMessage").textContent = "";
  showView("configureView");
}

function configureForExamSize() {
  const total = state.selectedExam?.questions?.length || 0;
  $("examQuestionCount").max = String(Math.max(1, total));
  $("examQuestionCount").value = String(Math.min(20, Math.max(1, total)));
  $("practiceRangeStart").max = String(Math.max(1, total));
  $("practiceRangeEnd").max = String(Math.max(1, total));
  $("practiceRangeStart").value = "1";
  $("practiceRangeEnd").value = String(Math.min(10, Math.max(1, total)));
  $("startExamBtn").disabled = total === 0;
  updatePracticeRangeSummary();
}

function setMode(mode) {
  state.mode = mode;
  const practice = mode === "practice";
  $("practiceConfig").classList.toggle("hidden", !practice);
  $("examConfig").classList.toggle("hidden", practice);
  $("practiceModeBtn").classList.toggle("active", practice);
  $("examModeBtn").classList.toggle("active", !practice);
  $("startExamBtn").textContent = practice ? "Start Practice" : "Start Exam";
  $("configMessage").textContent = "";
}

function getPracticeRange() {
  const total = state.selectedExam.questions.length;
  const preset = $("practiceRangePreset").value;
  if (preset === "all") return { start: 1, end: total };
  if (preset === "custom") {
    const start = Number($("practiceRangeStart").value);
    const end = Number($("practiceRangeEnd").value);
    return { start, end };
  }
  const [start, end] = preset.split("-").map(Number);
  return { start, end: Math.min(end, total) };
}

function updatePracticeRangeSummary() {
  if (!state.selectedExam) return;
  const total = state.selectedExam.questions.length;
  const preset = $("practiceRangePreset").value;
  $("customRangeFields").classList.toggle("hidden", preset !== "custom");
  const { start, end } = getPracticeRange();
  if (!total) {
    $("practiceRangeSummary").textContent = "This exam has no questions yet.";
    return;
  }
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || start > total) {
    $("practiceRangeSummary").textContent = "Enter a valid range within the question bank.";
    return;
  }
  const safeEnd = Math.min(end, total);
  const count = safeEnd - start + 1;
  $("practiceRangeSummary").textContent = `Questions ${start}–${safeEnd} of ${total} (${count} question${count === 1 ? "" : "s"}).`;
}

function normalizeQuestionForSession(q, shuffleAnswers) {
  if (q.type === "dragdrop") {
    return {
      ...q,
      dragItems: shuffled((q.dragItems || []).map(item => ({ ...item }))),
      dropTargets: (q.dropTargets || []).map(target => ({ ...target }))
    };
  }
  let options = (q.options || []).map((text, originalIndex) => ({
    text,
    isCorrect: (q.correct || []).includes(originalIndex)
  }));
  if (shuffleAnswers) options = shuffled(options);
  return { ...q, options };
}

function startConfiguredSession() {
  const total = state.selectedExam.questions.length;
  if (!total) return;
  $("configMessage").textContent = "";

  let sourceQuestions;
  let shuffleQuestions;
  let shuffleAnswers;

  if (state.mode === "practice") {
    const { start, end } = getPracticeRange();
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || start > total) {
      $("configMessage").textContent = "Please enter a valid practice question range.";
      return;
    }
    const safeEnd = Math.min(end, total);
    sourceQuestions = state.selectedExam.questions.slice(start - 1, safeEnd);
    shuffleQuestions = $("practiceShuffleQuestions").value === "yes";
    shuffleAnswers = $("practiceShuffleAnswers").value === "yes";
    state.sessionConfig = { mode: "practice", rangeStart: start, rangeEnd: safeEnd, shuffleQuestions, shuffleAnswers };
  } else {
    const questionCount = Number($("examQuestionCount").value);
    const durationMinutes = Number($("examDuration").value);
    const passingPercentage = Number($("examPassingPercentage").value);
    const allowBackNavigation = $("examAllowBack").value === "yes";
    const unansweredWarning = $("examUnansweredWarning").value === "yes";

    if (!Number.isInteger(questionCount) || questionCount < 1 || questionCount > total) {
      $("configMessage").textContent = `Number of questions must be between 1 and ${total}.`;
      return;
    }
    if (!Number.isFinite(durationMinutes) || durationMinutes < 1) {
      $("configMessage").textContent = "Exam duration must be at least 1 minute.";
      return;
    }
    if (!Number.isFinite(passingPercentage) || passingPercentage < 1 || passingPercentage > 100) {
      $("configMessage").textContent = "Passing percentage must be between 1 and 100.";
      return;
    }

    sourceQuestions = shuffled(state.selectedExam.questions).slice(0, questionCount);
    shuffleQuestions = false;
    shuffleAnswers = true;
    state.sessionConfig = {
      mode: "exam",
      questionCount,
      durationMinutes,
      allowBackNavigation,
      passingPercentage,
      unansweredWarning
    };
  }

  if (shuffleQuestions) sourceQuestions = shuffled(sourceQuestions);
  state.sessionQuestions = sourceQuestions.map(q => normalizeQuestionForSession(q, shuffleAnswers));
  state.currentIndex = 0;
  state.currentImageIndex = 0;
  state.responses = {};
  state.revealed = new Set();
  state.finished = false;
  state.selectedDragItemId = null;

  $("resultBox").classList.add("hidden");
  $("resultBox").innerHTML = "";
  $("sessionModeBadge").textContent = state.mode === "practice" ? "Practice" : "Exam";
  $("showAnswerBtn").classList.toggle("hidden", state.mode === "exam");
  $("timerBox").classList.toggle("hidden", state.mode !== "exam");
  $("noBackWarning").classList.toggle("hidden", !(state.mode === "exam" && !state.sessionConfig.allowBackNavigation));
  $("finishBtn").textContent = state.mode === "exam" ? "Submit Exam" : "Finish Practice";

  if (state.mode === "exam") startTimer(state.sessionConfig.durationMinutes);
  else stopTimer();

  renderQuestion();
  showView("examView");
}

function startTimer(minutes) {
  stopTimer();
  state.examEndsAt = Date.now() + minutes * 60 * 1000;
  updateTimer();
  state.timerHandle = setInterval(updateTimer, 250);
}

function stopTimer() {
  if (state.timerHandle) clearInterval(state.timerHandle);
  state.timerHandle = null;
  state.examEndsAt = null;
}

function updateTimer() {
  if (state.mode !== "exam" || state.finished || !state.examEndsAt) return;
  const remaining = Math.max(0, state.examEndsAt - Date.now());
  const totalSeconds = Math.ceil(remaining / 1000);
  const mins = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  $("timerText").textContent = `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  $("timerBox").classList.toggle("timer-warning", totalSeconds <= 300);
  if (remaining <= 0) submitSession(true);
}

function renderImageGallery(question) {
  const images = getQuestionImages(question);
  const gallery = $("questionImageGallery");
  if (!images.length) {
    gallery.classList.add("hidden");
    $("questionImage").removeAttribute("src");
    return;
  }
  state.currentImageIndex = Math.max(0, Math.min(state.currentImageIndex, images.length - 1));
  const image = $("questionImage");
  image.src = images[state.currentImageIndex];
  image.alt = `Question image ${state.currentImageIndex + 1} of ${images.length}`;
  gallery.classList.remove("hidden");
  const multiple = images.length > 1;
  $("prevImageBtn").classList.toggle("hidden", !multiple);
  $("nextImageBtn").classList.toggle("hidden", !multiple);
  $("imageCounter").textContent = multiple ? `Image ${state.currentImageIndex + 1} of ${images.length}` : "1 image";
}

function changeQuestionImage(direction) {
  const q = state.sessionQuestions[state.currentIndex];
  const images = getQuestionImages(q);
  if (images.length < 2) return;
  state.currentImageIndex = (state.currentImageIndex + direction + images.length) % images.length;
  renderImageGallery(q);
  if ($("imageZoomDialog").open) renderZoomImage();
}

function renderZoomImage() {
  const q = state.sessionQuestions[state.currentIndex];
  const images = getQuestionImages(q);
  if (!images.length) return;
  $("zoomedImage").src = images[state.currentImageIndex];
  $("zoomImageCounter").textContent = `Image ${state.currentImageIndex + 1} of ${images.length}`;
  $("zoomPrevBtn").disabled = images.length < 2;
  $("zoomNextBtn").disabled = images.length < 2;
}

function openImageZoom() {
  const q = state.sessionQuestions[state.currentIndex];
  if (!getQuestionImages(q).length) return;
  renderZoomImage();
  if (!$("imageZoomDialog").open) $("imageZoomDialog").showModal();
}

function getDragResponse(index = state.currentIndex) {
  if (!state.responses[index] || Array.isArray(state.responses[index])) state.responses[index] = {};
  return state.responses[index];
}

function assignDragItem(targetId, itemId) {
  if (state.finished) return;
  const response = getDragResponse();
  for (const [target, item] of Object.entries(response)) if (item === itemId) delete response[target];
  response[targetId] = itemId;
  state.selectedDragItemId = null;
  renderDragDropQuestion(state.sessionQuestions[state.currentIndex]);
}

function unassignDragItem(itemId) {
  if (state.finished) return;
  const response = getDragResponse();
  for (const [target, item] of Object.entries(response)) if (item === itemId) delete response[target];
  state.selectedDragItemId = null;
  renderDragDropQuestion(state.sessionQuestions[state.currentIndex]);
}

function createDragCard(item, placed = false) {
  const card = document.createElement("div");
  card.className = "drag-item";
  card.textContent = item.text;
  card.draggable = !state.finished;
  card.dataset.itemId = item.id;
  card.tabIndex = state.finished ? -1 : 0;
  card.setAttribute("role", "button");
  if (state.selectedDragItemId === item.id) card.classList.add("selected");
  card.addEventListener("dragstart", e => {
    if (state.finished) return;
    e.dataTransfer.setData("text/plain", item.id);
    e.dataTransfer.effectAllowed = "move";
    card.classList.add("dragging");
  });
  card.addEventListener("dragend", () => card.classList.remove("dragging"));
  const toggle = () => {
    if (state.finished) return;
    state.selectedDragItemId = state.selectedDragItemId === item.id ? null : item.id;
    renderDragDropQuestion(state.sessionQuestions[state.currentIndex]);
  };
  card.addEventListener("click", e => { e.stopPropagation(); toggle(); });
  card.addEventListener("keydown", e => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); }
  });
  card.title = placed ? "Move this answer to another slot" : "Drag this choice to a slot";
  return card;
}

function renderDragDropQuestion(q) {
  const host = $("dragDropArea");
  host.innerHTML = "";
  host.classList.remove("hidden");
  $("options").classList.add("hidden");

  const response = getDragResponse();
  const shouldShow = state.finished || (state.mode === "practice" && state.revealed.has(state.currentIndex));
  const itemsById = new Map((q.dragItems || []).map(item => [item.id, item]));
  const assignedIds = new Set(Object.values(response));
  const unassigned = (q.dragItems || []).filter(item => !assignedIds.has(item.id));

  const grid = document.createElement("div");
  grid.className = "dragdrop-grid";
  const poolColumn = document.createElement("div");
  poolColumn.innerHTML = `<div class="dragdrop-column-title">Choices</div>`;
  const pool = document.createElement("div");
  pool.className = "drag-pool";
  pool.addEventListener("dragover", e => { if (!state.finished) e.preventDefault(); });
  pool.addEventListener("drop", e => {
    if (state.finished) return;
    e.preventDefault();
    const id = e.dataTransfer.getData("text/plain");
    if (id) unassignDragItem(id);
  });
  pool.addEventListener("click", () => { if (state.selectedDragItemId) unassignDragItem(state.selectedDragItemId); });
  unassigned.forEach(item => pool.appendChild(createDragCard(item)));
  if (!unassigned.length) pool.innerHTML = `<span class="muted small">All available items are currently placed.</span>`;
  poolColumn.appendChild(pool);

  const labelsColumn = document.createElement("div");
  labelsColumn.innerHTML = `<div class="dragdrop-column-title">Target</div>`;
  const slotsColumn = document.createElement("div");
  slotsColumn.innerHTML = `<div class="dragdrop-column-title">Your answer</div>`;

  (q.dropTargets || []).forEach(target => {
    const label = document.createElement("div");
    label.className = "drag-label";
    label.textContent = target.label;
    labelsColumn.appendChild(label);

    const wrap = document.createElement("div");
    const slot = document.createElement("div");
    slot.className = "drop-slot";
    const placedId = response[target.id];
    const placedItem = placedId ? itemsById.get(placedId) : null;
    if (placedItem) {
      slot.classList.add("filled");
      slot.appendChild(createDragCard(placedItem, true));
    } else slot.textContent = state.finished ? "No answer" : "Drop here";

    slot.addEventListener("dragover", e => {
      if (state.finished) return;
      e.preventDefault();
      slot.classList.add("drag-over");
    });
    slot.addEventListener("dragleave", () => slot.classList.remove("drag-over"));
    slot.addEventListener("drop", e => {
      if (state.finished) return;
      e.preventDefault();
      slot.classList.remove("drag-over");
      const id = e.dataTransfer.getData("text/plain");
      if (id) assignDragItem(target.id, id);
    });
    slot.addEventListener("click", e => {
      if (state.finished || e.target.closest(".drag-item")) return;
      if (state.selectedDragItemId) assignDragItem(target.id, state.selectedDragItemId);
    });

    if (shouldShow) {
      if (placedId === target.correctItemId) slot.classList.add("correct-drop");
      else {
        if (placedId) slot.classList.add("wrong-drop");
        const correct = itemsById.get(target.correctItemId);
        if (correct) {
          const note = document.createElement("div");
          note.className = "drop-correct-note";
          note.textContent = `Correct: ${correct.text}`;
          wrap.appendChild(note);
        }
      }
    }
    wrap.prepend(slot);
    slotsColumn.appendChild(wrap);
  });

  grid.append(poolColumn, labelsColumn, slotsColumn);
  host.appendChild(grid);
  const help = document.createElement("div");
  help.className = "dragdrop-help";
  help.textContent = state.finished
    ? "Answers are locked for review."
    : "Drag choices into the matching slots. On touch devices, tap a choice and then tap a slot.";
  host.appendChild(help);
}

function renderChoiceQuestion(q) {
  const host = $("options");
  host.classList.remove("hidden");
  $("dragDropArea").classList.add("hidden");
  host.innerHTML = "";
  const saved = state.responses[state.currentIndex] || [];
  q.options.forEach((opt, i) => {
    const label = document.createElement("label");
    label.className = "option";
    const input = document.createElement("input");
    input.type = q.type === "multiple" ? "checkbox" : "radio";
    input.name = `question-${state.currentIndex}`;
    input.value = i;
    input.checked = saved.includes(i);
    input.disabled = state.finished;
    input.addEventListener("change", () => {
      if (q.type === "single") state.responses[state.currentIndex] = [i];
      else state.responses[state.currentIndex] = [...host.querySelectorAll("input:checked")].map(x => Number(x.value));
    });
    const span = document.createElement("span");
    span.textContent = `${String.fromCharCode(65 + i)}. ${opt.text}`;
    label.append(input, span);
    host.appendChild(label);
  });
}

function renderAnswerReview(q, shouldShow) {
  $("answerBox").classList.toggle("hidden", !shouldShow);
  if (!shouldShow) return;
  $("answerText").innerHTML = "";
  $("explanationText").textContent = q.explanation || "";

  if (q.type === "dragdrop") {
    const items = new Map((q.dragItems || []).map(item => [item.id, item]));
    const title = document.createElement("div");
    title.textContent = "Correct mapping:";
    title.style.marginBottom = "8px";
    $("answerText").appendChild(title);
    (q.dropTargets || []).forEach(target => {
      const row = document.createElement("div");
      row.textContent = `${target.label} → ${items.get(target.correctItemId)?.text || "Unknown item"}`;
      $("answerText").appendChild(row);
    });
    return;
  }

  const selected = state.responses[state.currentIndex] || [];
  [...$("options").querySelectorAll(".option")].forEach((label, i) => {
    if (q.options[i].isCorrect) label.classList.add("correct-answer");
    else if (selected.includes(i)) label.classList.add("wrong-answer");
  });
  const correct = q.options.map((o, i) => ({ ...o, letter: String.fromCharCode(65 + i) })).filter(o => o.isCorrect);
  const summary = document.createElement("div");
  summary.textContent = `Correct Answer${correct.length > 1 ? "s" : ""}: ${correct.map(x => x.letter).join(", ")}`;
  summary.style.marginBottom = "8px";
  $("answerText").appendChild(summary);
  correct.forEach(answer => {
    const row = document.createElement("div");
    row.textContent = `${answer.letter}. ${answer.text}`;
    $("answerText").appendChild(row);
  });
}

function renderQuestion() {
  const q = state.sessionQuestions[state.currentIndex];
  if (!q) return;
  state.selectedDragItemId = null;
  $("progressText").textContent = `Question ${state.currentIndex + 1} of ${state.sessionQuestions.length}`;
  $("questionType").textContent = questionTypeLabel(q.type);
  $("questionText").textContent = q.text;
  renderImageGallery(q);

  const manuallyRevealed = state.mode === "practice" && state.revealed.has(state.currentIndex);
  const shouldShow = state.finished || manuallyRevealed;
  if (q.type === "dragdrop") renderDragDropQuestion(q);
  else renderChoiceQuestion(q);

  $("showAnswerBtn").classList.toggle("hidden", state.mode === "exam");
  if (state.mode === "practice") {
    $("showAnswerBtn").disabled = state.finished;
    $("showAnswerBtn").textContent = state.finished ? "Answers Shown" : (manuallyRevealed ? "Hide Answers" : "Show Answers");
  }
  renderAnswerReview(q, shouldShow);

  const noBack = state.mode === "exam" && !state.sessionConfig.allowBackNavigation;
  $("prevBtn").classList.toggle("hidden", noBack);
  $("prevBtn").disabled = state.currentIndex === 0;
  $("nextBtn").disabled = state.currentIndex === state.sessionQuestions.length - 1;
  $("nextBtn").textContent = noBack ? "Next Question" : "Next";
}

function isQuestionAnswered(q, index) {
  const response = state.responses[index];
  if (q.type === "dragdrop") {
    if (!response || Array.isArray(response)) return false;
    return (q.dropTargets || []).every(target => Boolean(response[target.id]));
  }
  return Array.isArray(response) && response.length > 0;
}

function isQuestionCorrect(q, index) {
  if (q.type === "dragdrop") {
    const response = state.responses[index] || {};
    return (q.dropTargets || []).every(target => response[target.id] === target.correctItemId);
  }
  const selected = state.responses[index] || [];
  return q.options.every((o, idx) => selected.includes(idx) === Boolean(o.isCorrect));
}

function getResultStats() {
  let correct = 0;
  let answered = 0;
  state.sessionQuestions.forEach((q, i) => {
    if (isQuestionAnswered(q, i)) answered++;
    if (isQuestionCorrect(q, i)) correct++;
  });
  const total = state.sessionQuestions.length;
  return { total, correct, answered, incorrect: answered - correct, unanswered: total - answered, percent: Math.round((correct / total) * 100) };
}

function requestFinish() {
  if (state.finished) return;
  if (state.mode === "practice") {
    submitSession(false);
    return;
  }
  const stats = getResultStats();
  if (!state.sessionConfig.unansweredWarning) {
    submitSession(false);
    return;
  }
  $("submitExamMessage").textContent = stats.unanswered
    ? `You still have ${stats.unanswered} unanswered question${stats.unanswered === 1 ? "" : "s"}. Submit the exam now?`
    : "All questions have been answered. Submit the exam now?";
  $("submitExamDialog").showModal();
}

function submitSession(timedOut = false) {
  if (state.finished) return;
  const oldEnd = state.examEndsAt;
  if (state.timerHandle) clearInterval(state.timerHandle);
  state.timerHandle = null;
  state.finished = true;
  state.examEndsAt = oldEnd;
  if ($("submitExamDialog").open) $("submitExamDialog").close();

  const stats = getResultStats();
  if (state.mode === "exam") {
    const passing = state.sessionConfig.passingPercentage;
    const passed = stats.percent >= passing;
    $("resultBox").innerHTML = `
      <div class="result-heading-row">
        <div><h2>Exam Result</h2><span class="result-status ${passed ? "pass" : "fail"}">${passed ? "PASS" : "FAIL"}</span></div>
        ${timedOut ? '<span class="timed-out-note">Time expired — exam submitted automatically.</span>' : ''}
      </div>
      <div class="result-grid">
        <div><span>Score</span><strong>${stats.correct}/${stats.total}</strong></div>
        <div><span>Percentage</span><strong>${stats.percent}%</strong></div>
        <div><span>Passing Score</span><strong>${passing}%</strong></div>
        <div><span>Correct</span><strong>${stats.correct}</strong></div>
        <div><span>Incorrect</span><strong>${stats.incorrect}</strong></div>
        <div><span>Unanswered</span><strong>${stats.unanswered}</strong></div>
      </div>
      <p class="muted">Answers are now available while you review the submitted exam.</p>`;
    $("timerText").textContent = timedOut ? "00:00" : $("timerText").textContent;
  } else {
    $("resultBox").innerHTML = `
      <h2>Practice Result</h2>
      <div class="result-grid">
        <div><span>Score</span><strong>${stats.correct}/${stats.total}</strong></div>
        <div><span>Percentage</span><strong>${stats.percent}%</strong></div>
        <div><span>Correct</span><strong>${stats.correct}</strong></div>
        <div><span>Incorrect</span><strong>${stats.incorrect}</strong></div>
        <div><span>Unanswered</span><strong>${stats.unanswered}</strong></div>
      </div>
      <p class="muted">Answers are now visible while you review the questions.</p>`;
  }
  $("resultBox").classList.remove("hidden");
  renderQuestion();
  $("resultBox").scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function addOptionEditor(text = "", correct = false) {
  const row = document.createElement("div");
  row.className = "option-editor";
  const check = document.createElement("input");
  check.type = "checkbox";
  check.className = "correct-check";
  check.checked = correct;
  const input = document.createElement("input");
  input.className = "option-text";
  input.value = text;
  input.placeholder = "Answer option";
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "secondary";
  remove.textContent = "×";
  remove.addEventListener("click", () => { if ($("optionEditors").children.length > 2) row.remove(); });
  row.append(check, input, remove);
  $("optionEditors").appendChild(row);
}

function addDragItemEditor(text = "", id = makeId("item")) {
  const row = document.createElement("div");
  row.className = "drag-item-editor";
  row.dataset.itemId = id;
  const input = document.createElement("input");
  input.className = "drag-item-text";
  input.value = text;
  input.placeholder = "Draggable choice";
  input.addEventListener("input", syncDropTargetSelects);
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "secondary";
  remove.textContent = "×";
  remove.addEventListener("click", () => {
    if ($("dragItemEditors").children.length > 2) { row.remove(); syncDropTargetSelects(); }
  });
  row.append(input, remove);
  $("dragItemEditors").appendChild(row);
  syncDropTargetSelects();
}

function currentDragEditorItems() {
  return [...$("dragItemEditors").children].map(row => ({
    id: row.dataset.itemId,
    text: row.querySelector(".drag-item-text").value.trim()
  })).filter(item => item.text);
}

function addDropTargetEditor(label = "", correctItemId = "", id = makeId("target")) {
  const row = document.createElement("div");
  row.className = "drop-target-editor";
  row.dataset.targetId = id;
  const labelInput = document.createElement("input");
  labelInput.className = "drop-target-label";
  labelInput.value = label;
  labelInput.placeholder = "Target label, e.g. 1";
  const select = document.createElement("select");
  select.className = "drop-target-correct";
  select.dataset.selectedValue = correctItemId;
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "secondary";
  remove.textContent = "×";
  remove.addEventListener("click", () => { if ($("dropTargetEditors").children.length > 1) row.remove(); });
  row.append(labelInput, select, remove);
  $("dropTargetEditors").appendChild(row);
  syncDropTargetSelects();
}

function syncDropTargetSelects() {
  const items = currentDragEditorItems();
  [...$("dropTargetEditors").querySelectorAll(".drop-target-correct")].forEach(select => {
    const previous = select.value || select.dataset.selectedValue || "";
    select.innerHTML = `<option value="">Select correct item</option>`;
    items.forEach(item => {
      const option = document.createElement("option");
      option.value = item.id;
      option.textContent = item.text;
      select.appendChild(option);
    });
    if (items.some(item => item.id === previous)) select.value = previous;
    select.dataset.selectedValue = select.value;
    select.onchange = () => { select.dataset.selectedValue = select.value; };
  });
}

function toggleQuestionEditorType() {
  const drag = $("answerType").value === "dragdrop";
  $("choiceEditorSection").classList.toggle("hidden", drag);
  $("dragDropEditorSection").classList.toggle("hidden", !drag);
}

function renderImagePreviews() {
  const host = $("imagePreviewList");
  host.innerHTML = "";
  state.imageData.forEach((src, index) => {
    const item = document.createElement("div");
    item.className = "image-preview-item";
    const img = document.createElement("img");
    img.src = src;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "remove-image";
    remove.textContent = "×";
    remove.addEventListener("click", () => { state.imageData.splice(index, 1); renderImagePreviews(); });
    item.append(img, remove);
    host.appendChild(item);
  });
}

function ensureCancelEditButton() {
  let button = $("cancelQuestionEditBtn");
  if (button) return button;
  button = document.createElement("button");
  button.id = "cancelQuestionEditBtn";
  button.type = "button";
  button.className = "secondary hidden";
  button.textContent = "Cancel Edit";
  button.style.marginLeft = "8px";
  button.addEventListener("click", resetQuestionForm);
  $("questionForm").querySelector('button[type="submit"]').insertAdjacentElement("afterend", button);
  return button;
}

function setQuestionFormMode(editing) {
  $("questionForm").querySelector("h3").textContent = editing ? "Edit Question" : "Add Question";
  $("questionForm").querySelector('button[type="submit"]').textContent = editing ? "Update Question" : "Save Question";
  ensureCancelEditButton().classList.toggle("hidden", !editing);
}

function resetQuestionForm() {
  $("questionForm").reset();
  $("optionEditors").innerHTML = "";
  $("dragItemEditors").innerHTML = "";
  $("dropTargetEditors").innerHTML = "";
  for (let i = 0; i < 4; i++) addOptionEditor();
  for (let i = 0; i < 4; i++) addDragItemEditor();
  for (let i = 0; i < 4; i++) addDropTargetEditor(String(i + 1));
  state.imageData = [];
  state.editingQuestionId = null;
  renderImagePreviews();
  $("formMessage").textContent = "";
  $("answerType").value = "single";
  toggleQuestionEditorType();
  setQuestionFormMode(false);
}

function beginEditQuestion(question) {
  resetQuestionForm();
  $("optionEditors").innerHTML = "";
  $("dragItemEditors").innerHTML = "";
  $("dropTargetEditors").innerHTML = "";
  state.editingQuestionId = question.id;
  state.imageData = [...getQuestionImages(question)];
  $("newQuestion").value = question.text || "";
  $("answerType").value = question.type || "single";
  $("explanation").value = question.explanation || "";

  if (question.type === "dragdrop") {
    (question.dragItems || []).forEach(item => addDragItemEditor(item.text, item.id));
    while ($("dragItemEditors").children.length < 2) addDragItemEditor();
    (question.dropTargets || []).forEach(target => addDropTargetEditor(target.label, target.correctItemId, target.id));
    if (!$("dropTargetEditors").children.length) addDropTargetEditor("1");
    syncDropTargetSelects();
  } else {
    (question.options || []).forEach((option, i) => addOptionEditor(option, (question.correct || []).includes(i)));
    while ($("optionEditors").children.length < 2) addOptionEditor();
    for (let i = 0; i < 4; i++) addDragItemEditor();
    for (let i = 0; i < 4; i++) addDropTargetEditor(String(i + 1));
  }
  renderImagePreviews();
  toggleQuestionEditorType();
  setQuestionFormMode(true);
  $("formMessage").textContent = "Editing saved question. Existing images can be removed or new images added.";
  $("questionForm").scrollIntoView({ behavior: "smooth", block: "start" });
}

function renderQuestionBank() {
  $("editTitle").textContent = `Edit: ${state.selectedExam.title}`;
  const host = $("questionBank");
  host.innerHTML = "";
  if (!state.selectedExam.questions.length) {
    host.innerHTML = `<p class="muted">No questions yet.</p>`;
    return;
  }
  state.selectedExam.questions.forEach((q, idx) => {
    const item = document.createElement("div");
    item.className = "question-bank-item";
    const imageCount = getQuestionImages(q).length;
    const typeText = q.type === "dragdrop"
      ? `Drag & Drop · ${(q.dragItems || []).length} items · ${(q.dropTargets || []).length} targets`
      : `${q.type === "multiple" ? "Multiple answers" : "Single answer"} · ${(q.options || []).length} options`;
    item.innerHTML = `
      <div class="q-head"><div><strong>${idx + 1}. ${escapeHtml(q.text)}</strong>
      <div class="muted small">${typeText}${imageCount ? ` · ${imageCount} image${imageCount === 1 ? "" : "s"}` : ""}</div></div>
      <div class="question-actions"><button type="button" class="secondary edit-question-btn">Edit</button><button type="button" class="secondary delete-question-btn">Delete</button></div></div>`;
    item.querySelector(".edit-question-btn").addEventListener("click", () => beginEditQuestion(q));
    item.querySelector(".delete-question-btn").addEventListener("click", async () => {
      await api(`/api/exams/${state.selectedExam.id}/questions/${q.id}`, { method: "DELETE" });
      if (state.editingQuestionId === q.id) resetQuestionForm();
      state.selectedExam = await api(`/api/exams/${state.selectedExam.id}`);
      renderQuestionBank();
      configureForExamSize();
    });
    host.appendChild(item);
  });
}

$("homeBtn").addEventListener("click", async () => {
  stopTimer();
  await loadExamList();
  showView("examListView");
});
$("newExamBtn").addEventListener("click", () => $("newExamDialog").showModal());
$("cancelDialogBtn").addEventListener("click", () => $("newExamDialog").close());
$("newExamForm").addEventListener("submit", async e => {
  e.preventDefault();
  const exam = await api("/api/exams", { method: "POST", body: JSON.stringify({ title: $("examTitle").value, description: $("examDescription").value }) });
  $("newExamDialog").close();
  e.target.reset();
  await loadExamList();
  await openExam(exam.id);
});

$("practiceModeBtn").addEventListener("click", () => setMode("practice"));
$("examModeBtn").addEventListener("click", () => setMode("exam"));
$("practiceRangePreset").addEventListener("change", updatePracticeRangeSummary);
$("practiceRangeStart").addEventListener("input", updatePracticeRangeSummary);
$("practiceRangeEnd").addEventListener("input", updatePracticeRangeSummary);
$("startExamBtn").addEventListener("click", startConfiguredSession);

$("editExamBtn").addEventListener("click", () => {
  resetQuestionForm();
  renderQuestionBank();
  showView("editView");
});
$("prevBtn").addEventListener("click", () => {
  if (state.currentIndex <= 0) return;
  if (state.mode === "exam" && !state.sessionConfig.allowBackNavigation) return;
  state.currentIndex--;
  state.currentImageIndex = 0;
  renderQuestion();
});
$("nextBtn").addEventListener("click", () => {
  if (state.currentIndex >= state.sessionQuestions.length - 1) return;
  state.currentIndex++;
  state.currentImageIndex = 0;
  renderQuestion();
});
$("showAnswerBtn").addEventListener("click", () => {
  if (state.mode !== "practice" || state.finished) return;
  if (state.revealed.has(state.currentIndex)) state.revealed.delete(state.currentIndex);
  else state.revealed.add(state.currentIndex);
  renderQuestion();
});
$("finishBtn").addEventListener("click", requestFinish);
$("cancelSubmitBtn").addEventListener("click", () => $("submitExamDialog").close());
$("confirmSubmitBtn").addEventListener("click", () => submitSession(false));

$("addOptionBtn").addEventListener("click", () => addOptionEditor());
$("addDragItemBtn").addEventListener("click", () => addDragItemEditor());
$("addDropTargetBtn").addEventListener("click", () => addDropTargetEditor(String($("dropTargetEditors").children.length + 1)));
$("answerType").addEventListener("change", toggleQuestionEditorType);

$("prevImageBtn").addEventListener("click", () => changeQuestionImage(-1));
$("nextImageBtn").addEventListener("click", () => changeQuestionImage(1));
$("zoomImageBtn").addEventListener("click", openImageZoom);
$("zoomImageTextBtn").addEventListener("click", openImageZoom);
$("zoomPrevBtn").addEventListener("click", () => changeQuestionImage(-1));
$("zoomNextBtn").addEventListener("click", () => changeQuestionImage(1));
$("closeZoomBtn").addEventListener("click", () => $("imageZoomDialog").close());
$("imageZoomDialog").addEventListener("click", e => { if (e.target === $("imageZoomDialog")) $("imageZoomDialog").close(); });

$("imageFile").addEventListener("change", async e => {
  const files = [...(e.target.files || [])];
  if (!files.length) return;
  try {
    const loaded = await Promise.all(files.map(file => new Promise((resolve, reject) => {
      if (!file.type.startsWith("image/")) return reject(new Error(`${file.name} is not an image.`));
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
      reader.readAsDataURL(file);
    })));
    state.imageData.push(...loaded);
    renderImagePreviews();
    $("formMessage").textContent = `${state.imageData.length} image${state.imageData.length === 1 ? "" : "s"} selected.`;
  } catch (err) {
    $("formMessage").textContent = err.message;
  } finally {
    e.target.value = "";
  }
});

$("questionForm").addEventListener("submit", async e => {
  e.preventDefault();
  const type = $("answerType").value;
  const payload = { text: $("newQuestion").value, type, explanation: $("explanation").value, images: state.imageData };
  if (type === "dragdrop") {
    payload.dragItems = currentDragEditorItems();
    payload.dropTargets = [...$("dropTargetEditors").children].map(row => ({
      id: row.dataset.targetId,
      label: row.querySelector(".drop-target-label").value.trim(),
      correctItemId: row.querySelector(".drop-target-correct").value
    })).filter(target => target.label || target.correctItemId);
  } else {
    const options = [];
    const correct = [];
    [...$("optionEditors").children].forEach(row => {
      const text = row.querySelector(".option-text").value.trim();
      if (!text) return;
      if (row.querySelector(".correct-check").checked) correct.push(options.length);
      options.push(text);
    });
    payload.options = options;
    payload.correct = correct;
  }
  const editingId = state.editingQuestionId;
  const endpoint = editingId ? `/api/exams/${state.selectedExam.id}/questions/${editingId}` : `/api/exams/${state.selectedExam.id}/questions`;
  try {
    await api(endpoint, { method: editingId ? "PUT" : "POST", body: JSON.stringify(payload) });
    state.selectedExam = await api(`/api/exams/${state.selectedExam.id}`);
    resetQuestionForm();
    $("formMessage").textContent = editingId ? "Question updated." : "Question saved.";
    renderQuestionBank();
    configureForExamSize();
  } catch (err) {
    $("formMessage").textContent = err.message;
  }
});

ensureCancelEditButton();
resetQuestionForm();
loadExamList().catch(err => {
  $("examList").innerHTML = `<div class="card"><p>${escapeHtml(err.message)}</p></div>`;
});
