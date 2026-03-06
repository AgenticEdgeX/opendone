# OpenDone

**Open standard for machine-verifiable AI agent task completion.**

[![npm version](https://img.shields.io/npm/v/opendone.svg)](https://www.npmjs.com/package/opendone)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

---

There's no standard way to define what "done" means before an agent starts, and no portable proof it was met when it finishes.

OpenDone fixes that. You define success criteria in a machine-readable contract before the agent runs. When it finishes, you get a receipt — hashed, optionally signed — showing which criteria passed and which didn't. Every agent action is recorded in a tamper-evident witness log. Every tool call is checked against policy before it executes.

Zero dependencies. MIT licensed. Works with any agent framework.

---

## Install

```bash
npm install opendone
```

---

## Five primitives

| Primitive | What it does |
|---|---|
| **Contract** | Define what done means before the agent runs |
| **Evaluate** | Run output against the contract, produce a receipt |
| **Verify** | Confirm a receipt hasn't been tampered with |
| **Coram** | Hash-chained witness record of every agent action |
| **Umbra** | Enforcement layer — checks every tool call against policy |

---

## Quick start

```js
const od = require('opendone')
const { openUmbra } = require('./umbra')  // umbra.js ships with the package — require it directly

// 1. Define the task
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
  }
})

// 2. Open witness record + enforcement layer
const coram = od.openCoram({ contract, agentId: 'my-agent-v1' })
const umbra = openUmbra({
  contract,
  coram,
  preset: 'operate',
  overrides: {
    blocklist: ['send_email_external', 'exec_shell']
  }
})

// 3. Agent runs — Umbra checks every tool call before it executes
await umbra.check({ tool: 'web_search', input: { query: 'Q1 earnings' } })
await umbra.check({ tool: 'read_file',  input: { path: 'report.pdf' } })
// Blocked calls throw UmbraViolationError and are never logged to Coram

// 4. Log actions to Coram
od.appendEntry(coram, { action: 'tool.call', tool: 'web_search', input: { query: 'Q1 earnings' } })
od.appendEntry(coram, { action: 'tool.call', tool: 'read_file',  input: { path: 'report.pdf' } })

// 5. Evaluate agent output against the contract
const receipt = od.evaluate({
  contract,
  output: {
    summary:    'Q1 revenue up 12% YoY, driven by cloud segment growth.',
    confidence: 0.94
  },
  agent:   'my-agent-v1',
  runtime: { durationMs: 4200, iterations: 3 },
  coram                          // attaches coramHash, coramEntryCount, coramStatus to receipt
})

console.log(receipt.passed)      // true
console.log(receipt.coramHash)   // sha256 of the sealed witness log

// 6. Verify the receipt — anyone, anywhere, no dependencies
const result = od.verify(receipt)
console.log(result.valid)        // true

// 7. Verify the Coram chain is intact and bound to the receipt
const chainResult = od.verifyCoram(coram, receipt)
console.log(chainResult.valid)   // true
```

---

## Umbra modes

```js
const { openUmbra, UmbraViolationError, UmbraLoopError } = require('./umbra')  // umbra.js ships with the package — require it directly

const umbra = openUmbra({
  contract,
  coram,
  preset: 'sensitive',   // explore (warn) | operate (enforce) | sensitive (enforce)
  overrides: {
    loopThreshold: 2,
    onLoop: 'realign',   // realign | compress | pause | throw
    blocklist: ['exec_shell', 'modify_policy'],
    allowlist: ['web_search', 'read_file', 'write_file'],
  }
})

await umbra.check({ tool: 'web_search', input: { query: '...' } })
// passes  → allowed
// blocked → throws UmbraViolationError
// loop    → triggers onLoop action (realign | compress | pause | throw)
```

---

## Signing

```js
const { publicKey, privateKey } = od.generateKeyPair()

// Sign the contract
const signedContract = od.sign(contract, privateKey)

// Sign the receipt at evaluation time
const receipt = od.evaluate({
  contract: signedContract,
  output,
  agent: 'my-agent',
  privateKey
})

// Verify signature + hash integrity
const result = od.verify(receipt, publicKey)
console.log(result.valid)  // true
```

---

## Coram

```js
const coram = od.openCoram({ contract, agentId: 'agent-001', mode: 'hashed' })
// mode: 'hashed' (default) | 'inline' | 'redacted'

// Append entries manually (or automatically via Umbra for passing calls)
od.appendEntry(coram, {
  action: 'tool.call',
  tool:   'web_search',
  input:  { query: '...' },
  result: { hits: 3 }
})

// Each entry has: entryId, action, inputHash, resultHash,
//                loopWarning, loopCount, previousHash, entryHash

// Close and verify the chain
od.closeCoram(coram)
const verify = od.verifyCoram(coram)
console.log(verify.valid)          // true
console.log(verify.loopWarnings)   // [] or [{ action, loopCount, entryId }]
```

---

## Operators

All evaluation is deterministic. No LLM calls. Same input always produces the same verdict.

| Operator | Description |
|---|---|
| `===` | Strict equality |
| `!==` | Strict inequality |
| `>` `>=` `<` `<=` | Numeric comparison (value must be `typeof === 'number'`) |
| `includes` | String includes substring |
| `startsWith` | String starts with value |
| `endsWith` | String ends with value |
| `matches` | Regex test (dangerous patterns rejected — ReDoS safe) |
| `typeof` | Type check |
| `in` | Value is in array |

---

## Receipt shape

```js
{
  receiptId,         // unique identifier
  version,           // '0.4.0'
  contractId,        // binding to the governing contract
  contractHash,      // SHA-256 of the contract
  task,              // from the contract
  agent,             // agent identifier
  issuedAt,          // ISO timestamp
  passed,            // boolean — true or false (NOT a status string)
  criteriaResults,   // [{ type, field, operator, passed, reason }]
  constraintResults, // [{ type, constraint, passed, limit, actual, reason }]
  runtime,           // { durationMs, iterations, costUsd }
  output,            // sanitized agent output
  coramHash,         // present when coram passed to evaluate()
  coramEntryCount,   // present when coram passed to evaluate()
  coramStatus,       // present when coram passed to evaluate()
  signature,         // present when privateKey passed to evaluate()
  hash               // SHA-256 of the receipt
}
```

---

## CLI

```bash
npx opendone evaluate contract.json output.json
npx opendone verify receipt.json
npx opendone keygen
npx opendone inspect receipt.json
```

---

## What a valid receipt proves

- The output was evaluated against the stated contract
- The criteria in `criteriaResults` were checked at evaluation time
- The receipt has not been modified since it was produced

A signed receipt additionally proves authorship — it was produced by the holder of the corresponding private key.

**What it does not prove:** that the agent actually did the work, or that outputs are factually correct. Coram + Umbra provide the tool-level audit layer.

---

## Tests

```bash
npm test
# node test.js             → 20/20
# node test-coram.js       → 41/41
# node test-integration.js → 71/71
```

---

## Roadmap

| Status | Item |
|---|---|
| ✓ | Contract / Evaluate / Verify |
| ✓ | Coram — hash-chained witness record |
| ✓ | Umbra — tool policy enforcement |
| ⏳ | `opendone generate` — NL → contract via LLM |
| ⏳ | MCP Server — native agent distribution |
| ⏳ | Receipt Dashboard — visual proof + data moat |

---

MIT License — Copyright 2026 AgenticEdgeX
