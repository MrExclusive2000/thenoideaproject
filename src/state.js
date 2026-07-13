// Shared runtime state between the bot and the web panel (single process).
export const state = {
  startedAt: Date.now(),
  bot: {
    status: 'starting', // starting | online | disabled | error | conflict
    username: null,
    lastError: null,
    lastUpdateAt: null,
    groupMessagesSeen: 0, // stays 0 with privacy mode on → setup hint
  },
};
