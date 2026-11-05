// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { reportScopeForHumanRequest } from '../../../src/features/lead-reporting/core/domain/reportRequestIntent';
import {
  buildLeadReportContextRefresh,
  buildLeadReportRequestInstruction,
} from '../../../src/features/lead-reporting/main';

const members = ['worker', 'reviewer'];
describe('owner request versus application context refresh', () => {
  it.each([
    'как там дела?',
    'че у подчиненных?',
    'что сделали исполнители?',
    'покажи статус команды',
    'дай отчёт по работе команды',
    'Any progress from the team?',
    'How are the teammates doing?',
  ])('routes an actual status question to a whole-roster inspection: %s', (text) => {
    expect(reportScopeForHumanRequest(text, members)).toEqual({ kind: 'team' });
  });

  it.each(['что сделал worker?', 'статус worker', 'Show progress for worker'])(
    'makes a named report explicitly narrow: %s',
    (text) => {
      expect(reportScopeForHumanRequest(text, members)).toEqual({
        kind: 'members',
        memberNames: ['worker'],
      });
    }
  );

  it.each([
    'спасибо',
    'что означает статус 429?',
    'объясни код отчёта',
    'не нужен отчёт, исправь кнопку',
    'what does status code 500 mean?',
    'implement the progress bar',
  ])('does not force ordinary conversation through team inspection: %s', (text) => {
    expect(reportScopeForHumanRequest(text, members)).toBeNull();
  });

  it('preserves report identity after compaction and does not create a new user status request', () => {
    const report = {
      reportRunId: 'test-operation',
      requestMessageId: 'test-human-message',
      scope: { kind: 'team' as const },
      run: {
        appInstanceId: 'test-app',
        dataRootFingerprint: 'test-root',
        connectionGeneration: 1,
        teamName: 'test-team',
        runId: 'test-run',
      },
    };
    const context = buildLeadReportContextRefresh(report);
    expect(context).toMatchObject({ type: 'user', isMeta: true, origin: { kind: 'coordinator' } });
    expect(context.message.content[0].text).toContain('test-human-message');
    expect(context.message.content[0].text).toContain('test-operation');
    expect(context.message.content[0].text).not.toContain('Only report board readiness');
    expect(buildLeadReportRequestInstruction(report)).toContain('lead_briefing');
    const noRequest = buildLeadReportContextRefresh(null);
    expect(noRequest.message.content[0].text).toContain('No pending human report request');
    expect(noRequest.message.content[0].text).not.toContain('Reply with one concise');
  });
});
