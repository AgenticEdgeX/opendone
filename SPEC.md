# OpenDone Specification v0.3.0

**A portable standard for machine-verifiable AI agent task completion.**

---

## The Problem

When you delegate a task to an AI agent, there is currently no standard way to express what "done" means, no deterministic way to evaluate whether the agent achieved it, and no tamper-evident proof that the work was completed correctly.

Every agent platform solves this differently. Most don't solve it at all.

The result: agents self-report completion, humans manually review output, and there is no portable, auditable record that the task met its stated criteria.

---

## What OpenDone Does

OpenDone defines three primitives:

1. **Contract** — a machine-readable definition of what "done" means, written before the agent starts
2. **Receipt** — a tamper-evident, signed record of what happened and whether criteria were met
3. **Verify** — deterministic evaluation: same contract + same output = same verdict, every time

OpenDone does **not** define how agents execute tasks, which LLM to use, how agents communicate, or how to rate agent quality. It defines only the completion layer.

---

## What OpenDone Does NOT Do

- It is not an agent framework or orchestration layer
- It is not an observability or tracing platform
- It is not an agent identity system (though receipts can be signed by any identity scheme)
- It is not a quality evaluation system (it evaluates deterministic criteria, not subjective quality)
- It does not replace human review for high-stakes decisions

---

## Core Concepts

### The Contract

A contract is a JSON document that specifies:

- **task** — human-readable description of what the agent should accomplish
- **criteria** — machine-verifiable conditions the output must satisfy
- **constraints** — runtime boundaries the agent must operate within
- **expiresAt** — optional deadline after which the contract is invalid
- **hash** — SHA-256 of the canonical contract, for tamper detection
- **signature** — optional RSA signature binding the contract to its issuer

```json
{
  "contractId": "od_c_1748294000000_a1b2c3d4e5f6",
  "version": "0.3.0",
  "task": "Process all pending invoices and return confirmation",
  "agent": "invoice-processor-v2",
  "criteria": {
    "required": ["invoiceIds", "totalProcessed", "status"],
    "conditions": [
      { "field": "status",         "operator": "===", "value": "complete" },
      { "field": "totalProcessed", "operator": ">",   "value": 0 },
      { "field": "errors",         "operator": "===", "value": 0 }
    ]
  },
  "constraints": {
    "maxIterations":  50,
    "maxDurationMs":  30000,
    "maxCostUsd":     0.10,
    "checkpointEvery": 10
  },
  "createdAt": "2026-01-01T00:00:00.000Z",
  "expiresAt": "2026-01-01T01:00:00.000Z",
  "hash": "a3f1...",
  "signature": null
}
```

### The Receipt

A receipt is produced after evaluation. It is the proof of completion.

Two types exist:
- **Final receipt** — produced after the task completes, evaluates all criteria
- **Checkpoint receipt** — produced mid-execution, evaluates only constraints

```json
{
  "receiptId": "od_r_1748294000000_f6e5d4c3b2a1",
  "version": "0.3.0",
  "isCheckpoint": false,
  "checkpointIteration": null,
  "contractId": "od_c_1748294000000_a1b2c3d4e5f6",
  "contractHash": "a3f1...",
  "task": "Process all pending invoices and return confirmation",
  "agent": "invoice-processor-v2",
  "issuedAt": "2026-01-01T00:00:45.000Z",
  "passed": true,
  "criteriaResults": [
    { "type": "required",   "field": "invoiceIds",     "passed": true,  "reason": "Field 'invoiceIds' present" },
    { "type": "required",   "field": "totalProcessed", "passed": true,  "reason": "Field 'totalProcessed' present" },
    { "type": "required",   "field": "status",         "passed": true,  "reason": "Field 'status' present" },
    { "type": "condition",  "field": "status",         "passed": true,  "reason": "status === \"complete\" ✓ (got \"complete\")" },
    { "type": "condition",  "field": "totalProcessed", "passed": true,  "reason": "totalProcessed > 0 ✓ (got 12)" },
    { "type": "condition",  "field": "errors",         "passed": true,  "reason": "errors === 0 ✓ (got 0)" }
  ],
  "constraintResults": [
    { "type": "constraint", "constraint": "maxIterations", "passed": true, "limit": 50,    "actual": 23, "reason": "Iterations 23 ≤ limit 50" },
    { "type": "constraint", "constraint": "maxCostUsd",    "passed": true, "limit": 0.10,  "actual": 0.04, "reason": "Cost $0.04 ≤ limit $0.10" }
  ],
  "runtime": { "iterations": 23, "durationMs": 12400, "costUsd": 0.04 },
  "output": { "invoiceIds": ["INV-001", "INV-002"], "totalProcessed": 12, "status": "complete", "errors": 0 },
  "hash": "b7c2...",
  "signature": null
}
```

---

## Criteria Reference

### Required Fields

Asserts that a field exists and is non-null in the output.
Supports dot-notation for nested fields: `"config.auth.token"`

