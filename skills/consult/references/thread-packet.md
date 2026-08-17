# Building a compact consultation packet

## Debugging example

**Question**

What race can explain a duplicate agent plus a leaked process when two first requests arrive for one thread, and what is the smallest correct lifecycle fix?

**Current state**

The provider cache is keyed by thread/model/workspace. Each miss asynchronously creates an agent and stores it after creation. Per-agent sends are locked, but creation is outside that lock.

**Evidence**

- Two simultaneous requests both observe a cache miss.
- Both call `Agent.create`.
- The second stored entry replaces the first.
- Only the stored agent is later disposed.
- Serial single-request tests pass.

**Constraints**

- Unrelated keys must remain concurrent.
- Cancellation of one waiter must not cancel creation needed by another.
- Provider shutdown must await in-flight creations.

**Artifacts**

Include only cache/acquire/close methods and the failing concurrency test.

**Requested answer**

Identify invariants, propose a minimal algorithm, and list race-focused tests.

## Architecture example

**Question**

Should this provider be Integrated or Delegate, given that its public SDK creates an agent with its own tools and streams run events but does not expose raw chat/function-calling inference?

**Current view**

Delegate seems semantically correct. Calling it Integrated would misrepresent tool ownership.

**Constraints**

- Mode labels must predict permissions and responsibility.
- The client must not believe it owns tool approvals when it does not.
- A future raw endpoint should fit without breaking routes.

**Requested answer**

Challenge the classification and identify any hybrid mode actually needed.

## Poor packet

> Look at everything we discussed and tell me what you think.

Problems:

- implicit references;
- no exact decision;
- no evidence/constraints;
- forces expensive context reconstruction;
- likely produces generic advice.
