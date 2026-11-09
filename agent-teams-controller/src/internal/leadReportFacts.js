const { withTeamBoardReadLock } = require('./boardLock.js');
const { listAgendaItems } = require('./agenda.js');
const taskStore = require('./taskStore.js');

// An unreadable task is not an empty board; snapshot reads use only atomic Kanban state.
function readLeadReportFacts(context) {
  return withTeamBoardReadLock(context.paths, () => {
    const scan = taskStore.listTaskRows(context.paths);
    if (scan.anomalies.length)
      throw new Error('Lead report task source has unreadable or ambiguous rows');
    return listAgendaItems(context.paths, context.teamName).items;
  });
}

module.exports = { readLeadReportFacts };
