const { withTeamBoardLock } = require('./boardLock.js');
const { listAgendaItems } = require('./agenda.js');
const taskStore = require('./taskStore.js');

// Uses the board's own reader and transaction. An unreadable task is not an empty board.
function readLeadReportFacts(context) {
  return withTeamBoardLock(context.paths, () => {
    const scan = taskStore.listTaskRows(context.paths);
    if (scan.anomalies.length)
      throw new Error('Lead report task source has unreadable or ambiguous rows');
    return listAgendaItems(context.paths, context.teamName).items;
  });
}

module.exports = { readLeadReportFacts };
