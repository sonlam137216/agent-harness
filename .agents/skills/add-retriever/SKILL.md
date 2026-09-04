---
name: add-retriever
description: Add a code or knowledge retriever such as GitNexus, AST graph, symbol index, lexical search, or semantic search for token-efficient context selection.
---

# Add Retriever

## Boundary rule

Retrievers select information.

They do not mutate the workspace.

```text
Task
→ Retriever
→ Candidates
→ ContextBuilder
→ Model
```

## Suitable systems

- GitNexus
- AST index
- symbol graph
- dependency graph
- lexical search
- semantic search
- repository summarizer

## Workflow

1. Define the retrieval question the component answers.
2. Define a provider-neutral `Retriever` result shape.
3. Implement adapter-specific logic behind that abstraction.
4. Return:
   - source identifier
   - relevance score
   - content/reference
   - estimated token size
   - optional relationships/metadata
5. Integrate with ContextBuilder, not AgentLoop.
6. Apply context-budget limits.
7. Add tracing:
   - retriever
   - candidates
   - selected items
   - selected tokens
   - latency
   - cache hit/miss
8. Compare against the baseline number of file reads/input tokens if possible.

Do not automatically inject the entire retrieval index into context.
