/**
 * AgentBond Protocol — Hedera Client
 * Wraps Hedera SDK for HCS topic creation and message logging
 * Also handles HTS token operations for BondReceipt tokens
 */

const {
  Client,
  TopicCreateTransaction,
  TopicMessageSubmitTransaction,
  AccountId,
  PrivateKey,
  Hbar,
} = require("@hashgraph/sdk");

// Initialize Hedera client
function getClient() {
  const network   = process.env.HEDERA_NETWORK || "testnet";
  const accountId = process.env.HEDERA_ACCOUNT_ID;
  const privateKey = process.env.HEDERA_PRIVATE_KEY;

  if (!accountId || !privateKey) {
    console.warn("Hedera credentials not set — using mock mode");
    return null;
  }

  const client = network === "mainnet"
    ? Client.forMainnet()
    : Client.forTestnet();

  client.setOperator(
    AccountId.fromString(accountId),
    PrivateKey.fromString(privateKey)
  );

  return client;
}

/**
 * Create a Hedera Consensus Service topic for a job's evidence chain.
 * Returns the topic ID string (e.g., "0.0.12345").
 */
async function createTopic(memo) {
  const client = getClient();

  if (!client) {
    // Mock mode: return a fake topic ID
    const mockId = `0.0.${Math.floor(Math.random() * 9000000 + 1000000)}`;
    console.log(`[MOCK] Created topic: ${mockId}`);
    return mockId;
  }

  const tx = await new TopicCreateTransaction()
    .setTopicMemo(memo)
    .setMaxTransactionFee(new Hbar(5))
    .execute(client);

  const receipt = await tx.getReceipt(client);
  const topicId = receipt.topicId.toString();
  console.log(`Created HCS topic: ${topicId}`);
  return topicId;
}

/**
 * Log a message to a Hedera Consensus Service topic.
 * This creates a tamper-proof, timestamped record on the Hedera network.
 */
async function logToHCS(topicId, message) {
  const client = getClient();

  if (!client) {
    console.log(`[MOCK] HCS log to ${topicId}: ${message.substring(0, 100)}...`);
    return { topicId, sequenceNumber: Math.floor(Math.random() * 1000) };
  }

  const tx = await new TopicMessageSubmitTransaction()
    .setTopicId(topicId)
    .setMessage(message)
    .setMaxTransactionFee(new Hbar(1))
    .execute(client);

  const receipt = await tx.getReceipt(client);
  console.log(`HCS message sent to ${topicId}, seq: ${receipt.topicSequenceNumber}`);
  return {
    topicId,
    sequenceNumber: receipt.topicSequenceNumber?.toNumber(),
    hashscanUrl: `https://hashscan.io/testnet/topic/${topicId}`,
  };
}

/**
 * Get all HCS messages for a topic (via Hedera mirror node).
 */
async function getTopicMessages(topicId) {
  const network = process.env.HEDERA_NETWORK || "testnet";
  const mirrorUrl = network === "mainnet"
    ? "https://mainnet-public.mirrornode.hedera.com"
    : "https://testnet.mirrornode.hedera.com";

  try {
    const response = await fetch(
      `${mirrorUrl}/api/v1/topics/${topicId}/messages?limit=100&order=asc`
    );
    const data = await response.json();
    return (data.messages || []).map(msg => ({
      sequenceNumber: msg.sequence_number,
      timestamp:      msg.consensus_timestamp,
      content:        Buffer.from(msg.message, "base64").toString("utf8"),
    }));
  } catch (err) {
    console.error("Mirror node error:", err.message);
    return [];
  }
}

module.exports = { createTopic, logToHCS, getTopicMessages };
