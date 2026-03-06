# OpenDone Specification
**Version 0.5.0**

Open standard for machine-verifiable AI agent task completion.

---

## Overview

OpenDone defines five primitives that together make AI agent task completion auditable, portable, and tamper-evident.

A **Contract** defines what done means before the agent runs. An **Evaluate** pass produces a **Receipt** — a cryptographically hashed record of which criteria passed and which didn't. **Verify** confirms the receipt hasn't been tampered with. **Coram** records every agent action in a hash-chained witness log bound to the governing contract. **Umbra** sits between the agent and its tools, enforcing policy on every tool call before it executes.

Zero dependencies. MIT licensed. Works with any agent framework.

---

## Primitives

### 1. Contract

A machine-readable definition of the task, success criteria, and runtime constraints. Created before the agent runs.

```js
const contract = od.contract({
  task: 'Summarize Q1 earnings report',
  criteria: {
    required: ['summary'],
    conditions: [
      { field: 'confidence', op: '>=', value: 0.8 },
      { field: 'summary',    op: 'includes', value: 'revenue' }
    ]
  },
  constraints: {
    maxDurationMs: 30000,
    maxIterations: 10
  },
  expiresIn: 86400  // seconds
})
```

**Fields:**
- `contractId` — unique identifier
- `task` — human-readable task description
- `criteria.required` — output fields that must be present and non-empty
- `criteria.conditions` — deterministic conditions on output fields
- `constraints` — runtime limits enforced at evaluate time
- `expiresIn` / `expiresAt` — contract validity window
- `hash` — SHA-256 of the contract contents
- `signature` — optional RSA signature (via `od.sign()`)
- `specVersion` — `"0.5.0"`

**Supported operators:** `===`, `!==`, `>`, `>=`, `<`, `<=`, `includes`, `matches`, `exists`, `typeof`

All operators are deterministic. No LLM evaluation. Same input always produces the same verdict.

**Security:** Contract objects are deeply frozen at creation. Fields cannot be mutated post-signing.

---

### 2. Evaluate

Runs the agent's output against the contract. Produces a Receipt.

```js
const receipt = od.evaluate({
  contract,
  output: {
    summary: 'Q1 revenue up 12% YoY...',
    confidence: 0.94
  },
  agent: 'summarizer-v2',
  runtime: {
    durationMs: 4200,
    iterations: 3
  }
})
```

**Receipt fields:**
- `receiptId` — unique identifier
- `contractId` / `contractHash` — binding to the governing contract
- `status` — `passed` | `partial` | `failed` | `expired`
- `score` — 0–1, ratio of criteria passed
- `verifiedCriteria` — list of passing criteria
- `violations` — list of failing criteria with reasons
- `hash` — SHA-256 of the receipt contents
- `signature` — optional RSA signature

**Notes:**
- If `runtime` is omitted and the contract defines `maxDurationMs` or `maxIterations`, those are recorded as constraint violations.
- `required` fields must be non-null and non-blank (whitespace-only fails).
- Numeric operators (`>`, `>=`, `<`, `<=`) require the actual value to be `typeof === 'number'`.
- Unknown operators fail closed (violation, not pass).
- The `matches` operator validates regex patterns for safety before execution.

---

### 3. Verify

Deterministic verification of a receipt's integrity.

```js
const result = od.verify(receipt)
// { valid: true, status: 'passed', score: 0.94 }

// With signature verification
const result = od.verify(receipt, publicKey)
```

Verify recomputes the receipt hash from its fields and compares it to the stored hash. Any field-level tampering — including status, score, violations, or contractHash — is detected.

Signature verification is optional. An unsigned receipt can still be hash-verified. A signed receipt guarantees authorship in addition to integrity.

---

### 4. Coram

An append-only, hash-chained witness record of every agent action, bound to the governing contract. Written by infrastructure. The agent never sees it.

```js
const coram = od.openCoram({ contract, agentId: 'agent-001' })

od.appendEntry(coram, {
  action: 'tool.call',
  tool:   'web_search',
  input:  { query: 'Q1 earnings AAPL' },
  result: { ... }
})

// Verify the chain is intact
od.verifyCoram(coram, receipt)
```

Each entry includes:
- `index` — position in the chain
- `action`, `tool`, `input`, `result`, `source`, `timestamp`
- `prevHash` — hash of the previous entry
- `hash` — SHA-256 of this entry's fields

