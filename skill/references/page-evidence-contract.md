# Page evidence contract

Treat the canonical snapshot/projection as **page evidence, not merely as a
source of `@eN` refs**. Consume fields that already exist in the current
projection before escalating to another retrieval path.

- visible content / labels -> `name`, visible text, `value`
- destination / navigation target -> `href`
- element semantics -> `role`
- spatial position / hierarchy -> `rect`, `region`, parent/depth
- interactability / obstruction -> `states`, `layer`
- semantic relationships -> `relations` (controls / popup / labelledby /
  describedby / owns)
- frame / context boundary -> `frameId`, `contextScopeId`
- list coverage -> `completeness`, virtualized-list evidence

If the current projection already contains the fact needed to answer or act,
use that evidence directly. Retrieve only the missing detail: targeted
Wiki/current/retrieve/delta first, then one fresh `bsk snapshot --json
--quiet` after a meaningful page-state change, then bounded fallback. **Do
not full-observe merely to recover a field already present in the current
projection.**

For page-understanding questions, select evidence by the user's question
rather than by habit:

- "what does it say?" -> content fields
- "where does it go?" -> `href`
- "what kind of control is it?" -> `role`
- "where is it?" -> `rect` / `region` / hierarchy
- "can I interact with it now?" -> `states` / `layer`
- "what is it related to?" -> `relations`
- "which frame/context?" -> `frameId` / `contextScopeId`
- "did we read the whole list?" -> `completeness` / virtualization evidence

Canonical identity remains independent of `@eN`; refs are ephemeral handles,
not durable identity. This contract adds no second identity system, no new
retrieval authority, and never forces a full observe.
