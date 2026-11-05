function taskNotFound(taskRef) {
  return Object.assign(new Error(`Task not found: ${taskRef}`), { code: 'TASK_NOT_FOUND' });
}


module.exports = { taskNotFound };