**Chain verification** recomputes the genesis hash from `coramId`, `contractId`, and `startedAt`, then walks every entry confirming hash integrity and chain links. Swapping `coramId` or reordering entries is detected.

**Loop detection** is available via `coram.detectLoop(threshold)`.

---

### 5. Umbra

The enforcement layer. Sits between the agent and its tools. Checks every tool call against policy before it executes. The agent never sees it.

```js
const umbra = od.openUmbra({
  contract,
  coram,
  preset: 'sensitive',        // explore | operate | sensitive | custom
  overrides: {
    loopThreshold: 2,
    onLoop: 'realign',        // realign | compress | pause | throw
    onHumanApproval: async (violation) => { ... },
    blocklist: ['exec_shell', 'send_email_external']
  }
})

// Before every tool call:
await umbra.check({ tool: 'web_search', input: { query: '...' } })
// throws UmbraViolationError on policy breach (enforce mode)
// returns warning object (warn mode)
// logs and passes (audit mode)
```

**Three modes:**

| Mode | Behavior |
|---|---|
| `enforce` | Throws `UmbraViolationError` on violation — hard stop |
| `warn` | Returns warning object, continues — operator decides |
| `audit` | Post-hoc only — logs everything, blocks nothing |

**Preset tiers:**

| Preset | Mode | Loop threshold |
|---|---|---|
| `explore` | warn | 5 |
| `operate` | enforce | 3 |
| `sensitive` | enforce | 2 |

**Policy checks (in order):**
1. Allowlist — if set, tool must be in the list
2. Blocklist — tool must not be in the list
3. Contract scope — if `contract.allowedTools` is defined, tool must be in scope

**Loop enforcement:** Loop threshold always throws (or triggers corrective action) regardless of mode. A stuck agent is a factual determination, not a policy one.

**Corrective action stack (`onLoop`):**

| Action | Behavior |
|---|---|
| `realign` | Injects goal realignment directive from contract |
| `compress` | Injects Coram digest — tools tried, constraints remaining |
| `pause` | Calls `onHumanApproval` — human in the loop |
| `throw` | Throws `UmbraLoopError` — agent halted |

**Coram integration:** Every passing tool call is automatically appended to Coram. Blocked calls are never logged.

**Tool name normalization:** All tool names are normalized before comparison — lowercased, trimmed, zero-width characters stripped, NFC normalized. Prevents case variation and whitespace bypass attacks.

---

## Signing

```js
const { publicKey, privateKey } = od.generateKeyPair()

// Sign contract
const signedContract = od.sign(contract, privateKey)

// Sign receipt (pass privateKey to evaluate)
const receipt = od.evaluate({ contract: signedContract, output, agent, privateKey })

// Verify signature
od.verify(receipt, publicKey)
```

---

## Complete flow

```
Contract (define done)
    ↓
Coram (open witness record)     Umbra (open enforcement layer)
    ↓                               ↓
    ←──────── agent tool calls ─────→
    ↓  (Umbra checks each call)     ↓
    ↓  (passing calls → Coram)      ↓
Evaluate (agent output vs contract)
    ↓
Receipt (tamper-evident verdict)
    ↓
Verify (anyone, anywhere, no dependencies)
```

---

## Security model

- Receipts are hash-verified. Any field-level tampering is detected.
- Signed receipts additionally verify authorship.
- The `_sha256` function is internal — not exported. Receipts cannot be forged by recomputing the hash externally.
- Contract objects are deeply frozen at creation. Post-creation mutation is blocked.
- Coram chains are verified end-to-end including genesis hash. CoramId swaps are detected.
- Umbra tool names are normalized before comparison. String manipulation bypass attempts are blocked.
- The `matches` operator rejects dangerous regex patterns to prevent ReDoS.

---

## What a valid receipt proves

A passed receipt with a valid hash confirms:
- The output was evaluated against the stated contract
- The specific criteria listed in `verifiedCriteria` passed
- The receipt has not been modified since evaluation

A signed receipt additionally proves the receipt was produced by the holder of the corresponding private key.

**What it does not prove:**
- That the agent actually did what it claimed
- That the output is factually correct
- That tools were used appropriately (Coram + Umbra provide this layer)

---

*OpenDone v0.5.0 — MIT License — github.com/AgenticEdgeX/opendone*
