const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const runtimeHelpers = require('./runtimeHelpers.js');
const taskStore = require('./taskStore.js');
const { withTeamBoardLock } = require('./boardLock.js');
const { assertTaskOwnerMutation, assertTaskNotDeleted } = require('./taskOwnershipGuards.js');

function projectFile(paths, relativePath) {
  const config = runtimeHelpers.readTeamConfig(paths);
  const projectPath = config && config.projectPath;
  if (typeof projectPath !== 'string' || !path.isAbsolute(projectPath)) {
    throw new Error('A configured absolute projectPath is required for task artifacts');
  }
  if (
    typeof relativePath !== 'string' ||
    relativePath.length > 4096 ||
    !relativePath.trim() ||
    path.isAbsolute(relativePath) ||
    /[:\x00]/.test(relativePath) ||
    relativePath.split(/[\\/]/).some((part) => !part || part === '.' || part === '..')
  ) {
    throw new Error('Artifact path must be a relative file path inside the project');
  }
  const root = fs.realpathSync(projectPath);
  let file = root;
  for (const part of relativePath.split(/[\\/]/)) {
    file = path.join(file, part);
    if (fs.lstatSync(file).isSymbolicLink())
      throw new Error('Artifact paths cannot contain symbolic links');
  }
  const realFile = fs.realpathSync(file);
  const relative = path.relative(root, realFile);
  if (
    !relative ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error('Artifact must be inside the project');
  }
  return {
    file: realFile,
    rootFingerprint: crypto.createHash('sha256').update(root).digest('hex'),
  };
}

function hashProjectFile(paths, relativePath) {
  const { file, rootFingerprint } = projectFile(paths, relativePath);
  const target = fs.lstatSync(file);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile()) throw new Error('Artifact must be a regular file');
    const hash = crypto.createHash('sha256');
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let size = 0;
    let bytes;
    while ((bytes = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, bytes));
      size += bytes;
    }
    const after = fs.fstatSync(fd);
    const current = fs.statSync(file);
    const resolvedAgain = projectFile(paths, relativePath);
    if (
      size !== before.size ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      before.ino !== target.ino ||
      before.dev !== target.dev ||
      before.ino !== current.ino ||
      before.dev !== current.dev ||
      before.size !== current.size ||
      before.mtimeMs !== current.mtimeMs ||
      before.ctimeMs !== current.ctimeMs ||
      resolvedAgain.file !== file ||
      resolvedAgain.rootFingerprint !== rootFingerprint
    ) {
      throw new Error('Artifact changed while it was being read');
    }
    return { sha256: hash.digest('hex'), size, rootFingerprint };
  } finally {
    fs.closeSync(fd);
  }
}

function prepareUpdate(context, task, fields) {
  const safeFields = {
    subject: fields.subject,
    description: fields.description,
    groupChatId: fields.groupChatId,
  };
  const hasRequired = fields.artifactRequired !== undefined;
  const hasPath = fields.artifactProjectPath !== undefined;
  if (!hasRequired && !hasPath) return safeFields;
  if (context.allowUserMessageSender === false)
    throw new Error('Only the user may change artifact requirements');
  if (hasRequired && typeof fields.artifactRequired !== 'boolean')
    throw new Error('artifactRequired must be a boolean');
  let requirement = {
    ...(task.artifactRequirement || {}),
    required: hasRequired ? fields.artifactRequired : task.artifactRequirement?.required === true,
  };
  let attachments = task.attachments || [];
  if (!requirement.required) {
    attachments = attachments.filter((item) => item.id !== requirement.proof?.attachmentId);
    requirement = { required: false };
  }
  if (hasPath) {
    if (!requirement.required)
      throw new Error('Enable the artifact requirement before attaching a file');
    const hashed = hashProjectFile(context.paths, fields.artifactProjectPath);
    const attachmentId = crypto.randomUUID();
    attachments = attachments.filter((item) => item.id !== requirement.proof?.attachmentId);
    attachments = [
      ...attachments,
      {
        id: attachmentId,
        filename: path.basename(fields.artifactProjectPath.replace(/\\/g, '/')),
        mimeType: 'application/octet-stream',
        size: hashed.size,
        addedAt: new Date().toISOString(),
      },
    ];
    requirement = {
      required: true,
      proof: { attachmentId, sha256: hashed.sha256, size: hashed.size },
      reference: {
        relativePath: fields.artifactProjectPath,
        rootFingerprint: hashed.rootFingerprint,
      },
    };
  }
  return { ...safeFields, artifactRequirement: requirement, attachments };
}

function verifyTask(context, task) {
  const requirement = task.artifactRequirement;
  if (!requirement?.required) return null;
  const { proof, reference } = requirement;
  if (!proof || !reference || !task.attachments?.some((item) => item.id === proof.attachmentId)) {
    throw new Error(
      'A required task artifact has not been attached; use task_set_artifact_file with a project-relative path'
    );
  }
  let actual;
  try {
    actual = hashProjectFile(context.paths, reference.relativePath);
  } catch (error) {
    throw new Error(`Required task artifact cannot be verified: ${error.message}`);
  }
  if (
    actual.rootFingerprint !== reference.rootFingerprint ||
    actual.sha256 !== proof.sha256 ||
    actual.size !== proof.size
  ) {
    throw new Error('Required task artifact has changed; attach the current file again');
  }
  return { attachmentId: proof.attachmentId, sha256: actual.sha256, size: actual.size };
}

function verifyTaskArtifact(context, taskId) {
  return withTeamBoardLock(context.paths, () =>
    verifyTask(context, taskStore.readTask(context.paths, taskId))
  );
}

function setTaskArtifactFile(context, taskId, relativePath, actor) {
  return withTeamBoardLock(context.paths, () => {
    const task = taskStore.readTask(context.paths, taskId);
    assertTaskNotDeleted(task, 'attaching an artifact');
    assertTaskOwnerMutation(context, task, actor, 'attach an artifact');
    if (!task.artifactRequirement?.required)
      throw new Error('This task does not require an artifact');
    const fields = prepareUpdate({ ...context, allowUserMessageSender: true }, task, {
      artifactProjectPath: relativePath,
    });
    return taskStore.updateTaskFields(context.paths, taskId, fields);
  });
}

module.exports = { prepareUpdate, verifyTask, verifyTaskArtifact, setTaskArtifactFile };
