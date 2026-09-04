const state = {
  examList: [],
  selectedExam: null,
  sessionQuestions: [],
  currentIndex: 0,
  responses: {},
  revealed: new Set(),
  finished: false,
  imageData: ""
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

async function loadExamList() {
  state.examList = await api("/api/exams");

  const host = $("examList");
  host.innerHTML = "";

  if (!state.examList.length) {
    host.innerHTML = `
      <div class="card">
        <p>No exams found. Create your first exam.</p>
      </div>
    `;
    return;
  }

  for (const exam of state.examList) {
    const card = document.createElement("article");
    card.className = "exam-card";

    card.innerHTML = `
      <h3>${escapeHtml(exam.title)}</h3>
      <p>${escapeHtml(exam.description || "No description")}</p>
      <div class="count">
        ${exam.questionCount} question${exam.questionCount === 1 ? "" : "s"}
      </div>
    `;

    card.addEventListener("click", () => openExam(exam.id));

    host.appendChild(card);
  }
}

async function openExam(id) {
  state.selectedExam = await api(`/api/exams/${id}`);

  $("configureTitle").textContent = state.selectedExam.title;
  $("configureDescription").textContent =
    state.selectedExam.description || "";

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

  if (total) {
    select.value = String(total);
  }

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

  const count = Math.max(
    1,
    Math.min(
      Number($("questionCount").value) || total,
      total
    )
  );

  const shuffleQ = $("shuffleQuestions").value === "yes";
  const shuffleA = $("shuffleAnswers").value === "yes";

  let questions = state.selectedExam.questions.map(q => ({
    ...q,

    options: q.options.map((text, originalIndex) => ({
      text,
      isCorrect: q.correct.includes(originalIndex)
    }))
  }));

  if (shuffleQ) {
    questions = shuffled(questions);
  }

  questions = questions.slice(0, count);

  if (shuffleA) {
    questions = questions.map(q => ({
      ...q,
      options: shuffled(q.options)
    }));
  }

  state.sessionQuestions = questions;
  state.currentIndex = 0;
  state.responses = {};
  state.revealed = new Set();
  state.finished = false;

  $("resultBox").classList.add("hidden");

  renderQuestion();
  showView("examView");
}

function renderQuestion() {
  const q = state.sessionQuestions[state.currentIndex];

  $("progressText").textContent =
    `Question ${state.currentIndex + 1} of ${state.sessionQuestions.length}`;

  $("questionType").textContent =
    q.type === "multiple"
      ? "Select all that apply"
      : "Select one";

  $("questionText").textContent = q.text;

  /*
   * Question image
   */
  const img = $("questionImage");

  if (q.image) {
    img.src = q.image;
    img.classList.remove("hidden");
  } else {
    img.removeAttribute("src");
    img.classList.add("hidden");
  }

  /*
   * Answer options
   */
  const optionsHost = $("options");

  optionsHost.innerHTML = "";

  const saved =
    state.responses[state.currentIndex] || [];

  q.options.forEach((opt, i) => {
    const label = document.createElement("label");

    label.className = "option";

    const input =
      document.createElement("input");

    input.type =
      q.type === "multiple"
        ? "checkbox"
        : "radio";

    input.name =
      `question-${state.currentIndex}`;

    input.value = i;

    input.checked =
      saved.includes(i);

    input.disabled =
      state.finished;

    input.addEventListener("change", () => {
      if (q.type === "single") {
        state.responses[state.currentIndex] = [i];
      } else {
        state.responses[state.currentIndex] =
          [
            ...optionsHost.querySelectorAll(
              "input:checked"
            )
          ].map(x => Number(x.value));
      }
    });

    /*
     * Display option letters:
     * A. B. C. D. ...
     */
    const span =
      document.createElement("span");

    const answerLetter =
      String.fromCharCode(65 + i);

    span.textContent =
      `${answerLetter}. ${opt.text}`;

    label.append(input, span);

    optionsHost.appendChild(label);
  });

  /*
   * Determine whether answer should be visible
   */
  const manuallyRevealed =
    state.revealed.has(state.currentIndex);

  const shouldShow =
    state.finished || manuallyRevealed;

  $("answerBox").classList.toggle(
    "hidden",
    !shouldShow
  );

  /*
   * Show / Hide Answer button
   */
  if (state.finished) {
    $("showAnswerBtn").textContent =
      "Answers Shown";

    $("showAnswerBtn").disabled = true;
  } else {
    $("showAnswerBtn").textContent =
      manuallyRevealed
        ? "Hide Answers"
        : "Show Answers";

    $("showAnswerBtn").disabled = false;
  }

  /*
   * Reveal correct / incorrect answers
   */
  if (shouldShow) {
    const selected =
      state.responses[state.currentIndex] || [];

    [
      ...optionsHost.querySelectorAll(".option")
    ].forEach((label, i) => {
      const option = q.options[i];

      if (option.isCorrect) {
        /*
         * Correct answers = green
         */
        label.classList.add(
          "correct-answer"
        );
      } else if (selected.includes(i)) {
        /*
         * Wrong selected answers = red
         */
        label.classList.add(
          "wrong-answer"
        );
      }
    });

    /*
     * Build correct answers list
     */
    const correctAnswers =
      q.options
        .map((o, i) => ({
          ...o,
          letter:
            String.fromCharCode(65 + i)
        }))
        .filter(o => o.isCorrect);

    const letters =
      correctAnswers
        .map(o => o.letter)
        .join(", ");

    /*
     * First line:
     *
     * Correct Answers: A, C
     *
     * Second line onwards:
     *
     * A. Answer text
     * C. Answer text
     */
    $("answerText").innerHTML = "";

    const answerSummary =
      document.createElement("div");

    answerSummary.textContent =
      `Correct Answer${correctAnswers.length > 1
        ? "s"
        : ""
      }: ${letters}`;

    answerSummary.style.marginBottom =
      "8px";

    $("answerText").appendChild(
      answerSummary
    );

    correctAnswers.forEach(answer => {
      const answerDetail =
        document.createElement("div");

      answerDetail.textContent =
        `${answer.letter}. ${answer.text}`;

      $("answerText").appendChild(
        answerDetail
      );
    });

    $("explanationText").textContent =
      q.explanation || "";
  }

  /*
   * Navigation buttons
   */
  $("prevBtn").disabled =
    state.currentIndex === 0;

  $("nextBtn").disabled =
    state.currentIndex ===
    state.sessionQuestions.length - 1;
}

function finishExam() {
  state.finished = true;

  let score = 0;

  state.sessionQuestions.forEach(
    (q, i) => {
      const selected =
        state.responses[i] || [];

      const selectedFlags =
        q.options.map(
          (_, idx) =>
            selected.includes(idx)
        );

      const correctFlags =
        q.options.map(
          o => o.isCorrect
        );

      if (
        selectedFlags.every(
          (v, idx) =>
            v === correctFlags[idx]
        )
      ) {
        score++;
      }
    }
  );

  const percent =
    Math.round(
      (
        score /
        state.sessionQuestions.length
      ) * 100
    );

  $("resultBox").innerHTML = `
    <h2>Result</h2>

    <p>
      <strong>
        ${score}/${state.sessionQuestions.length}
      </strong>
      correct (${percent}%).
    </p>

    <p>
      Answers are now visible while you review the questions.
    </p>
  `;

  $("resultBox").classList.remove(
    "hidden"
  );

  renderQuestion();
}

function addOptionEditor(
  text = "",
  correct = false
) {
  const row =
    document.createElement("div");

  row.className =
    "option-editor";

  const check =
    document.createElement("input");

  check.type =
    "checkbox";

  check.className =
    "correct-check";

  check.checked =
    correct;

  check.title =
    "Correct answer";

  const input =
    document.createElement("input");

  input.className =
    "option-text";

  input.value =
    text;

  input.placeholder =
    "Answer option";

  const remove =
    document.createElement("button");

  remove.type =
    "button";

  remove.className =
    "secondary";

  remove.textContent =
    "×";

  remove.addEventListener(
    "click",
    () => {
      if (
        $("optionEditors").children.length >
        2
      ) {
        row.remove();
      }
    }
  );

  row.append(
    check,
    input,
    remove
  );

  $("optionEditors").appendChild(row);
}

function resetQuestionForm() {
  $("questionForm").reset();

  $("optionEditors").innerHTML = "";

  for (
    let i = 0;
    i < 4;
    i++
  ) {
    addOptionEditor();
  }

  state.imageData = "";

  $("imagePreview").classList.add(
    "hidden"
  );

  $("imagePreview").removeAttribute(
    "src"
  );

  $("formMessage").textContent = "";
}

function renderQuestionBank() {
  $("editTitle").textContent =
    `Edit: ${state.selectedExam.title}`;

  const host =
    $("questionBank");

  host.innerHTML = "";

  if (
    !state.selectedExam.questions.length
  ) {
    host.innerHTML =
      `<p class="muted">
        No questions yet.
      </p>`;

    return;
  }

  state.selectedExam.questions.forEach(
    (q, idx) => {
      const item =
        document.createElement("div");

      item.className =
        "question-bank-item";

      item.innerHTML = `
        <div class="q-head">

          <div>
            <strong>
              ${idx + 1}.
              ${escapeHtml(q.text)}
            </strong>

            <div class="muted small">
              ${q.type === "multiple"
          ? "Multiple answers"
          : "Single answer"
        }
              ·
              ${q.options.length}
              options
            </div>
          </div>

          <button
            type="button"
            class="secondary"
          >
            Delete
          </button>

        </div>
      `;

      item
        .querySelector("button")
        .addEventListener(
          "click",
          async () => {
            await api(
              `/api/exams/${state.selectedExam.id}/questions/${q.id}`,
              {
                method: "DELETE"
              }
            );

            state.selectedExam =
              await api(
                `/api/exams/${state.selectedExam.id}`
              );

            renderQuestionBank();
            fillQuestionCount();
          }
        );

      host.appendChild(item);
    }
  );
}

function escapeHtml(s) {
  return String(s).replace(
    /[&<>"']/g,
    c =>
    ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    }[c])
  );
}

