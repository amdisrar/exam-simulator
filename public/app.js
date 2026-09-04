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
  selectedDragItemId: null
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
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {})
    },
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
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[c]));
}

function getQuestionImages(question) {
  if (Array.isArray(question.images) && question.images.length) {
    return question.images.filter(Boolean);
  }
  return question.image ? [question.image] : [];
}

function questionTypeLabel(type) {
  if (type === "multiple") return "Select all that apply";
  if (type === "dragdrop") return "Drag & Drop / Matching";
  return "Select one";
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
      <div class="count">${exam.questionCount} question${exam.questionCount === 1 ? "" : "s"}</div>
    `;
    card.addEventListener("click", () => openExam(exam.id));
    host.appendChild(card);
  }
}

async function openExam(id) {
  state.selectedExam = await api(`/api/exams/${id}`);
  $("configureTitle").textContent = state.selectedExam.title;
  $("configureDescription").textContent = state.selectedExam.description || "";
  fillQuestionCount();
  showView("configureView");
}

function fillQuestionCount() {
  const select = $("questionCount");
  const total = state.selectedExam.questions.length;
  select.innerHTML = "";

  for (let i = 1; i <= total; i++) {
    const opt = document.createElement("option");
    opt.value = i;
    opt.textContent = i === total ? `${i} (all)` : String(i);
    select.appendChild(opt);
  }

  if (total) select.value = String(total);
  $("startExamBtn").disabled = total === 0;
}

function shuffled(arr) {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function prepareSession() {
  const total = state.selectedExam.questions.length;
  const count = Math.max(1, Math.min(Number($("questionCount").value) || total, total));
  const shuffleQ = $("shuffleQuestions").value === "yes";
  const shuffleA = $("shuffleAnswers").value === "yes";

  let questions = state.selectedExam.questions.map(q => {
    if (q.type === "dragdrop") {
      return {
        ...q,
        dragItems: shuffled((q.dragItems || []).map(item => ({ ...item }))),
        dropTargets: (q.dropTargets || []).map(target => ({ ...target }))
      };
    }

    return {
      ...q,
      options: (q.options || []).map((text, originalIndex) => ({
        text,
        isCorrect: (q.correct || []).includes(originalIndex)
      }))
    };
  });

  if (shuffleQ) questions = shuffled(questions);
  questions = questions.slice(0, count);

  if (shuffleA) {
    questions = questions.map(q => q.type === "dragdrop" ? q : {
      ...q,
      options: shuffled(q.options)
    });
  }

  state.sessionQuestions = questions;
  state.currentIndex = 0;
  state.currentImageIndex = 0;
  state.responses = {};
  state.revealed = new Set();
  state.finished = false;
  state.selectedDragItemId = null;

  $("resultBox").classList.add("hidden");
  renderQuestion();
  showView("examView");
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

  const hasMultiple = images.length > 1;
  $("prevImageBtn").classList.toggle("hidden", !hasMultiple);
  $("nextImageBtn").classList.toggle("hidden", !hasMultiple);
  $("prevImageBtn").disabled = !hasMultiple;
  $("nextImageBtn").disabled = !hasMultiple;
  $("imageCounter").textContent = hasMultiple
    ? `Image ${state.currentImageIndex + 1} of ${images.length}`
    : "1 image";
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

  const image = $("zoomedImage");
  image.src = images[state.currentImageIndex];
  image.alt = `Question image ${state.currentImageIndex + 1} of ${images.length} at original size`;
  $("zoomImageCounter").textContent = `Image ${state.currentImageIndex + 1} of ${images.length}`;

  const hasMultiple = images.length > 1;
  $("zoomPrevBtn").disabled = !hasMultiple;
  $("zoomNextBtn").disabled = !hasMultiple;
}

function openImageZoom() {
  const q = state.sessionQuestions[state.currentIndex];
  if (!getQuestionImages(q).length) return;
  renderZoomImage();
  const dialog = $("imageZoomDialog");
  if (!dialog.open) dialog.showModal();
}

function getDragResponse(index = state.currentIndex) {
  if (!state.responses[index] || Array.isArray(state.responses[index])) {
    state.responses[index] = {};
  }
  return state.responses[index];
}

function assignDragItem(targetId, itemId) {
  if (state.finished) return;
  const response = getDragResponse();

  for (const [existingTarget, existingItem] of Object.entries(response)) {
    if (existingItem === itemId) delete response[existingTarget];
  }

  response[targetId] = itemId;
  state.selectedDragItemId = null;
  renderDragDropQuestion(state.sessionQuestions[state.currentIndex]);
}

function unassignDragItem(itemId) {
  if (state.finished) return;
  const response = getDragResponse();
  for (const [targetId, existingItem] of Object.entries(response)) {
    if (existingItem === itemId) delete response[targetId];
  }
  state.selectedDragItemId = null;
  renderDragDropQuestion(state.sessionQuestions[state.currentIndex]);
}

function createDragCard(item, placed = false) {
  const card = document.createElement("div");
  card.className = "drag-item";
  card.textContent = item.text;
  card.draggable = !state.finished;
  card.dataset.itemId = item.id;
  card.setAttribute("role", "button");
  card.tabIndex = state.finished ? -1 : 0;

  if (state.selectedDragItemId === item.id) card.classList.add("selected");

  card.addEventListener("dragstart", event => {
    if (state.finished) return;
    event.dataTransfer.setData("text/plain", item.id);
    event.dataTransfer.effectAllowed = "move";
    card.classList.add("dragging");
  });
  card.addEventListener("dragend", () => card.classList.remove("dragging"));

  const selectItem = () => {
    if (state.finished) return;
    state.selectedDragItemId = state.selectedDragItemId === item.id ? null : item.id;
    renderDragDropQuestion(state.sessionQuestions[state.currentIndex]);
  };

  card.addEventListener("click", event => {
    event.stopPropagation();
    selectItem();
  });
  card.addEventListener("keydown", event => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      selectItem();
    }
  });

  if (placed) card.title = "Drag to another slot, or click then choose another slot";
  else card.title = "Drag to a blank slot, or click then click a slot";

  return card;
}

function renderDragDropQuestion(q) {
  const host = $("dragDropArea");
  host.innerHTML = "";
  host.classList.remove("hidden");
  $("options").classList.add("hidden");

  const response = getDragResponse();
  const shouldShow = state.finished || state.revealed.has(state.currentIndex);
  const itemsById = new Map((q.dragItems || []).map(item => [item.id, item]));
  const assignedIds = new Set(Object.values(response));
  const unassigned = (q.dragItems || []).filter(item => !assignedIds.has(item.id));

  const grid = document.createElement("div");
  grid.className = "dragdrop-grid";

  const poolColumn = document.createElement("div");
  const poolTitle = document.createElement("div");
  poolTitle.className = "dragdrop-column-title";
  poolTitle.textContent = "Choices";
  const pool = document.createElement("div");
  pool.className = "drag-pool";

  pool.addEventListener("dragover", event => {
    if (!state.finished) event.preventDefault();
  });
  pool.addEventListener("drop", event => {
    if (state.finished) return;
    event.preventDefault();
    const itemId = event.dataTransfer.getData("text/plain");
    if (itemId) unassignDragItem(itemId);
  });
  pool.addEventListener("click", () => {
    if (state.selectedDragItemId) unassignDragItem(state.selectedDragItemId);
  });

  unassigned.forEach(item => pool.appendChild(createDragCard(item)));
  if (!unassigned.length) {
    const empty = document.createElement("div");
    empty.className = "muted small";
    empty.textContent = state.finished ? "All items placed." : "All available items are currently placed.";
    pool.appendChild(empty);
  }
  poolColumn.append(poolTitle, pool);

  const labelsColumn = document.createElement("div");
  labelsColumn.className = "dragdrop-label-column";
  const labelsTitle = document.createElement("div");
  labelsTitle.className = "dragdrop-column-title";
  labelsTitle.textContent = "Target";
  labelsColumn.appendChild(labelsTitle);

  const slotsColumn = document.createElement("div");
  slotsColumn.className = "dragdrop-slot-column";
  const slotsTitle = document.createElement("div");
  slotsTitle.className = "dragdrop-column-title";
  slotsTitle.textContent = "Your answer";
  slotsColumn.appendChild(slotsTitle);

  (q.dropTargets || []).forEach(target => {
    const label = document.createElement("div");
    label.className = "drag-label";
    label.textContent = target.label;
    labelsColumn.appendChild(label);

    const slotWrap = document.createElement("div");
    const slot = document.createElement("div");
    slot.className = "drop-slot";
    slot.dataset.targetId = target.id;

    const placedItemId = response[target.id];
    const placedItem = placedItemId ? itemsById.get(placedItemId) : null;

    if (placedItem) {
      slot.classList.add("filled");
      slot.appendChild(createDragCard(placedItem, true));
    } else {
      slot.textContent = state.finished ? "No answer" : "Drop here";
    }

    slot.addEventListener("dragover", event => {
      if (state.finished) return;
      event.preventDefault();
      slot.classList.add("drag-over");
    });
    slot.addEventListener("dragleave", () => slot.classList.remove("drag-over"));
    slot.addEventListener("drop", event => {
      if (state.finished) return;
      event.preventDefault();
      slot.classList.remove("drag-over");
      const itemId = event.dataTransfer.getData("text/plain");
      if (itemId) assignDragItem(target.id, itemId);
    });
    slot.addEventListener("click", event => {
      if (state.finished || event.target.closest(".drag-item")) return;
      if (state.selectedDragItemId) assignDragItem(target.id, state.selectedDragItemId);
    });

    if (shouldShow) {
      if (placedItemId === target.correctItemId) {
        slot.classList.add("correct-drop");
      } else {
        if (placedItemId) slot.classList.add("wrong-drop");
        const correct = itemsById.get(target.correctItemId);
        if (correct) {
          const note = document.createElement("div");
          note.className = "drop-correct-note";
          note.textContent = `Correct: ${correct.text}`;
          slotWrap.appendChild(note);
        }
      }
    }

    slotWrap.prepend(slot);
    slotsColumn.appendChild(slotWrap);
  });

  grid.append(poolColumn, labelsColumn, slotsColumn);
  host.appendChild(grid);

  const help = document.createElement("div");
  help.className = "dragdrop-help";
  help.textContent = state.finished
    ? "Answers are locked for review."
    : "Drag choices into the matching slots. On touch devices, tap a choice and then tap a slot. You can move an answer again before finishing.";
  host.appendChild(help);
}

function renderChoiceQuestion(q) {
  const optionsHost = $("options");
  optionsHost.classList.remove("hidden");
  $("dragDropArea").classList.add("hidden");
  optionsHost.innerHTML = "";
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
      if (q.type === "single") {
        state.responses[state.currentIndex] = [i];
      } else {
        state.responses[state.currentIndex] = [...optionsHost.querySelectorAll("input:checked")]
          .map(x => Number(x.value));
      }
    });

    const span = document.createElement("span");
    const answerLetter = String.fromCharCode(65 + i);
    span.textContent = `${answerLetter}. ${opt.text}`;
    label.append(input, span);
    optionsHost.appendChild(label);
  });
}

function renderAnswerReview(q, shouldShow) {
  $("answerBox").classList.toggle("hidden", !shouldShow);
  if (!shouldShow) return;

  $("answerText").innerHTML = "";
  $("explanationText").textContent = q.explanation || "";

  if (q.type === "dragdrop") {
    const title = document.createElement("div");
    title.textContent = "Correct mapping:";
    title.style.marginBottom = "8px";
    $("answerText").appendChild(title);

    const itemsById = new Map((q.dragItems || []).map(item => [item.id, item]));
    const list = document.createElement("div");
    list.className = "drag-answer-list";
    (q.dropTargets || []).forEach(target => {
      const item = itemsById.get(target.correctItemId);
      const row = document.createElement("div");
      row.textContent = `${target.label} → ${item?.text || "Unknown item"}`;
      list.appendChild(row);
    });
    $("answerText").appendChild(list);
    return;
  }

  const selected = state.responses[state.currentIndex] || [];
  const optionsHost = $("options");
  [...optionsHost.querySelectorAll(".option")].forEach((label, i) => {
    const option = q.options[i];
    if (option.isCorrect) label.classList.add("correct-answer");
    else if (selected.includes(i)) label.classList.add("wrong-answer");
  });

  const correctAnswers = q.options
    .map((o, i) => ({ ...o, letter: String.fromCharCode(65 + i) }))
    .filter(o => o.isCorrect);
  const letters = correctAnswers.map(o => o.letter).join(", ");

  const answerSummary = document.createElement("div");
  answerSummary.textContent = `Correct Answer${correctAnswers.length > 1 ? "s" : ""}: ${letters}`;
  answerSummary.style.marginBottom = "8px";
  $("answerText").appendChild(answerSummary);

  correctAnswers.forEach(answer => {
    const answerDetail = document.createElement("div");
    answerDetail.textContent = `${answer.letter}. ${answer.text}`;
    $("answerText").appendChild(answerDetail);
  });
}

function renderQuestion() {
  const q = state.sessionQuestions[state.currentIndex];
  state.selectedDragItemId = null;

  $("progressText").textContent = `Question ${state.currentIndex + 1} of ${state.sessionQuestions.length}`;
  $("questionType").textContent = questionTypeLabel(q.type);
  $("questionText").textContent = q.text;
  renderImageGallery(q);

  const manuallyRevealed = state.revealed.has(state.currentIndex);
  const shouldShow = state.finished || manuallyRevealed;

  if (q.type === "dragdrop") renderDragDropQuestion(q);
  else renderChoiceQuestion(q);

  if (state.finished) {
    $("showAnswerBtn").textContent = "Answers Shown";
    $("showAnswerBtn").disabled = true;
  } else {
    $("showAnswerBtn").textContent = manuallyRevealed ? "Hide Answers" : "Show Answers";
    $("showAnswerBtn").disabled = false;
  }

  renderAnswerReview(q, shouldShow);

  $("prevBtn").disabled = state.currentIndex === 0;
  $("nextBtn").disabled = state.currentIndex === state.sessionQuestions.length - 1;
}

function isQuestionCorrect(q, index) {
  if (q.type === "dragdrop") {
    const response = state.responses[index] || {};
    return (q.dropTargets || []).every(target => response[target.id] === target.correctItemId);
  }

  const selected = state.responses[index] || [];
  const selectedFlags = q.options.map((_, idx) => selected.includes(idx));
  const correctFlags = q.options.map(o => o.isCorrect);
  return selectedFlags.every((v, idx) => v === correctFlags[idx]);
}

function finishExam() {
  state.finished = true;
  let score = 0;
  state.sessionQuestions.forEach((q, i) => {
    if (isQuestionCorrect(q, i)) score++;
  });

  const percent = Math.round((score / state.sessionQuestions.length) * 100);
  $("resultBox").innerHTML = `
    <h2>Result</h2>
    <p><strong>${score}/${state.sessionQuestions.length}</strong> correct (${percent}%).</p>
    <p>Answers are now visible while you review the questions.</p>
  `;
  $("resultBox").classList.remove("hidden");
  renderQuestion();
}

function addOptionEditor(text = "", correct = false) {
  const row = document.createElement("div");
  row.className = "option-editor";

  const check = document.createElement("input");
  check.type = "checkbox";
  check.className = "correct-check";
  check.checked = correct;
  check.title = "Correct answer";

  const input = document.createElement("input");
  input.className = "option-text";
  input.value = text;
  input.placeholder = "Answer option";

  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "secondary";
  remove.textContent = "×";
  remove.addEventListener("click", () => {
    if ($("optionEditors").children.length > 2) row.remove();
  });

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
    if ($("dragItemEditors").children.length > 2) {
      row.remove();
      syncDropTargetSelects();
    }
  });

  row.append(input, remove);
  $("dragItemEditors").appendChild(row);
  syncDropTargetSelects();
}

function currentDragEditorItems() {
  return [...$("dragItemEditors").children]
    .map(row => ({
      id: row.dataset.itemId,
      text: row.querySelector(".drag-item-text").value.trim()
    }))
    .filter(item => item.text);
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
  remove.addEventListener("click", () => {
    if ($("dropTargetEditors").children.length > 1) row.remove();
  });

  row.append(labelInput, select, remove);
  $("dropTargetEditors").appendChild(row);
  syncDropTargetSelects();
}

function syncDropTargetSelects() {
  if (!$(`dropTargetEditors`)) return;
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
  const isDragDrop = $("answerType").value === "dragdrop";
  $("choiceEditorSection").classList.toggle("hidden", isDragDrop);
  $("dragDropEditorSection").classList.toggle("hidden", !isDragDrop);
}

function renderImagePreviews() {
  const host = $("imagePreviewList");
  host.innerHTML = "";

  state.imageData.forEach((src, index) => {
    const item = document.createElement("div");
    item.className = "image-preview-item";

    const img = document.createElement("img");
    img.src = src;
    img.alt = `Selected image ${index + 1}`;

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "remove-image";
    remove.textContent = "×";
    remove.setAttribute("aria-label", `Remove image ${index + 1}`);
    remove.addEventListener("click", () => {
      state.imageData.splice(index, 1);
      renderImagePreviews();
    });

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
  button.addEventListener("click", () => resetQuestionForm());

  const submitButton = $("questionForm").querySelector('button[type="submit"]');
  submitButton.insertAdjacentElement("afterend", button);
  return button;
}

function setQuestionFormMode(editing) {
  const form = $("questionForm");
  const heading = form.querySelector("h3");
  const submitButton = form.querySelector('button[type="submit"]');
  const cancelButton = ensureCancelEditButton();

  heading.textContent = editing ? "Edit Question" : "Add Question";
  submitButton.textContent = editing ? "Update Question" : "Save Question";
  cancelButton.classList.toggle("hidden", !editing);
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
  $("questionForm").reset();
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

    (question.dropTargets || []).forEach(target => {
      addDropTargetEditor(target.label, target.correctItemId, target.id);
    });
    if (!$("dropTargetEditors").children.length) addDropTargetEditor("1");
    syncDropTargetSelects();
  } else {
    (question.options || []).forEach((option, index) => {
      addOptionEditor(option, (question.correct || []).includes(index));
    });
    while ($("optionEditors").children.length < 2) addOptionEditor();

    for (let i = 0; i < 4; i++) addDragItemEditor();
    for (let i = 0; i < 4; i++) addDropTargetEditor(String(i + 1));
  }

  renderImagePreviews();
  toggleQuestionEditorType();
  setQuestionFormMode(true);
  $("formMessage").textContent = "Editing saved question. Existing images can be removed or new images added.";
  $("questionForm").scrollIntoView({ behavior: "smooth", block: "start" });
  $("newQuestion").focus({ preventScroll: true });
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
      <div class="q-head">
        <div>
          <strong>${idx + 1}. ${escapeHtml(q.text)}</strong>
          <div class="muted small">
            ${typeText}${imageCount ? ` · ${imageCount} image${imageCount === 1 ? "" : "s"}` : ""}
          </div>
        </div>
        <div class="question-actions" style="display:flex;gap:8px;flex-wrap:wrap;">
          <button type="button" class="secondary edit-question-btn">Edit</button>
          <button type="button" class="secondary delete-question-btn">Delete</button>
        </div>
      </div>
    `;

    item.querySelector(".edit-question-btn").addEventListener("click", () => beginEditQuestion(q));
    item.querySelector(".delete-question-btn").addEventListener("click", async () => {
      await api(`/api/exams/${state.selectedExam.id}/questions/${q.id}`, { method: "DELETE" });
      if (state.editingQuestionId === q.id) resetQuestionForm();
      state.selectedExam = await api(`/api/exams/${state.selectedExam.id}`);
      renderQuestionBank();
      fillQuestionCount();
    });

    host.appendChild(item);
  });
}

