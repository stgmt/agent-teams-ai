export const TEAM_UPDATE_MEMBER_SETTINGS = 'team:updateMemberSettings';

export const TEAM_LIFECYCLE_COMMAND_CHANNELS = {
  launch: 'team:lifecycle:launch',
  stop: 'team:lifecycle:stop',
  restartMember: 'team:lifecycle:restart-member',
  skipMember: 'team:lifecycle:skip-member',
} as const;

export const TEAM_LIFECYCLE_CHANNELS = {
  snapshot: 'team:lifecycle:snapshot',
  subscribe: 'team:lifecycle:subscribe',
  next: 'team:lifecycle:next',
  close: 'team:lifecycle:close',
} as const;
