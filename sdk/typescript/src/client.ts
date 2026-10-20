// @seele/memory-client — Phase 1 stub.
// Real client ships in TASK-096. See SPEC.md "Repo layout / sdk/typescript".

export class SeeleMemory {
  // Placeholder — fills in once TASK-093 + 096 land.
  constructor(opts: { userToken: string; botId: string }) {
    this.opts = opts;
  }

  async recall(_sessionId: string, _query: string): Promise<string> {
    throw new Error("@seele/memory-client not yet implemented (TASK-096)");
  }

  private opts: { userToken: string; botId: string };
}