```json
{ "required": ["invoiceIds", "status", "config.auth.token"] }
```

### Conditions

Evaluates a field against a value using an operator.

| Operator     | Description                                 | Example value |
|-------------|---------------------------------------------|---------------|
| `>`         | Greater than                                | `0`           |
| `<`         | Less than                                   | `100`         |
| `>=`        | Greater than or equal                       | `1`           |
| `<=`        | Less than or equal                          | `60000`       |
| `===`       | Strict equality                             | `"complete"`  |
| `!==`       | Strict inequality                           | `"error"`     |
| `includes`  | String contains substring                   | `"@"`         |
| `startsWith`| String starts with prefix                   | `"INV-"`      |
| `endsWith`  | String ends with suffix                     | `".pdf"`      |
| `matches`   | String matches regular expression           | `"^[0-9]+$"`  |
| `typeof`    | JavaScript typeof check                     | `"string"`    |
| `in`        | Value exists in array                       | `["a","b","c"]`|

---

## Constraints Reference

Constraints govern the agent's execution, not just its output.

| Field            | Type    | Description                                           |
|-----------------|---------|-------------------------------------------------------|
| `maxIterations` | integer | Maximum agent loop iterations before breach           |
| `maxDurationMs` | integer | Maximum wall-clock time in milliseconds               |
| `maxCostUsd`    | number  | Maximum LLM API cost in US dollars                    |
| `checkpointEvery`| integer| Emit a checkpoint receipt every N iterations          |

When a checkpoint is emitted and constraints are breached, an `OpenDoneError` with code `CONSTRAINT_BREACH` is thrown. The caller is responsible for halting the agent.

---

## Verification

Receipt verification is deterministic and requires no external service.

1. Recompute the canonical SHA-256 hash from the receipt payload (excluding `hash` and `signature` fields)
2. Compare against the stored hash — mismatch = tampered
3. If a public key is provided, verify the RSA signature against the hash

A receipt is valid if and only if:
- The hash matches the recomputed hash
- If signed, the signature verifies against the provided public key

---

## Verification Tiers

OpenDone supports three levels of receipt trust, in ascending order:

| Tier | Method | Trust Level |
|------|--------|-------------|
| Self | Agent evaluates its own output | Low — self-grading |
| Independent | Separate process evaluates output | Medium — isolated verification |
| External | Trusted third-party service signs receipt | High — non-repudiable proof |

The `signature` field on a receipt carries the verifier's identity. An unsigned receipt is self-verified. A receipt signed by a key that is not the executing agent's key is independently verified.

---

## Hashing

All hashes use SHA-256 over a canonical JSON representation with:
- Keys sorted alphabetically at every nesting level
- No whitespace
- UTF-8 encoding

This ensures the same logical document produces the same hash regardless of key insertion order or JavaScript runtime.

---

## IDs

Contract IDs use prefix `od_c_`. Receipt IDs use prefix `od_r_`.
Format: `{prefix}_{unix_ms}_{6_random_bytes_hex}`

---

## Error Codes

| Code               | When thrown                                          |
|-------------------|------------------------------------------------------|
| `INVALID_CONTRACT`  | Contract is malformed or missing required fields    |
| `CONTRACT_EXPIRED`  | Contract's `expiresAt` is in the past               |
| `CONSTRAINT_BREACH` | Runtime stats exceed contract constraints at checkpoint — caller must halt agent |
| `TAMPER_DETECTED`   | Receipt hash does not match recomputed hash         |
| `SIGNATURE_INVALID` | Signature does not verify against provided key      |
| `EVALUATION_ERROR`  | Unexpected failure during criteria evaluation — catch and log, do not retry blindly |
| `STORE_ERROR`       | Storage adapter failed to persist receipt           |

---

## What OpenDone Explicitly Defers

The following are out of scope for this specification and are intentionally left to other standards:

- **Agent identity** — how agents are identified and authenticated (see SPIFFE, DID, AIP)
- **Inter-agent communication** — how agents call each other (see MCP, A2A)
- **LLM evaluation** — subjective quality scoring (see Braintrust, Arize, Galileo)
- **Signing key infrastructure** — certificate chains, revocation (see existing PKI standards)
- **Payment settlement** — releasing payment on completion (out of scope; receipts are the proof layer)

---

## Changelog

### v0.3.0
- Added `constraints` block to contracts (maxIterations, maxDurationMs, maxCostUsd, checkpointEvery)
- Added `checkpoint()` function for mid-execution receipts
- Added `CONSTRAINT_BREACH` error with structured detail
- All operators now documented and validated at contract creation time
- Canonical hashing (sorted keys) for cross-runtime determinism
- Atomic file writes in `fileStore` to prevent corruption on crash
- Dot-notation nested field access in criteria

### v0.2.0
- Separated contract from receipt
- Added three-tier verification model
- Added contract expiry
- Added RSA signing

### v0.1.0
- Initial specification
