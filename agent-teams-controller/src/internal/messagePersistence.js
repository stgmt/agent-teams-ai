const fs = require('fs');
const { writeJsonFileSync } = require('./atomicFile.js');
const { assertValidGroupInboxRows } = require('./groupEnvelope.js');
const { withFileLockSync } = require('./fileLock.js');

// This module exclusively stores sentMessages.json and inboxes/*.json arrays.
// Config/task JSON uses its own stores and does not pass this boundary.
function readMessageRows(filePath) {
  try {
    const raw = fs.readFileSync(filePath);
    const rows = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw));
    assertValidGroupInboxRows(rows);
    return rows;
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

function writeMessageRows(filePath, rows, newGroupMessage = false) {
  assertValidGroupInboxRows(rows);
  if (
    newGroupMessage &&
    Buffer.byteLength(JSON.stringify(rows, null, 2), 'utf8') > 10 * 1024 * 1024
  ) {
    throw new Error('Inbox storage unavailable: size limit exceeded');
  }
  writeJsonFileSync(filePath, rows);
}

function appendRow(filePath, row) {
  return withFileLockSync(filePath, () => {
    const current = readMessageRows(filePath);
    const list = Array.isArray(current) ? current : [];
    list.push(row);
    writeMessageRows(filePath, list, !!row.groupChatId);
    return row;
  });
}

module.exports = { appendRow, readMessageRows, writeMessageRows };
