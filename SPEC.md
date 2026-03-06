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
      { field: 'confidence', operator: '>=', value: 0.8 },
      { field: 'summary',    operator: 'includes', value: 'revenue' }
    ]
  },
  constraints: {
    maxDurationMs: 30000,
    maxIterations: 10
  },
  expiresIn: 86400  // seconds
})
```

**Fields on the returned contract object:**
- `contractId` — unique identifier (`od_c_...`)
- `version` — `'0.4.0'`
- `task` — human-readable task description
- `criteria.required` — output fields that must be present and non-empty
- `criteria.conditions` — deterministic conditions on output fields
- `constraints` — runtime limits enforced at evaluate time
- `expiresIn` / `expiresAt` — contract validity window
- `hash` — SHA-256 of the contract contents
- `signature` — optional RSA signature (via `od.sign()`)

**Supported operators:** `===`, `!==`, `>`, `>=`, `<`, `<=`, `includes`, `startsWith`, `endsWith`, `matches`, `typeof`, `in`

**Note:** Use `operator` not `op` — `op` throws `INVALID_CONTRACT`.

All operators are deterministic. No LLM evaluation. Same input always produces the same verdict.

**Security:** Contract `criteria` and `constraints` are deeply frozen at creation. Fields cannot be mutated post-creation.

---

### 2. Evaluate

Runs the agent's output against the contract. Produces a Receipt.

```js
const receipt = od.evaluate({
  contract,
  output: {
    summary:    'Q1 revenue up 12% YoY...',
    confidence: 0.94
  },
  agent:   'summarizer-v2',
  runtime: { durationMs: 4200, iterations: 3 },
  coram,       // optional — attaches coram fields to receipt
  privateKey,  // optional — signs the receipt
  store        // optional — persists receipt (use od.fileStore(path))
})
```

**Receipt fields:**
- `receiptId` — unique identifier (`od_r_...`)
- `version` — `'0.4.0'`
- `contractId` / `contractHash` — binding to the governing contract
- `task` / `agent` / `issuedAt`
- `passed` — boolean (`true` or `false`) — not a status string
- `criteriaResults` — `[{ type, field, operator, passed, reason }]`
- `constraintResults` — `[{ type, constraint, passed, limit, actual, reason }]`
- `runtime` / `output`
- `coramHash` / `coramEntryCount` / `coramStatus` — present when coram passed
- `signature` — present when privateKey passed
- `hash` — SHA-256 of the receipt

**Notes:**
- `passed` is a boolean. There is no `status`, `score`, or `violations` field.
- If `runtime` is omitted and the contract defines constraints, those are recorded as constraint violations and `passed` will be `false`.
- `required` fields must be non-null and non-blank (whitespace-only fails).
- Numeric operators (`>`, `>=`, `<`, `<=`) require the actual value to be `typeof === 'number'`. String `'0.9'` does not pass `> 0.8`.
- Unknown operators throw `INVALID_CONTRACT` at contract creation time.
- The `matches` operator validates regex patterns for ReDoS safety before execution.

---

### 3. Verify

Deterministic verification of a receipt's integrity.

```js
const result = od.verify(receipt)
// { valid: true }

// With signature verification
const result = od.verify(receipt, publicKey)
// { valid: true } or { valid: false, reason: '...' }
```

Verify recomputes the receipt hash from its fields and compares it to the stored hash. Any field-level tampering — including `passed`, `criteriaResults`, `constraintResults`, or `contractHash` — is detected.

Signature verification is optional. An unsigned receipt can still be hash-verified. A signed receipt guarantees authorship in addition to integrity.

---

### 4. Coram

An append-only, hash-chained witness record of every agent action, bound to the governing contract.

```js
const coram = od.openCoram({
  contract,
  agentId: 'agent-001',
  mode: 'hashed'     // 'hashed' (default) | 'inline' | 'redacted'
})

od.appendEntry(coram, {
  action: 'tool.call',
  tool:   'web_search',
  input:  { query: 'Q1 earnings AAPL' },
  result: { hits: 3 }
})

od.closeCoram(coram)