$("homeBtn").addEventListener("click", async () => {
  await loadExamList();
  showView("examListView");
});

$("newExamBtn").addEventListener("click", () => $("newExamDialog").showModal());
$("cancelDialogBtn").addEventListener("click", () => $("newExamDialog").close());

$("newExamForm").addEventListener("submit", async e => {
  e.preventDefault();
  const exam = await api("/api/exams", {
    method: "POST",
    body: JSON.stringify({
      title: $("examTitle").value,
      description: $("examDescription").value
    })
  });

  $("newExamDialog").close();
  e.target.reset();
  await loadExamList();
  await openExam(exam.id);
});

$("startExamBtn").addEventListener("click", prepareSession);

$("editExamBtn").addEventListener("click", () => {
  resetQuestionForm();
  renderQuestionBank();
  showView("editView");
});

$("prevBtn").addEventListener("click", () => {
  state.currentIndex--;
  state.currentImageIndex = 0;
  renderQuestion();
});

$("nextBtn").addEventListener("click", () => {
  state.currentIndex++;
  state.currentImageIndex = 0;
  renderQuestion();
});

$("showAnswerBtn").addEventListener("click", () => {
  if (state.finished) return;
  if (state.revealed.has(state.currentIndex)) state.revealed.delete(state.currentIndex);
  else state.revealed.add(state.currentIndex);
  renderQuestion();
});

