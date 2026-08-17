# Integrated-mode guidance for the calling client

The external model is the active reasoning model, but the calling client owns all tools and permissions.

The calling client must:

1. expose only tools appropriate to the current task and security policy;
2. validate and approve provider-generated arguments;
3. execute calls and return outputs with the original call IDs;
4. preserve provider reasoning fields required by subsequent tool turns;
5. bound call count, wall time, output, and cost;
6. stop on repeated calls, malformed arguments, or lack of progress;
7. keep responsibility for final verification and user-facing claims.

The bridge translates function calls. It does not execute them or grant permissions.
