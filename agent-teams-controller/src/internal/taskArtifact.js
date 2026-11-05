const crypto = require('crypto');
const fs = require('fs');
const runtimeHelpers = require('./runtimeHelpers.js');
const taskStore = require('./taskStore.js');
const { withTeamBoardLock } = require('./boardLock.js');
const { assertTaskOwnerMutation, assertTaskNotDeleted } = require('./taskOwnershipGuards.js');

const MAX_ARTIFACT_BYTES = 20 * 1024 * 1024;
const MAX_BASE64_CHARS = Math.ceil(MAX_ARTIFACT_BYTES / 3) * 4;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function validateFilename(value) {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > 255 ||
    /[\\/:\x00-\x1f]/.test(value) ||
    value.trim() === '.' ||
    value.trim() === '..'
  ) {
    throw new Error('Artifact name must be a filename without a directory');
  }
  return value.trim();
}

function decodeArtifact(file) {
  if (!file || typeof file !== 'object')
    throw new Error('Artifact file must include filename and base64Data');
  const filename = validateFilename(file.filename);
  const encoded = file.base64Data;
  if (typeof encoded !== 'string' || encoded.length > MAX_BASE64_CHARS)
    throw new Error('Artifact exceeds the 20 MiB limit');
  if (encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded))
    throw new Error('Artifact content must be valid base64');
  const data = Buffer.from(encoded, 'base64');
  if (data.length > MAX_ARTIFACT_BYTES) throw new Error('Artifact exceeds the 20 MiB limit');
  if (data.toString('base64') !== encoded) throw new Error('Artifact content must be valid base64');
  return { filename, data };
}

function artifactPath(context, task, attachmentId) {
  if (typeof attachmentId !== 'string' || !UUID.test(attachmentId))
    throw new Error('Invalid artifact attachment ID');
  return runtimeHelpers.getStoredAttachmentPath(
    context.paths,
    task.id,
    attachmentId,
    'artifact.bin'
  );
}

function storeArtifact(context, task, file) {
  const { filename, data } = decodeArtifact(file);
  const attachmentId = crypto.randomUUID();
  const dir = runtimeHelpers.getTaskAttachmentsDir(context.paths, task.id);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = artifactPath(context, task, attachmentId);
  let fd;
  try {
    // Keep track of exclusive creation so a failed write never deletes a file
    // that existed before this attempt.
    fd = fs.openSync(filePath, 'wx', 0o600);
    fs.writeFileSync(fd, data);
    fs.closeSync(fd);
    fd = undefined;
  } catch (error) {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* best effort */
      }
      try {
        fs.unlinkSync(filePath);
      } catch {
        /* best effort */
      }
    }
    throw error;
  }
  return {
    proof: {
      attachmentId,
      sha256: crypto.createHash('sha256').update(data).digest('hex'),
      size: data.length,
    },
    meta: {
      id: attachmentId,
      filename,
      mimeType: 'application/octet-stream',
      size: data.length,
      addedAt: new Date().toISOString(),
      filePath,
    },
  };
}

function prepareUpdate(context, task, fields) {
  const safeFields = {
    subject: fields.subject,
    description: fields.description,
    groupChatId: fields.groupChatId,
  };
  if (fields.artifactProjectPath !== undefined)
    throw new Error('Project paths are not supported; send artifact file bytes');
  const hasRequired = fields.artifactRequired !== undefined;
  const hasExpected = fields.artifactExpectedFilename !== undefined;
  const hasFile = fields.artifactFile !== undefined;
  if (!hasRequired && !hasExpected && !hasFile) return safeFields;
  if (context.allowUserMessageSender === false)
    throw new Error('Only the user may change artifact requirements');
  if (hasRequired && typeof fields.artifactRequired !== 'boolean')
    throw new Error('artifactRequired must be a boolean');
  if (
    task.status === 'completed' &&
    ((hasRequired && fields.artifactRequired && !task.artifactRequirement?.required) ||
      hasExpected ||
      hasFile)
  ) {
    throw new Error('Reopen the completed task before changing its artifact');
  }
  let requirement = {
    ...(task.artifactRequirement || {}),
    required: hasRequired ? fields.artifactRequired : task.artifactRequirement?.required === true,
  };
  let attachments = task.attachments || [];
  if (!requirement.required) {
    attachments = attachments.filter((item) => item.id !== requirement.proof?.attachmentId);
    requirement = { required: false };
  }
  if (hasExpected) {
    if (!requirement.required)
      throw new Error('Enable the artifact requirement before setting its name');
    const filename = validateFilename(fields.artifactExpectedFilename);
    if (requirement.expectedFilename !== filename) {
      attachments = attachments.filter((item) => item.id !== requirement.proof?.attachmentId);
      requirement = { required: true, expectedFilename: filename };
    }
  }
  if (hasFile) {
    if (!requirement.required)
      throw new Error('Enable the artifact requirement before attaching a file');
    const filename = validateFilename(fields.artifactFile?.filename);
    if (requirement.expectedFilename && requirement.expectedFilename !== filename) {
      throw new Error(`Required artifact filename is ${requirement.expectedFilename}`);
    }
    const stored = storeArtifact(context, task, fields.artifactFile);
    attachments = [
      ...attachments.filter((item) => item.id !== requirement.proof?.attachmentId),
      stored.meta,
    ];
    requirement = { required: true, expectedFilename: filename, proof: stored.proof };
  }
  return { ...safeFields, artifactRequirement: requirement, attachments };
}

