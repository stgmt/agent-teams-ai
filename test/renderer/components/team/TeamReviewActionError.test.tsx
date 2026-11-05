import { renderToStaticMarkup } from 'react-dom/server';

import en from '@features/localization/renderer/locales/en/team.json';
import ru from '@features/localization/renderer/locales/ru/team.json';
import { TeamReviewActionError } from '@renderer/components/team/TeamReviewActionError';
import { describe, expect, it, vi } from 'vitest';

const translations = vi.hoisted(() => ({ messages: {} as Record<string, string> }));
vi.mock('@features/localization/renderer', () => ({
  useAppTranslation: () => ({ t: (key: string) => translations.messages[key] }),
}));

describe('TeamReviewActionError', () => {
  it.each([en, ru])('explains missing and invalid artifacts in the selected language', (locale) => {
    translations.messages = {
      'artifact.actionMissing': locale.artifact.actionMissing,
      'artifact.actionInvalid': locale.artifact.actionInvalid,
    };
    const missing = renderToStaticMarkup(
      <TeamReviewActionError error="A required task artifact has not been attached; use task_set_artifact_file" />
    );
    expect(missing).toContain('role="alert"');
    expect(missing).toContain(locale.artifact.actionMissing);
    expect(missing).not.toContain('task_set_artifact_file');
    const invalid = renderToStaticMarkup(
      <TeamReviewActionError error="Required task artifact cannot be verified: checksum changed" />
    );
    expect(invalid).toContain(locale.artifact.actionInvalid);
    expect(invalid).not.toContain('checksum changed');
  });

  it('keeps other error messages and renders nothing when cleared', () => {
    expect(renderToStaticMarkup(<TeamReviewActionError error="Review failed" />)).toContain(
      'Review failed'
    );
    expect(renderToStaticMarkup(<TeamReviewActionError error={null} />)).toBe('');
  });
});