/*
 * Home
 */
$("homeBtn").addEventListener(
  "click",
  async () => {
    await loadExamList();

    showView("examListView");
  }
);

/*
 * Create exam
 */
$("newExamBtn").addEventListener(
  "click",
  () =>
    $("newExamDialog").showModal()
);

$("cancelDialogBtn").addEventListener(
  "click",
  () =>
    $("newExamDialog").close()
);

$("newExamForm").addEventListener(
  "submit",
  async e => {
    e.preventDefault();

    const exam = await api(
      "/api/exams",
      {
        method: "POST",

        body: JSON.stringify({
          title:
            $("examTitle").value,

          description:
            $("examDescription").value
        })
      }
    );

    $("newExamDialog").close();

    e.target.reset();

    await loadExamList();

    await openExam(exam.id);
  }
);

/*
 * Start Exam
 */
$("startExamBtn").addEventListener(
  "click",
  prepareSession
);

/*
 * Edit Exam
 */
$("editExamBtn").addEventListener(
  "click",
  () => {
    resetQuestionForm();

    renderQuestionBank();

    showView("editView");
  }
);

/*
 * Previous
 */
$("prevBtn").addEventListener(
  "click",
  () => {
    state.currentIndex--;

    renderQuestion();
  }
);

/*
 * Next
 */
