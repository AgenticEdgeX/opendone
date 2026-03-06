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
const { openCoram } = require('opendone/coram')
const { openUmbra } = require('opendone/umbra')

// 1. Define the task
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
  }
})

// 2. Open witness record + enforcement layer
const coram = openCoram({ contract, agentId: 'my-agent-v1' })
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

// 4. Evaluate agent output against the contract
const receipt = od.evaluate({
  contract,
  output: {
    summary:    'Q1 revenue up 12% YoY, driven by cloud segment growth.',
    confidence: 0.94
  },
  agent:   'my-agent-v1',
  runtime: { durationMs: 4200, iterations: 3 }
})

console.log(receipt.status) // 'passed'
console.log(receipt.score)  // 1

// 5. Verify the receipt — anyone, anywhere, no dependencies
const result = od.verify(receipt)
console.log(result.valid) // true

// 6. Verify the Coram chain is intact and bound to the receipt
const { verifyCoram } = require('opendone/coram')
const chainResult = verifyCoram(coram.getRecord(), receipt)
console.log(chainResult.valid) // true
```

---

## Umbra modes

```js
const umbra = openUmbra({
  contract,
  coram,
  preset: 'sensitive',   // explore (warn) | operate (enforce) | sensitive (enforce)
  overrides: {
    loopThreshold: 2,
    onLoop: 'realign',   // realign | compress | pause | throw
    blocklist: ['exec_shell', 'modify_policy'],
    allowlist: ['web_search', 'read_file', 'write_file'],
    onHumanApproval: async (event) => {
      // called on warn-mode violations or pause loop action
      return true // approve
    }
  }
})

await umbra.check({ tool: 'web_search', input: { query: '...' } })
// passes → appended to Coram automatically
// blocked → throws UmbraViolationError, never touches Coram
// loop → triggers onLoop action
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
od.verify(receipt, publicKey)
// { valid: true, status: 'passed', score: 1 }
```

---

## Coram

```js
const { openCoram, verifyCoram } = require('opendone/coram')

const coram = openCoram({ contract, agentId: 'agent-001' })

// Entries are appended automatically by Umbra for every passing tool call
// You can also append manually:
coram.appendEntry({
  action: 'tool.call',
  tool:   'web_search',
  input:  { query: '...' },
  result: { ... }
})

// Verify the full chain
coram.verifyChain()
// { valid: true, entries: 4 }

// Loop detection
coram.detectLoop(3)
// null, or { detected: true, tool: '...', repeatCount: 3 }

// Compact digest
coram.digest()
// { entryCount, toolsUsed, finalHash, ... }

// Seal (makes append-only permanent)
coram.seal()

// Bind to receipt
verifyCoram(coram.getRecord(), receipt)
// { valid: true, bound: true, entries: 4 }
```

---

## Operators

All evaluation is deterministic. No LLM calls. Same input always produces the same verdict.

| Operator | Description |
|---|---|
| `===` | Strict equality |
| `!==` | Strict inequality |
| `>` `>=` `<` `<=` | Numeric comparison (requires `typeof === 'number'`) |
| `includes` | String includes substring |
| `matches` | Regex test (safe — dangerous patterns rejected) |
| `exists` | Field is non-null and non-undefined |
| `typeof` | Type check |

---

## CLI

```bash
npx opendone evaluate contract.json output.json --sign
npx opendone verify receipt.json
npx opendone keygen
npx opendone inspect receipt.json
```

---

## What a valid receipt proves

- The output was evaluated against the stated contract
- The criteria listed in `verifiedCriteria` passed at evaluation time
- The receipt has not been modified since it was produced

A signed receipt additionally proves authorship — it was produced by the holder of the corresponding private key.

**What it does not prove:** that the agent actually did the work, or that outputs are factually correct. Coram + Umbra provide the tool-level audit layer.

---

## Tests

```bash
npm test
# node test.js        → 20/20
# node test-coram.js  → 41/41
# node test-integration.js → 65/65
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
