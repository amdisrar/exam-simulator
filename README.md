# Exam Simulator

A simple, lightweight, persistent exam simulator built with Node.js, Express, HTML, CSS, and vanilla JavaScript.

The application supports multiple exams, randomized question selection, shuffled questions and answers, single-answer and multiple-answer questions, images, answer review, and a simple question editor.

## Features

- Multiple exams
- Persistent exam storage using JSON
- Single-answer questions
- Multiple-answer questions
- Optional question images
- Random question selection
- Shuffle questions
- Shuffle answers
- Answer choices displayed as A, B, C, D, etc.
- Show / Hide Answers
- Correct answers highlighted in green
- Incorrect selected answers highlighted in red
- Correct-answer details and explanations
- Final exam scoring
- Create new exams
- Add questions through the web interface
- Delete questions
- Responsive web interface
- No database required

## Technology Stack

- Node.js
- Express
- HTML5
- CSS3
- Vanilla JavaScript
- JSON file storage

## Project Structure

```text
exam-simulator/
├── data/
│   └── exams.json
├── public/
│   ├── index.html
│   ├── app.js
│   └── styles.css
├── server.js
├── package.json
├── README.md
└── .gitignore
```

## License

This project is intended for personal, educational, and training use. Licensed under the MIT License, see the [LICENSE](LICENSE) file for details.
