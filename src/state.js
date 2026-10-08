// Shared runtime state between the bot and the web panel (single process).
export const state = {
  startedAt: Date.now(),
  bot: {
    status: 'starting', // starting | online | disabled | error | conflict
    username: null,
    firstName: null, // display name, so being addressed by it counts as a mention
    lastError: null,
    // When a single message last took absurdly long to handle. A quiet bot
    // with this set recently is a performance fault, not a connection one.
    lastSlowAt: null,
    lastUpdateAt: null,
    groupMessagesSeen: 0, // stays 0 with privacy mode on → setup hint
  },
};
