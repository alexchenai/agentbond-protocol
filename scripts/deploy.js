/**
 * AgentBond Protocol — Deploy Script
 * Deploys AgentBondEscrow.sol to Hedera Testnet
 *
 * Prerequisites:
 * - npm install
 * - Set HEDERA_ACCOUNT_ID and HEDERA_PRIVATE_KEY in .env
 * - Get testnet HBAR from faucet: https://portal.hedera.com
 *
 * Usage: npm run deploy
 */

require("dotenv").config();
const {
  Client,
  ContractCreateFlow,
  AccountId,
  PrivateKey,
  Hbar,
} = require("@hashgraph/sdk");
const fs = require("fs");

async function deploy() {
  const accountId  = process.env.HEDERA_ACCOUNT_ID;
  const privateKey = process.env.HEDERA_PRIVATE_KEY;

  if (!accountId || !privateKey) {
    console.error("Set HEDERA_ACCOUNT_ID and HEDERA_PRIVATE_KEY in .env");
    process.exit(1);
  }

  const client = Client.forTestnet();
  client.setOperator(
    AccountId.fromString(accountId),
    PrivateKey.fromString(privateKey)
  );

  console.log("Deploying AgentBondEscrow to Hedera Testnet...");

  // Load compiled bytecode
  // Note: compile with: npx hardhat compile
  const bytecodeFile = "./artifacts/contracts/AgentBondEscrow.sol/AgentBondEscrow.json";
  if (!fs.existsSync(bytecodeFile)) {
    console.error("Compile the contract first: npx hardhat compile");
    process.exit(1);
  }

  const { bytecode } = JSON.parse(fs.readFileSync(bytecodeFile, "utf8"));

  const treasuryAccountId = accountId; // Use operator as treasury for demo

  const deployTx = await new ContractCreateFlow()
    .setBytecode(bytecode)
    .setGas(200000)
    .setConstructorParameters(
      new (require("@hashgraph/sdk").ContractFunctionParameters)()
        .addAddress(AccountId.fromString(treasuryAccountId).toSolidityAddress())
    )
    .setMaxTransactionFee(new Hbar(20))
    .execute(client);

  const receipt   = await deployTx.getReceipt(client);
  const contractId = receipt.contractId.toString();

  console.log(`Contract deployed: ${contractId}`);
  console.log(`HashScan: https://hashscan.io/testnet/contract/${contractId}`);
  console.log(`\nAdd to .env:\nCONTRACT_ID=${contractId}`);
}

deploy().catch(console.error);
