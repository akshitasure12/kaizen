# Blockchain Setup and Wallet Configuration

This document explains how to configure the blockchain stack end-to-end so the backend returns a fully enabled chain config at `/blockchain/config`.

## Goal

After setup, this command should return a live Base Sepolia blockchain config:

```bash
curl -X GET http://localhost:3001/blockchain/config
```

Expected output:

```json
{
  "enabled": true,
  "chainId": 84532,
  "rpcUrl": "https://sepolia.base.org",
  "abtContract": "0x3036f52e86026cA1657b17e44C791085D21e62Ec",
  "bountyContract": "0xdc57DCA9c332c5C0965bC9F7e6898fBBf504E660",
  "token": {
    "name": "AgentBranch Token",
    "symbol": "ABT",
    "decimals": 18,
    "mock": false
  }
}
```

## 1. Required services

- `bun` as package manager/runtime
- `docker` and `docker compose` for Postgres
- `forge` / Foundry for deploying contracts
- Base Sepolia RPC access via `BASE_SEPOLIA_RPC_URL`
- a funded Base Sepolia account for the deployer private key

## 2. Root `.env` configuration

The repo expects a single `.env` file at the repository root. Create it by copying the example:

```bash
cp .env.example .env
```

Then set the following values in `.env`.

### Required for blockchain

```env
BASE_SEPOLIA_RPC_URL=https://sepolia.base.org
PRIVATE_KEY=0x...                     # deployer private key for contract deployment
ABT_CONTRACT_ADDRESS=0x...            # deployed AgentBranchToken contract address
BOUNTY_CONTRACT_ADDRESS=0x...         # deployed BountyPayment contract address
TREASURY_ADDRESS=0x...                # treasury address used during deployment
```

### 2. MetaMask wallet setup

You need a wallet to deploy contracts and interact with Base Sepolia. MetaMask is the easiest option.

#### 2a. Install MetaMask

Install the browser extension:

https://metamask.io/download/

Create a new wallet or use an existing one. Write down your seed phrase and keep it safe.

#### 2b. Add Base Sepolia network to MetaMask

In MetaMask: `Settings` > `Networks` > `Add Network` > `Add a network manually`.

| Field           | Value                        |
| --------------- | ---------------------------- |
| Network Name    | Base Sepolia                 |
| RPC URL         | https://sepolia.base.org     |
| Chain ID        | 84532                        |
| Currency Symbol | ETH                          |
| Block Explorer  | https://sepolia.basescan.org |

#### 2c. Get your private key

In MetaMask: click the three dots next to your account > `Account details` > `Show private key`.

Copy the private key (starts with `0x`). Never share this or commit it to source control.

Use that private key as `PRIVATE_KEY` in `.env`.

#### 2d. Get your wallet address

Click your account name in MetaMask to copy the address, e.g. `0xAbc123...`.

This is your deployer address and it can also be your treasury address for testing.

Set it in `.env` as:

```env
TREASURY_ADDRESS=0xYourDeployerAddress
```

#### 2e. Get free Base Sepolia ETH

You need a small amount of test ETH for gas.

Options:

1. Official Base faucet: https://www.base.org/faucets — connect MetaMask, select Base Sepolia
2. Alchemy faucet: https://www.alchemy.com/faucets/base-sepolia
3. Chainlink faucet: https://faucets.chain.link/ — select Base Sepolia

You only need about `0.01 ETH`. Confirm your MetaMask balance is greater than `0`.

### Required for backend and UI

```env
JWT_SECRET=change-me-to-a-long-random-secret-in-production
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/postgres
CORS_ORIGIN=*
NEXT_PUBLIC_API_URL=http://localhost:3001
NEXT_PUBLIC_CHAIN_ID=84532
NEXT_PUBLIC_ABT_CONTRACT_ADDRESS=0x...
NEXT_PUBLIC_BOUNTY_CONTRACT_ADDRESS=0x...
```

> Important: `ABT_CONTRACT_ADDRESS` must be the actual deployed contract address. Placeholders such as `0x...` will disable blockchain mode and keep `token.mock: true`.

## 3. Wallet and faucet setup

### 3.1 Deployer wallet

The deployer wallet is the account that sends the contract deployment transactions. It must hold Base Sepolia test ETH.

If you already have a private key, use:

```bash
cast wallet address --private-key $PRIVATE_KEY
```

Then confirm balance:

```bash
cast balance <deployer_address> --rpc-url https://sepolia.base.org
```

### 3.3 Why contract address balance does not matter

The contract address itself will usually show `0` after deployment. That is expected.

The important balance is the deployer account, because it pays gas when deploying `AgentBranchToken` and `BountyPayment`.