$("nextBtn").addEventListener(
  "click",
  () => {
    state.currentIndex++;

    renderQuestion();
  }
);

/*
 * Show / Hide Answers
 */
$("showAnswerBtn").addEventListener(
  "click",
  () => {
    /*
     * After exam completion all answers
     * remain permanently visible.
     */
    if (state.finished) {
      return;
    }

    /*
     * If currently shown,
     * hide the answer.
     */
    if (
      state.revealed.has(
        state.currentIndex
      )
    ) {
      state.revealed.delete(
        state.currentIndex
      );
    } else {
      /*
       * Otherwise show it.
       */
      state.revealed.add(
        state.currentIndex
      );
    }

    renderQuestion();
  }
);

/*
 * Finish Exam
 */
$("finishBtn").addEventListener(
  "click",
  finishExam
);

/*
 * Add another option
 */
$("addOptionBtn").addEventListener(
  "click",
  () => addOptionEditor()
);

/*
 * Question image
 */
$("imageFile").addEventListener(
  "change",
  e => {
    const file =
      e.target.files?.[0];

    if (!file) {
      return;
    }

    const reader =
      new FileReader();

    reader.onload = () => {
      state.imageData =
        reader.result;

      $("imagePreview").src =
        state.imageData;

      $("imagePreview").classList.remove(
        "hidden"
      );
    };

    reader.readAsDataURL(file);
  }
);

/*
 * Save question
 */
$("questionForm").addEventListener(
  "submit",
  async e => {
    e.preventDefault();

    const rows =
      [
        ...$("optionEditors").children
      ];

    const options = [];
    const correct = [];

    for (const row of rows) {
      const text =
        row
          .querySelector(
            ".option-text"
          )
          .value
          .trim();

      if (!text) {
        continue;
      }

      if (
        row
          .querySelector(
            ".correct-check"
          )
          .checked
      ) {
        correct.push(
          options.length
        );
      }

      options.push(text);
    }

    try {
      await api(
        `/api/exams/${state.selectedExam.id}/questions`,
        {
          method: "POST",

          body: JSON.stringify({
            text:
              $("newQuestion").value,

            type:
              $("answerType").value,

            options,

            correct,

            explanation:
              $("explanation").value,

            image:
              state.imageData
          })
        }
      );

      state.selectedExam =
        await api(
          `/api/exams/${state.selectedExam.id}`
        );

      resetQuestionForm();

      $("formMessage").textContent =
        "Question saved.";

      renderQuestionBank();

      fillQuestionCount();
    } catch (err) {
      $("formMessage").textContent =
        err.message;
    }
  }
);

/*
 * Initial page load
 */
loadExamList().catch(err => {
  $("examList").innerHTML = `
    <div class="card">
      <p>
        ${escapeHtml(err.message)}
      </p>
    </div>
  `;
});