$("finishBtn").addEventListener("click", finishExam);
$("addOptionBtn").addEventListener("click", () => addOptionEditor());
$("addDragItemBtn").addEventListener("click", () => addDragItemEditor());
$("addDropTargetBtn").addEventListener("click", () => {
  const number = $("dropTargetEditors").children.length + 1;
  addDropTargetEditor(String(number));
});
$("answerType").addEventListener("change", toggleQuestionEditorType);

$("prevImageBtn").addEventListener("click", () => changeQuestionImage(-1));
$("nextImageBtn").addEventListener("click", () => changeQuestionImage(1));
$("zoomImageBtn").addEventListener("click", openImageZoom);
$("zoomImageTextBtn").addEventListener("click", openImageZoom);
$("zoomPrevBtn").addEventListener("click", () => changeQuestionImage(-1));
$("zoomNextBtn").addEventListener("click", () => changeQuestionImage(1));
$("closeZoomBtn").addEventListener("click", () => $("imageZoomDialog").close());

$("imageZoomDialog").addEventListener("click", event => {
  if (event.target === $("imageZoomDialog")) $("imageZoomDialog").close();
});

$("imageFile").addEventListener("change", async e => {
  const files = [...(e.target.files || [])];
  if (!files.length) return;

  try {
    const loaded = await Promise.all(files.map(file => new Promise((resolve, reject) => {
      if (!file.type.startsWith("image/")) {
        reject(new Error(`${file.name} is not an image.`));
        return;
      }
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
  const payload = {
    text: $("newQuestion").value,
    type,
    explanation: $("explanation").value,
    images: state.imageData
  };

  if (type === "dragdrop") {
    const dragItems = currentDragEditorItems();
    const dropTargets = [...$("dropTargetEditors").children]
      .map(row => ({
        id: row.dataset.targetId,
        label: row.querySelector(".drop-target-label").value.trim(),
        correctItemId: row.querySelector(".drop-target-correct").value
      }))
      .filter(target => target.label || target.correctItemId);

    payload.dragItems = dragItems;
    payload.dropTargets = dropTargets;
  } else {
    const rows = [...$("optionEditors").children];
    const options = [];
    const correct = [];

    for (const row of rows) {
      const text = row.querySelector(".option-text").value.trim();
      if (!text) continue;
      if (row.querySelector(".correct-check").checked) correct.push(options.length);
      options.push(text);
    }

    payload.options = options;
    payload.correct = correct;
  }

  const editingQuestionId = state.editingQuestionId;
  const endpoint = editingQuestionId
    ? `/api/exams/${state.selectedExam.id}/questions/${editingQuestionId}`
    : `/api/exams/${state.selectedExam.id}/questions`;

  try {
    await api(endpoint, {
      method: editingQuestionId ? "PUT" : "POST",
      body: JSON.stringify(payload)
    });

    state.selectedExam = await api(`/api/exams/${state.selectedExam.id}`);
    resetQuestionForm();
    $("formMessage").textContent = editingQuestionId ? "Question updated." : "Question saved.";
    renderQuestionBank();
    fillQuestionCount();
  } catch (err) {
    $("formMessage").textContent = err.message;
  }
});

ensureCancelEditButton();
resetQuestionForm();

loadExamList().catch(err => {
  $("examList").innerHTML = `<div class="card"><p>${escapeHtml(err.message)}</p></div>`;
});
