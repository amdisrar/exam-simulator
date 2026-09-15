// Question validation rules.
//
// Extracted so the HTTP routes and the JSON import path apply exactly the same
// rules and produce the same error messages.

export function validateQuestion(question) {
  if (!question.text) return "Question text is required";

  if (question.type === "dragdrop") {
    if (question.dragItems.length < 2) return "At least two draggable items are required";
    if (!question.dropTargets.length) return "At least one drop target is required";

    const itemIds = question.dragItems.map(item => item.id);
    const itemIdSet = new Set(itemIds);
    if (itemIdSet.size !== itemIds.length) return "Draggable item IDs must be unique";

    const targetIds = question.dropTargets.map(target => target.id);
    if (new Set(targetIds).size !== targetIds.length) return "Drop target IDs must be unique";

    if (question.dropTargets.some(target => !target.label)) {
      return "Every drop target needs a label";
    }

    if (question.dropTargets.some(target => !itemIdSet.has(target.correctItemId))) {
      return "Every drop target must reference a valid correct draggable item";
    }

    const correctIds = question.dropTargets.map(target => target.correctItemId);
    if (new Set(correctIds).size !== correctIds.length) {
      return "A draggable item can only be the correct answer for one drop target";
    }

    return null;
  }

  if (question.options.length < 2) return "At least two options are required";
  if (!question.correct.length) return "At least one correct answer is required";

  if (question.type === "single" && question.correct.length !== 1) {
    return "Single-answer questions need exactly one correct answer";
  }

  if (question.correct.some(i => i < 0 || i >= question.options.length)) {
    return "Correct answer index is invalid";
  }

  return null;
}
