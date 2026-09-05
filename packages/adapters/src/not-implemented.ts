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
