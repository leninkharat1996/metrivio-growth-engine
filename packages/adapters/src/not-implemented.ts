/**
 * Thrown by every Stage 1 adapter stub method. Stage 1 explicitly defines
 * adapter *boundaries* (interfaces + wiring) without production API/browser
 * automation (per instruction: "do not yet implement production API/browser
 * automation" / "do not implement actual outbound automation yet"). Throwing
 * a clear, distinct error type — rather than returning fabricated mock data —
 * means nothing downstream can mistake a stub for a working integration.
 */
export class NotImplementedInStage1Error extends Error {
  constructor(adapterName: string, method: string) {
    super(
      `${adapterName}.${method}() is a Stage 1 boundary stub only. Real API/browser-automation ` +
        'integration is Stage 2 work (BUILD_PLAN.md). This error means the code path is wired ' +
        'correctly but not yet backed by a live implementation.'
    );
    this.name = 'NotImplementedInStage1Error';
  }
}

/**
 * Thrown by the `XActionsReadAdapter` methods Stage 4A deliberately does not
 * implement yet (`getFollowers`, `getFollowing`, `getTweets`,
 * `getListMembers`, `getEngagers`). Stage 4A's scope is the read-only
 * foundation (`getProfile`, `searchTweets`) only — discovery orchestration,
 * which is what the remaining methods exist for, is explicitly out of scope
 * per this stage's instructions ("Do not build the discovery orchestration
 * yet"). Distinct from `NotImplementedInStage1Error` because this class's
 * two implemented methods are real, live implementations, not stubs — this
 * error describes methods not yet reached, not a whole adapter that's a
 * placeholder.
 */
export class NotImplementedInStage4AError extends Error {
  constructor(adapterName: string, method: string) {
    super(
      `${adapterName}.${method}() is not implemented in Stage 4A. Only getProfile() and ` +
        'searchTweets() are built this stage (the XActions read-only foundation); ' +
        'getFollowers/getFollowing/getTweets/getListMembers/getEngagers are discovery-orchestration ' +
        'concerns deferred to a later stage.'
    );
    this.name = 'NotImplementedInStage4AError';
  }
}
