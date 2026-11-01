const binding = require('./desktopControlBinding.js');
const credential = process.env.AGENT_TEAMS_LEAD_START_CREDENTIAL;

// One app-owned delivery boundary. No filesystem write after a control API error.
async function leadReportingRequest(context, operation, body) {
  const urls = binding.boundControlBaseUrls(context);
  if (!urls || urls.length !== 1 || !credential || credential.length > 256) {
    throw new Error('Bound lead reporting context is required');
  }
  const baseUrl = urls[0];
  const options = binding.boundRequestOptions(baseUrl);
  const response = await fetch(`${baseUrl}/api/lead-reporting/${operation}`, {
    ...options,
    method: 'POST',
    headers: {
      ...options.headers,
      'content-type': 'application/json',
      authorization: `Bearer ${credential}`,
    },
    signal: AbortSignal.timeout(15_000),
    body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) {
    throw new Error(
      typeof result?.error === 'string'
        ? result.error
        : `Lead reporting rejected (${response.status})`
    );
  }
  return result;
}

function inspectLeadReport(context) {
  return leadReportingRequest(context, 'inspect', {});
}

function publishLeadReport(context, draft) {
  return leadReportingRequest(context, 'publish', draft);
}

function replyToHumanRequest(context, requestMessageId, text) {
  return leadReportingRequest(context, 'reply', { requestMessageId, text });
}

function requiresLeadReporting() {
  return credential !== undefined;
}

module.exports = {
  inspectLeadReport,
  publishLeadReport,
  replyToHumanRequest,
  requiresLeadReporting,
};