## 4. Contract deployment

From the `contracts/` folder:

```bash
cd contracts
forge script script/Deploy.s.sol --rpc-url "$BASE_SEPOLIA_RPC_URL" --broadcast
```

If the deployer is funded, the script will print:

- `ABT deployed to: ...`
- `BountyPayment deployed to: ...`

Then update the repo root `.env` with those addresses.

## 5. Postgres and backend setup

### 5.1 Start Postgres

Use Docker Compose:

```bash
docker compose up -d postgres
```

### 5.2 Apply schema migration

From `backend/`:

```bash
cd backend
bun run migrate
```

### 5.3 Run the backend

From `backend/`:

```bash
bun run dev
```

If you change `.env`, restart the backend because env values are loaded at startup.

## 6. Frontend UI configuration

The frontend uses `NEXT_PUBLIC_API_URL` and the public contract env values from `next.config.ts`.

Ensure your repo root `.env` contains:

```env
NEXT_PUBLIC_API_URL=http://localhost:3001
NEXT_PUBLIC_CHAIN_ID=84532
NEXT_PUBLIC_ABT_CONTRACT_ADDRESS=0x3036f52e86026cA1657b17e44C791085D21e62Ec
NEXT_PUBLIC_BOUNTY_CONTRACT_ADDRESS=0xdc57DCA9c332c5C0965bC9F7e6898fBBf504E660
```

Then start the frontend from `frontend/`:

```bash
cd frontend
bun install
bun run dev
```

## 7. Testing the blockchain endpoints

### 7.1 Check blockchain status

```bash
curl -X GET http://localhost:3001/blockchain/config
```

A correct setup returns:

```json
{
  "enabled": true,
  "chainId": 84532,
  "rpcUrl": "https://sepolia.base.org",
  "abtContract": "0x3036f52e86026cA1657b17e44C791085D21e62Ec",
  "bountyContract": "0xdc57DCA9c332c5C0965bC9F7e6898fBBf504E660",
  "token": {
    "name": "AgentBranch Token",
    "symbol": "ABT",
    "decimals": 18,
    "mock": false
  }
}
```

### 7.2 Treasury info

```bash
curl -X GET http://localhost:3001/blockchain/treasury
```

### 7.3 Agent registration flow

The UI should:

1. log in or register via `/auth/login` or `/auth/register`
2. call `GET /blockchain/config`
3. show the required deposit and treasury address
4. if blockchain is enabled, prompt for a real `deposit_tx_hash` from the ABT contract call
5. call `POST /blockchain/register-agent` with the logged-in JWT

## 8. Troubleshooting

- If `enabled` is `false`, confirm `BASE_SEPOLIA_RPC_URL` and `ABT_CONTRACT_ADDRESS` in `.env` are correct.
- If `token.mock` is `true`, the backend is still in mock mode because on-chain config is not fully enabled.
- If `curl /blockchain/config` still shows `abtContract`: `0x...`, restart the backend after updating `.env`.
- If deployment fails with `insufficient funds`, fund the deployer address on Base Sepolia and retry.

## 9. Environment variable summary

| Variable                              | Purpose                                                                       |
| ------------------------------------- | ----------------------------------------------------------------------------- |
| `BASE_SEPOLIA_RPC_URL`                | Base Sepolia RPC endpoint used by the backend for on-chain verification       |
| `PRIVATE_KEY`                         | Deployer EOA private key used by Foundry to deploy contracts                  |
| `ABT_CONTRACT_ADDRESS`                | Deployed AgentBranchToken contract address used by backend validation         |
| `BOUNTY_CONTRACT_ADDRESS`             | Deployed BountyPayment contract address exposed in config                     |
| `TREASURY_ADDRESS`                    | Treasury address to receive agent deposits; also used by contract constructor |
| `NEXT_PUBLIC_API_URL`                 | Frontend API base URL                                                         |
| `NEXT_PUBLIC_CHAIN_ID`                | Chain ID for UI validation (84532)                                            |
| `NEXT_PUBLIC_ABT_CONTRACT_ADDRESS`    | Public contract address exposed to UI                                         |
| `NEXT_PUBLIC_BOUNTY_CONTRACT_ADDRESS` | Public contract address exposed to UI                                         |
| `JWT_SECRET`                          | Backend auth signing secret                                                   |
| `DATABASE_URL`                        | Postgres connection string                                                    |

## 10. Important note

The backend currently verifies `AgentBranchToken.depositForAgent` transactions. It does not itself create the on-chain transaction for agent registration — the UI or user wallet must send that transaction and pass the resulting tx hash into `POST /blockchain/register-agent`.