function removePrevious(context, previous, updated) {
  const oldId = previous.artifactRequirement?.proof?.attachmentId;
  if (!oldId || oldId === updated.artifactRequirement?.proof?.attachmentId) return;
  try {
    fs.unlinkSync(artifactPath(context, previous, oldId));
  } catch (error) {
    if (error.code !== 'ENOENT')
      console.warn(`[artifact] Could not remove replaced file: ${error.message}`);
  }
}

function commitPreparedUpdate(context, task, fields) {
  const prepared = prepareUpdate(context, task, fields);
  const stagedId =
    fields.artifactFile !== undefined
      ? prepared.artifactRequirement?.proof?.attachmentId
      : undefined;
  let updated;
  try {
    updated = taskStore.updateTaskFields(context.paths, task.id, prepared);
  } catch (error) {
    if (stagedId && stagedId !== task.artifactRequirement?.proof?.attachmentId) {
      try {
        // A failed write can have committed before reporting an error. Only
        // remove this newly created copy if fresh task metadata proves that it
        // is not referenced; an unreadable task leaves the outcome unknown.
        const current = taskStore.readTask(context.paths, task.id, { includeDeleted: true });
        const referenced =
          current.artifactRequirement?.proof?.attachmentId === stagedId ||
          current.attachments?.some((entry) => entry.id === stagedId);
        if (!referenced) fs.unlinkSync(artifactPath(context, task, stagedId));
      } catch (cleanupError) {
        if (cleanupError.code !== 'ENOENT')
          console.warn(
            `[artifact] Could not confirm or remove unreferenced file: ${cleanupError.message}`
          );
      }
    }
    throw error;
  }
  removePrevious(context, task, updated);
  return updated;
}

function updateTaskFields(context, taskId, fields) {
  return withTeamBoardLock(context.paths, () => {
    const task = taskStore.readTask(context.paths, taskId, { includeDeleted: true });
    assertTaskNotDeleted(task, 'updating task fields');
    return commitPreparedUpdate(context, task, fields);
  });
}

function verifyTask(context, task, includeData = false) {
  const requirement = task.artifactRequirement;
  if (!requirement?.required) return null;
  const proof = requirement.proof;
  if (!proof || !task.attachments?.some((item) => item.id === proof.attachmentId)) {
    throw new Error(
      'A required task artifact has not been attached; use task_set_artifact_file with file bytes'
    );
  }
  try {
    const file = artifactPath(context, task, proof.attachmentId);
    const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    try {
      const before = fs.fstatSync(fd);
      if (!before.isFile() || before.size > MAX_ARTIFACT_BYTES)
        throw new Error('Artifact is not a regular file within the 20 MiB limit');
      const hash = crypto.createHash('sha256');
      const buffer = Buffer.allocUnsafe(1024 * 1024);
      const chunks = includeData ? [] : null;
      let size = 0,
        bytes;
      while ((bytes = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
        size += bytes;
        if (size > MAX_ARTIFACT_BYTES) throw new Error('Artifact exceeds the 20 MiB limit');
        hash.update(buffer.subarray(0, bytes));
        if (chunks) chunks.push(Buffer.from(buffer.subarray(0, bytes)));
      }
      const after = fs.fstatSync(fd);
      const current = fs.statSync(file);
      if (
        size !== before.size ||
        size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        before.ctimeMs !== after.ctimeMs ||
        before.ino !== current.ino ||
        before.dev !== current.dev ||
        before.size !== current.size ||
        before.mtimeMs !== current.mtimeMs ||
        before.ctimeMs !== current.ctimeMs
      ) {
        throw new Error('Artifact changed while it was being read');
      }
      const sha256 = hash.digest('hex');
      if (sha256 !== proof.sha256 || size !== proof.size)
        throw new Error('Artifact has changed; attach it again');
      const checked = { attachmentId: proof.attachmentId, sha256, size };
      return chunks
        ? { proof: checked, base64Data: Buffer.concat(chunks, size).toString('base64') }
        : checked;
    } finally {
      fs.closeSync(fd);
    }
  } catch (error) {
    throw new Error(`Required task artifact cannot be verified: ${error.message}`);
  }
}

function verifyTaskArtifact(context, taskId) {
  return withTeamBoardLock(context.paths, () =>
    verifyTask(context, taskStore.readTask(context.paths, taskId))
  );
}

function readTaskArtifactData(context, taskId, attachmentId) {
  return withTeamBoardLock(context.paths, () => {
    let task;
    try {
      task = taskStore.readTask(context.paths, taskId);
    } catch (error) {
      if (error.code === 'TASK_NOT_FOUND') return null;
      throw error;
    }
    if (
      !task.artifactRequirement?.required ||
      task.artifactRequirement.proof?.attachmentId !== attachmentId
    )
      return null;
    return verifyTask(context, task, true).base64Data;
  });
}

function setTaskArtifactFile(context, taskId, file, actor) {
  return withTeamBoardLock(context.paths, () => {
    const task = taskStore.readTask(context.paths, taskId);
    assertTaskNotDeleted(task, 'attaching an artifact');
    assertTaskOwnerMutation(context, task, actor, 'attach an artifact');
    if (!task.artifactRequirement?.required)
      throw new Error('This task does not require an artifact');
    return commitPreparedUpdate({ ...context, allowUserMessageSender: true }, task, {
      artifactFile: file,
    });
  });
}

module.exports = {
  updateTaskFields,
  verifyTask,
  verifyTaskArtifact,
  readTaskArtifactData,
  setTaskArtifactFile,
};
