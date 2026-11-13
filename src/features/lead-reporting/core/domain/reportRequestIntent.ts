import type { LeadReportScope } from '../../contracts';

const NON_REPORT_REQUESTS = [
  /(?:не (?:нужен|надо|делай|давай)|без)\s+отч[её]т/u,
  /status\s+code|статус\s+\d|progress\s+bar/u,
  /код\w*\s+(?:отч[её]т|статус)|что (?:значит|означает)\s+статус/u,
  /^(?:объясни|explain)\s+(?:код|что\s+значит|как\s+работает)/u,
  /что\s+такое|what\s+does/u,
  /как тебя зовут|кто ты|что ты (?:умеешь|можешь)|what is your name|who are you/u,
  /как\s+(?:сделать|починить|запустить|настроить|исправить|fix|build|run|install)/u,
];
const REPORT_INQUIRIES = [
  /как там дела|как дела|ч[её] у подчин[её]н/u,
  /что\s+(?:сделал\w*|дела[ею]\w*|нового|происходит|случилось)/u,
  /статус|отч[её]т|прогресс|результат|новост|движени|апдейт/u,
  /\b(?:progress|status|doing|update|news)\b/u,
];
// Split by script only to keep each pattern below the complexity ceiling; the union is
// unchanged. Trailing punctuation is allowed on every social turn.
const SOCIAL_ONLY = [
  /^(?:спасибо|благодарю|привет|здравствуй(?:те)?|ок|окей|хорошо|поняла?|да|нет|ага|угу)[\s!.,…]*$/u,
  /^(?:thanks|thank you|hi|hello|ok|okay)[\s!.,…]*$/u,
];
const QUESTION_WORDS = new Set([
  'что',
  'как',
  'где',
  'когда',
  'почему',
  'зачем',
  'кто',
  'сколько',
  'какой',
  'какая',
  'какие',
  'каких',
  'what',
  'how',
  'why',
  'when',
  'who',
  'which',
]);
// Unanchored: `team` already matches "teammate", so no separate alternative is needed.
const TEAM_CONTEXT =
  /команд|тимлид|подчин|исполнител|продукт|проект|работ|задач|доск|релиз|фич|баг|team|project|product|task|board|sprint|release|feature|bug/u;

/**
 * A substantive question is treated as a status request unless it is an explicit
 * non-report request or a purely social turn. This intentionally biases toward an
 * inspection: the owner's complaint was an uninspected answer, not an extra read.
 */
export function reportScopeForHumanRequest(
  text: string,
  members: readonly string[]
): LeadReportScope | null {
  const words = text.toLowerCase().normalize('NFKC').replace(/\s+/gu, ' ').trim();
  if (!words || NON_REPORT_REQUESTS.some((pattern) => pattern.test(words))) return null;
  const tokens = new Set(words.split(/[^\p{L}\p{N}_-]+/u).filter(Boolean));
  const asks = /[?？]/u.test(words) || [...tokens].some((token) => QUESTION_WORDS.has(token));
  const report =
    REPORT_INQUIRIES.some((pattern) => pattern.test(words)) ||
    (asks && TEAM_CONTEXT.test(words) && !SOCIAL_ONLY.some((pattern) => pattern.test(words)));
  if (!report) return null;
  const named = members.filter((name) => tokens.has(name.toLowerCase().normalize('NFKC')));
  const wholeTeam = /команд|подчин[её]н|исполнител|teammate|\bteam\b/u.test(words);
  return named.length && !wholeTeam
    ? { kind: 'members', memberNames: [...new Set(named)].sort((a, b) => a.localeCompare(b)) }
    : { kind: 'team' };
}