const result = od.verifyCoram(coram, receipt)
// { valid: true, loopWarnings: [], detail: { entryCount: 1 } }
```

**Coram record fields:**
- `coramId` — unique identifier (`od_coram_...`)
- `coramVersion` — `'0.1.0'`
- `contractId` / `contractHash` — binding to governing contract
- `agentId` / `mode` / `startedAt` / `closedAt`
- `status` — `'open'` | `'closed'`
- `entryCount` — number of entries
- `entries` — array of entry objects
- `finalHash` — hash of the last entry (or contractHash if empty)

**Entry fields:**
- `entryId` — sequential integer (1-based)
- `timestamp` / `action` / `status`
- `inputHash` / `resultHash` — SHA-256 of input/result (hashed mode)
- `inputInline` / `resultInline` — raw values (inline mode)
- `loopWarning` — boolean, true when this action+input has been seen before
- `loopCount` — how many times this action+input has occurred (1-based)
- `previousHash` — hash of the previous entry (first entry anchors to contractHash)
- `entryHash` — SHA-256 of this entry's fields

**Payload modes:**
- `hashed` — input and result are SHA-256 hashed. Proves what was passed without exposing it.
- `inline` — raw input and result stored. Full auditability, higher storage cost.
- `redacted` — no payload stored. Action and timestamp only.

**Loop detection** is automatic. `loopWarning` is set on any entry where the same `action` + `input` combination has appeared before. `loopCount` increments with each repeat.

**Chain verification** walks every entry, recomputing each `entryHash` and confirming `previousHash` links. The first entry must anchor to `contractHash`. Any tampering — reordering, deletion, or field mutation — is detected.

---

### 5. Umbra

The enforcement layer. Sits between the agent and its tools. Checks every tool call against policy before it executes.

```js
const { openUmbra, UmbraViolationError, UmbraLoopError } = require('./umbra')

const umbra = openUmbra({
  contract,
  coram,
  preset: 'operate',        // explore | operate | sensitive
  overrides: {
    loopThreshold: 2,
    onLoop: 'realign',      // realign | compress | pause | throw
    blocklist: ['exec_shell', 'send_email_external'],
    allowlist: ['web_search', 'read_file', 'write_file'],
    onHumanApproval: async (event) => true
  }
})

// Before every tool call:
await umbra.check({ tool: 'web_search', input: { query: '...' } })
// throws UmbraViolationError on policy breach (enforce mode)
// returns warning object (warn mode)
// logs and passes (audit mode)

const summary = umbra.close()
// { closedAt, totalChecks, violations }
// violations is an integer count of policy violations recorded during this session
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

**Loop enforcement:** Loop threshold always triggers `onLoop` regardless of mode. A stuck agent is a factual determination, not a policy one.

**Corrective action stack (`onLoop`):**

| Action | Behavior |
|---|---|
| `realign` | Returns goal realignment directive from contract |
| `compress` | Returns Coram digest — tools tried, constraints remaining |
| `pause` | Calls `onHumanApproval` — human in the loop |
| `throw` | Throws `UmbraLoopError` — agent halted |

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
const result = od.verify(receipt, publicKey)
// { valid: true } or { valid: false, reason: '...' }
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
    ↓  (append entries to Coram)    ↓
Evaluate (agent output vs contract, coram passed in)
    ↓
Receipt (tamper-evident verdict with coramHash bound)
    ↓
Verify (anyone, anywhere, no dependencies)
verifyCoram (chain integrity + receipt cross-check)
```

---

## Security model

- Receipts are SHA-256 hashed. Any field-level tampering is detected by `verify()`.
- Signed receipts additionally verify authorship via RSA.
- `canonicalHash` is internal — not exported. Receipts cannot be forged by recomputing the hash externally.
- Contract `criteria` and `constraints` are deeply frozen at creation. Post-creation mutation throws in strict mode.
- Coram chains are verified end-to-end. First entry anchors to `contractHash`. Reordering or deletion is detected.
- `verifyCoram(coram, receipt)` cross-checks `coramHash`, `coramId`, and `coramEntryCount` — binding the witness log to the receipt.
- Umbra tool names are normalized before comparison. Unicode and whitespace bypass attempts are blocked.
- The `matches` operator rejects dangerous regex patterns to prevent ReDoS.
- Numeric operators require `typeof === 'number'`. String coercion (`'0.9' > 0.8`) is blocked.
- Missing `runtime` when constraints are defined is treated as a constraint violation — not a pass.

---

## What a valid receipt proves

A receipt with `passed: true` and `verify().valid === true` confirms:
- The output was evaluated against the stated contract at `issuedAt`
- Every criterion in `criteriaResults` was checked and passed
- The receipt has not been modified since evaluation

A signed receipt additionally proves the receipt was produced by the holder of the corresponding private key.

**What it does not prove:**
- That the agent actually did what it claimed
- That the output is factually correct
- That tools were used appropriately (Coram + Umbra provide this layer)

---

*OpenDone v0.5.0 — MIT License — github.com/AgenticEdgeX/opendone*
