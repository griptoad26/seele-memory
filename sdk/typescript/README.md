# @seele/memory-client

TypeScript SDK for `seele.agency` recall API.

**Status:** stub-only in v0.10.0 phase 1. Real implementation in TASK-096.

When shipped:

```ts
import { SeeleMemory } from "@seele/memory-client";
const mem = new SeeleMemory({ userToken, botId: "claude" });
const ctx = await mem.recall(sessionId, "what did I decide about X?");
```

See `../../SPEC.md` for the contract.
