# OpenDone

**A portable standard for machine-verifiable AI agent task completion.**

You delegate a task to an AI agent. It says it's done. How do you know?

OpenDone gives you a machine-readable contract that defines what "done" means, and a tamper-evident receipt that proves whether the agent met your criteria — deterministically, portably, without trusting the agent's self-report.

---

## Install

```bash
npm install opendone
```

Or use directly as a CLI:

```bash
npx opendone help
```

---

## Core Concepts

- **Contract** — define success criteria and runtime constraints _before_ the agent runs
- **Receipt** — signed, tamper-evident proof of what happened and whether criteria were met
- **Checkpoint** — mid-execution receipts that verify constraints haven't been breached
- **Verify** — deterministic: same contract + same output = same verdict, every time
- **Coram** — contract-anchored, append-only, hash-chained witness record of every agent action, written by infrastructure outside the agent

---

## Quick Start

```javascript
const OpenDone = require('opendone');

// 1. Define what "done" means
const contract = OpenDone.contract({
  task: 'Process invoice batch and return confirmation',
  criteria: {
    required: ['invoiceIds', 'totalProcessed', 'status'],
    conditions: [
      { field: 'status',         operator: '===', value: 'complete' },
      { field: 'totalProcessed', operator: '>',   value: 0 },
      { field: 'errors',         operator: '===', value: 0 }
    ]
  },
  constraints: {
    maxIterations:   50,
    maxDurationMs:   30000,
    maxCostUsd:      0.10,
    checkpointEvery: 10
  },
  expiresIn: 3600  // contract expires in 1 hour
});

// 2. Run your agent (OpenDone is framework-agnostic)
const agentOutput = await myAgent.run(contract.task);

// 3. Evaluate the output against the contract
const receipt = OpenDone.evaluate({
  contract,
  output: agentOutput,
  agent: 'my-invoice-agent-v1',
  runtime: { iterations: 23, durationMs: 12400, costUsd: 0.04 }
});

console.log(receipt.passed);  // true or false
// receipt is saved, hashed, and ready to verify

// 4. Verify integrity later (tamper detection)
const result = OpenDone.verify(receipt);
console.log(result.valid);   // true
console.log(result.reason);  // 'Receipt integrity confirmed'
```

---

## Checkpoints

For long-running tasks, emit checkpoint receipts mid-execution.
If constraints are breached, an error is thrown so you can halt the agent.

```javascript
for (let i = 0; i < maxSteps; i++) {
  await agent.step();

  // Emit checkpoint every N iterations
  if (i % contract.constraints.checkpointEvery === 0) {
    try {
      OpenDone.checkpoint({
        contract,
        iteration: i,
        state: agent.currentState(),
        runtime: { iterations: i, durationMs: Date.now() - start, costUsd: agent.cost() }
      });
    } catch (e) {
      if (e.code === 'CONSTRAINT_BREACH') {
        console.error('Agent exceeded constraints, halting:', e.message);
        break;
      }
    }
  }
}
```

---

## Signing

Sign contracts and receipts with your RSA private key.
Anyone with your public key can verify they came from you and weren't modified.

```javascript
const { publicKey, privateKey } = OpenDone.generateKeyPair();

// Sign a contract before handing it to an agent
const signedContract = OpenDone.sign(contract, privateKey);

// Receipts are signed at evaluation time
const receipt = OpenDone.evaluate({ contract, output, privateKey });

// Verify signature
const result = OpenDone.verify(receipt, publicKey);
```

---

## Storage

```javascript
// Default: in-memory (for testing)
const receipt = OpenDone.evaluate({ contract, output });

// File-based: atomic writes, persists across restarts
const store = OpenDone.fileStore('./receipts.json');
const receipt = OpenDone.evaluate({ contract, output, store });

// Query receipts
const allReceipts  = store.all();
const forContract  = store.query({ contractId: contract.contractId });
const failedOnly   = store.query({ passed: false });
```

---

## Coram

Coram is the fourth primitive — a tamper-evident witness record of everything the agent did, cryptographically bound to the contract that governed the run.

```javascript
const OpenDone = require('opendone');

const contract = OpenDone.contract({
  task: 'Fetch and summarise 10 articles',
  criteria: { required: ['summaries', 'count'] }
});

// Open a Coram record before the agent starts
const coram = OpenDone.openCoram({ contract, agentId: 'my-agent-v1' });

// Your agent loop — append an entry after each tool call
for (const article of articles) {
  const result = await agent.fetch(article.url);
  OpenDone.appendEntry(coram, {
    action: 'web.fetch',
    input: { url: article.url },
    result: { status: result.status, length: result.body.length }
  });
}

// Pass coram into evaluate() — it closes and binds to the receipt automatically
const receipt = OpenDone.evaluate({ contract, output: agentOutput, coram });

// Verify the full chain: receipt integrity + Coram witness record
const result = OpenDone.verifyCoram(coram, receipt);
console.log(result.valid);         // true
console.log(result.loopWarnings);  // any repeated actions flagged here
```

Coram is optional — existing `evaluate()` calls work unchanged. The agent never reads or writes Coram directly.

---

## CLI

```bash
# Evaluate an output file against a contract file
npx opendone evaluate contract.json output.json

# Verify a receipt's integrity
npx opendone verify receipt.json

# Human-readable receipt summary
npx opendone inspect receipt.json

# Generate an RSA keypair for signing
npx opendone keygen
```

---

## Criteria Operators

| Operator     | Example                                      |
|-------------|----------------------------------------------|
| `===`       | `{ field: 'status', operator: '===', value: 'complete' }` |
| `>`         | `{ field: 'count', operator: '>', value: 0 }` |
| `includes`  | `{ field: 'email', operator: 'includes', value: '@' }` |
| `startsWith`| `{ field: 'id', operator: 'startsWith', value: 'INV-' }` |
| `matches`   | `{ field: 'phone', operator: 'matches', value: '^[0-9]{10}$' }` |
| `typeof`    | `{ field: 'amount', operator: 'typeof', value: 'number' }` |
| `in`        | `{ field: 'tier', operator: 'in', value: ['free','pro','enterprise'] }` |

Nested fields via dot-notation: `"config.auth.token"`, `"meta.status"`

---

## How It's Different

| Tool | What it does |
|------|-------------|
| Agent frameworks (LangGraph, CrewAI) | Orchestrate agent execution |
| Observability (Arize, Braintrust) | Trace and evaluate agent quality |
| Identity (AIP, SPIFFE) | Authenticate agents |
| **OpenDone** | Define and verify task completion, portably, deterministically |
| **OpenDone Coram** | Tamper-evident witness record bound to the governing contract — not just a log |

OpenDone sits between execution and trust. It doesn't compete with any of these — it plugs into all of them.

---

## Spec

The full specification lives in [SPEC.md](./SPEC.md).

OpenDone is an open standard. The spec is the product. Implementations, extensions, and integrations are welcome.

---

## License

MIT
