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
  editingQuestionId: null
};

const $ = id => document.getElementById(id);
const views = ["examListView", "configureView", "examView", "editView"];

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

  // Backward compatibility with questions created before multi-image support.
  return question.image ? [question.image] : [];
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

  let questions = state.selectedExam.questions.map(q => ({
    ...q,
    options: q.options.map((text, originalIndex) => ({
      text,
      isCorrect: q.correct.includes(originalIndex)
    }))
  }));

  if (shuffleQ) questions = shuffled(questions);
  questions = questions.slice(0, count);

  if (shuffleA) {
    questions = questions.map(q => ({
      ...q,
      options: shuffled(q.options)
    }));
  }

  state.sessionQuestions = questions;
  state.currentIndex = 0;
  state.currentImageIndex = 0;
  state.responses = {};
  state.revealed = new Set();
  state.finished = false;

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

function renderQuestion() {
  const q = state.sessionQuestions[state.currentIndex];

  $("progressText").textContent = `Question ${state.currentIndex + 1} of ${state.sessionQuestions.length}`;
  $("questionType").textContent = q.type === "multiple" ? "Select all that apply" : "Select one";
  $("questionText").textContent = q.text;

  renderImageGallery(q);

  const optionsHost = $("options");
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

  const manuallyRevealed = state.revealed.has(state.currentIndex);
  const shouldShow = state.finished || manuallyRevealed;
  $("answerBox").classList.toggle("hidden", !shouldShow);

  if (state.finished) {
    $("showAnswerBtn").textContent = "Answers Shown";
    $("showAnswerBtn").disabled = true;
  } else {
    $("showAnswerBtn").textContent = manuallyRevealed ? "Hide Answers" : "Show Answers";
    $("showAnswerBtn").disabled = false;
  }

  if (shouldShow) {
    const selected = state.responses[state.currentIndex] || [];

    [...optionsHost.querySelectorAll(".option")].forEach((label, i) => {
      const option = q.options[i];
      if (option.isCorrect) {
        label.classList.add("correct-answer");
      } else if (selected.includes(i)) {
        label.classList.add("wrong-answer");
      }
    });

    const correctAnswers = q.options
      .map((o, i) => ({ ...o, letter: String.fromCharCode(65 + i) }))
      .filter(o => o.isCorrect);

    const letters = correctAnswers.map(o => o.letter).join(", ");
    $("answerText").innerHTML = "";

    const answerSummary = document.createElement("div");
    answerSummary.textContent = `Correct Answer${correctAnswers.length > 1 ? "s" : ""}: ${letters}`;
    answerSummary.style.marginBottom = "8px";
    $("answerText").appendChild(answerSummary);

    correctAnswers.forEach(answer => {
      const answerDetail = document.createElement("div");
      answerDetail.textContent = `${answer.letter}. ${answer.text}`;
      $("answerText").appendChild(answerDetail);
    });

    $("explanationText").textContent = q.explanation || "";
  }

  $("prevBtn").disabled = state.currentIndex === 0;
  $("nextBtn").disabled = state.currentIndex === state.sessionQuestions.length - 1;
}

function finishExam() {
  state.finished = true;
  let score = 0;

  state.sessionQuestions.forEach((q, i) => {
    const selected = state.responses[i] || [];
    const selectedFlags = q.options.map((_, idx) => selected.includes(idx));
    const correctFlags = q.options.map(o => o.isCorrect);
    if (selectedFlags.every((v, idx) => v === correctFlags[idx])) score++;
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
  for (let i = 0; i < 4; i++) addOptionEditor();
  state.imageData = [];
  state.editingQuestionId = null;
  renderImagePreviews();
  $("formMessage").textContent = "";
  setQuestionFormMode(false);
}

function beginEditQuestion(question) {
  $("questionForm").reset();
  $("optionEditors").innerHTML = "";

  state.editingQuestionId = question.id;
  state.imageData = [...getQuestionImages(question)];

  $("newQuestion").value = question.text || "";
  $("answerType").value = question.type === "multiple" ? "multiple" : "single";
  $("explanation").value = question.explanation || "";

  question.options.forEach((option, index) => {
    addOptionEditor(option, question.correct.includes(index));
  });

  while ($("optionEditors").children.length < 2) addOptionEditor();

  renderImagePreviews();
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

    item.innerHTML = `
      <div class="q-head">
        <div>
          <strong>${idx + 1}. ${escapeHtml(q.text)}</strong>
          <div class="muted small">
            ${q.type === "multiple" ? "Multiple answers" : "Single answer"} ·
            ${q.options.length} options${imageCount ? ` · ${imageCount} image${imageCount === 1 ? "" : "s"}` : ""}
          </div>
        </div>
        <div class="question-actions" style="display:flex;gap:8px;flex-wrap:wrap;">
          <button type="button" class="secondary edit-question-btn">Edit</button>
          <button type="button" class="secondary delete-question-btn">Delete</button>
        </div>
      </div>
    `;

    item.querySelector(".edit-question-btn").addEventListener("click", () => {
      beginEditQuestion(q);
    });

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

  if (state.revealed.has(state.currentIndex)) {
    state.revealed.delete(state.currentIndex);
  } else {
    state.revealed.add(state.currentIndex);
  }

  renderQuestion();
});

$("finishBtn").addEventListener("click", finishExam);
$("addOptionBtn").addEventListener("click", () => addOptionEditor());

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

  const rows = [...$("optionEditors").children];
  const options = [];
  const correct = [];

  for (const row of rows) {
    const text = row.querySelector(".option-text").value.trim();
    if (!text) continue;
    if (row.querySelector(".correct-check").checked) correct.push(options.length);
    options.push(text);
  }

  const payload = {
    text: $("newQuestion").value,
    type: $("answerType").value,
    options,
    correct,
    explanation: $("explanation").value,
    images: state.imageData
  };

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
setQuestionFormMode(false);

loadExamList().catch(err => {
  $("examList").innerHTML = `<div class="card"><p>${escapeHtml(err.message)}</p></div>`;
});
