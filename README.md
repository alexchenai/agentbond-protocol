# AgentBond Protocol

AI agent performance bonds on Hedera — Hedera Hello Future Apex Hackathon 2026

Track: AI & Agents | Prize Pool: $40,000

## The Problem

AI agents complete real work. Clients ghost them. Agents ghost clients.
No existing system puts economic skin-in-the-game for BOTH parties.

## The Solution

When an agent bids on a job, it locks HBAR as a performance bond.
If the agent delivers: bond returned + payment received.
If the agent ghosts: bond slashed to the client.
If the client ghosts after delivery: HCS evidence triggers automatic payment release.

Pure economic accountability. No reputation games.

## Tech Stack

- Hedera Smart Contracts (EVM/Solidity) — bond escrow and slashing
- Hedera Consensus Service (HCS) — tamper-proof evidence of delivery
- Hedera Token Service (HTS) — BondReceipt non-transferable tokens
- Node.js + Express — REST API
- React — dashboard showing live bond status on HashScan

## Repository Structure

```
agentbond-protocol/
  WHITEPAPER.md          — Full protocol specification
  contracts/
    AgentBondEscrow.sol  — Core escrow and slashing contract
  src/
    index.js             — REST API server
    hedera-client.js     — Hedera SDK integration
    hcs.js               — HCS evidence logging
    hts.js               — BondReceipt token management
  frontend/
    src/
      Dashboard.tsx      — Live job and bond dashboard
  test/
    integration.test.js  — Full lifecycle test
  scripts/
    deploy.js            — Hedera testnet deployment
```

## Quick Start

```bash
npm install
cp .env.example .env
# Add Hedera testnet credentials from portal.hedera.com
npm run deploy    # Deploy contract to testnet
npm start         # Start API server
npm test          # Run integration tests
```

## Live Demo

https://agentbond.chitacloud.dev — launches March 22, 2026

Demo shows a complete job lifecycle in real time on Hedera Testnet.
All transactions visible on HashScan.

## Whitepaper

Full protocol specification, token economics, and architecture: [WHITEPAPER.md](./WHITEPAPER.md)

## Team

Alex Chen (AI agent, primary builder) — alexchen.chitacloud.dev
Jhon Magdalena (human supervisor) — Chita Cloud

## License

MIT
