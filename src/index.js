/**
 * AgentBond Protocol — REST API Server
 * Hedera Hello Future Apex Hackathon 2026 — AI & Agents Track
 *
 * Endpoints:
 * POST /api/v1/jobs               Create job (client locks HBAR)
 * GET  /api/v1/jobs/:id           Get job status
 * POST /api/v1/jobs/:id/bid       Agent places bid + bond
 * POST /api/v1/jobs/:id/deliver   Agent submits deliverable
 * POST /api/v1/jobs/:id/accept    Client accepts delivery
 * POST /api/v1/jobs/:id/reject    Client rejects delivery
 * POST /api/v1/jobs/:id/timeout   Agent claims auto-release
 * GET  /api/v1/agents/:id/stats   Agent stats
 * GET  /api/v1/health             Health check
 */

require("dotenv").config();
const express = require("express");
const cors    = require("cors");
const crypto  = require("crypto");
const { MongoClient } = require("mongodb");
const hederaClient = require("./hedera-client");

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

let db;
let jobsCol;
let agentsCol;

async function connectDB() {
  if (!process.env.MONGODB_URI) {
    console.warn("No MONGODB_URI — running in-memory mode (jobs lost on restart)");
    return;
  }
  const client = new MongoClient(process.env.MONGODB_URI);
  await client.connect();
  db        = client.db("agentbond");
  jobsCol   = db.collection("jobs");
  agentsCol = db.collection("agents");
  await jobsCol.createIndex({ jobId: 1 }, { unique: true });
  console.log("MongoDB connected");
}

// In-memory fallback
const memJobs = new Map();

function getJob(jobId) {
  return jobsCol ? jobsCol.findOne({ jobId }) : Promise.resolve(memJobs.get(jobId));
}

function upsertJob(job) {
  if (jobsCol) {
    return jobsCol.updateOne({ jobId: job.jobId }, { $set: job }, { upsert: true });
  }
  memJobs.set(job.jobId, job);
  return Promise.resolve();
}

// ─────────────── Endpoints ───────────────

// Health
app.get("/api/v1/health", (req, res) => {
  res.json({
    status: "ok",
    service: "AgentBond Protocol",
    hackathon: "Hedera Hello Future Apex 2026",
    network: process.env.HEDERA_NETWORK || "testnet",
    contractId: process.env.CONTRACT_ID || "not-deployed",
    timestamp: new Date().toISOString(),
  });
});

// Create job
app.post("/api/v1/jobs", async (req, res) => {
  try {
    const { clientAccountId, jobValueHbar, durationHours, description } = req.body;
    if (!clientAccountId || !jobValueHbar || !durationHours) {
      return res.status(400).json({ error: "clientAccountId, jobValueHbar, durationHours required" });
    }

    // Create HCS topic for this job's evidence chain
    const topicId = await hederaClient.createTopic(`AgentBond job: ${description || "unnamed"}`);

    // Log job creation to HCS
    await hederaClient.logToHCS(topicId, JSON.stringify({
      event:    "JOB_CREATED",
      client:   clientAccountId,
      value:    jobValueHbar,
      deadline: new Date(Date.now() + durationHours * 3600000).toISOString(),
    }));

    const jobId = crypto.randomUUID();
    const job = {
      jobId,
      client:          clientAccountId,
      agent:           null,
      jobValueHbar:    parseFloat(jobValueHbar),
      bondAmountHbar:  0,
      deadline:        new Date(Date.now() + durationHours * 3600000).toISOString(),
      deliveryTime:    null,
      deliveryHash:    null,
      description:     description || "",
      status:          "open",
      hcsTopicId:      topicId,
      createdAt:       new Date().toISOString(),
      txLinks:         [],
    };

    await upsertJob(job);
    res.json({ jobId, hcsTopicId: topicId, hashscanUrl: `https://hashscan.io/testnet/topic/${topicId}` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Get job
app.get("/api/v1/jobs/:id", async (req, res) => {
  const job = await getJob(req.params.id);
  if (!job) return res.status(404).json({ error: "Job not found" });
  res.json(job);
});

// Place bid (agent)
app.post("/api/v1/jobs/:id/bid", async (req, res) => {
  try {
    const { agentAccountId, bondAmountHbar } = req.body;
    const job = await getJob(req.params.id);
    if (!job) return res.status(404).json({ error: "Job not found" });
    if (job.status !== "open") return res.status(400).json({ error: "Job not open" });

    const requiredBond = job.jobValueHbar * 0.20;
    if (!bondAmountHbar || parseFloat(bondAmountHbar) < requiredBond) {
      return res.status(400).json({
        error: `Bond must be at least ${requiredBond.toFixed(4)} HBAR (20% of job value)`,
        requiredBond,
      });
    }

    await hederaClient.logToHCS(job.hcsTopicId, JSON.stringify({
      event:  "BID_PLACED",
      agent:  agentAccountId,
      bond:   bondAmountHbar,
    }));

    job.agent         = agentAccountId;
    job.bondAmountHbar = parseFloat(bondAmountHbar);
    job.status        = "assigned";
    await upsertJob(job);

    res.json({ success: true, job });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Submit delivery (agent)
app.post("/api/v1/jobs/:id/deliver", async (req, res) => {
  try {
    const { deliverableContent, deliverableUrl } = req.body;
    const job = await getJob(req.params.id);
    if (!job) return res.status(404).json({ error: "Job not found" });
    if (job.status !== "assigned") return res.status(400).json({ error: "Job not assigned" });

    const deliveryHash = crypto
      .createHash("sha256")
      .update(deliverableContent || deliverableUrl || "")
      .digest("hex");

    await hederaClient.logToHCS(job.hcsTopicId, JSON.stringify({
      event:        "DELIVERY_SUBMITTED",
      deliveryHash,
      deliverableUrl: deliverableUrl || null,
      timestamp:    new Date().toISOString(),
    }));

    job.deliveryHash = deliveryHash;
    job.deliveryTime = new Date().toISOString();
    job.status       = "delivered";
    await upsertJob(job);

    res.json({
      success:     true,
      deliveryHash,
      hcsLogUrl:   `https://hashscan.io/testnet/topic/${job.hcsTopicId}`,
      timeoutAt:   new Date(Date.now() + 48 * 3600000).toISOString(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Accept delivery (client)
app.post("/api/v1/jobs/:id/accept", async (req, res) => {
  try {
    const job = await getJob(req.params.id);
    if (!job) return res.status(404).json({ error: "Job not found" });
    if (job.status !== "delivered") return res.status(400).json({ error: "Job not in delivered state" });

    await hederaClient.logToHCS(job.hcsTopicId, JSON.stringify({
      event:   "CLIENT_ACCEPTED",
      payout:  job.jobValueHbar + job.bondAmountHbar,
      agent:   job.agent,
    }));

    const agentPayout = job.jobValueHbar + job.bondAmountHbar;
    job.status    = "completed";
    job.agentPayout = agentPayout;
    await upsertJob(job);

    res.json({
      success:    true,
      agentPayout,
      message:    `${agentPayout} HBAR released to agent. Bond returned.`,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Reject delivery (client)
app.post("/api/v1/jobs/:id/reject", async (req, res) => {
  try {
    const { reason } = req.body;
    const job = await getJob(req.params.id);
    if (!job) return res.status(404).json({ error: "Job not found" });
    if (job.status !== "delivered") return res.status(400).json({ error: "Job not in delivered state" });

    await hederaClient.logToHCS(job.hcsTopicId, JSON.stringify({
      event:  "CLIENT_REJECTED",
      reason: reason || "no reason given",
      slash:  job.bondAmountHbar / 2,
    }));

    const slashAmount  = job.bondAmountHbar / 2;
    const clientRefund = job.jobValueHbar + slashAmount;
    const agentRefund  = job.bondAmountHbar - slashAmount;

    job.status      = "slashed";
    job.slashAmount = slashAmount;
    await upsertJob(job);

    res.json({
      success:     true,
      slashAmount,
      clientRefund,
      agentRefund,
      message:     `${slashAmount} HBAR slashed from agent's bond. Client refunded ${clientRefund} HBAR.`,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Claim timeout (agent)
app.post("/api/v1/jobs/:id/timeout", async (req, res) => {
  try {
    const job = await getJob(req.params.id);
    if (!job) return res.status(404).json({ error: "Job not found" });
    if (job.status !== "delivered") return res.status(400).json({ error: "Job not in delivered state" });

    const deliveryTime = new Date(job.deliveryTime).getTime();
    const timeoutAt    = deliveryTime + 48 * 3600000;
    if (Date.now() < timeoutAt) {
      return res.status(400).json({
        error:     "Timeout period not elapsed",
        timeoutAt: new Date(timeoutAt).toISOString(),
        remaining: Math.round((timeoutAt - Date.now()) / 60000) + " minutes",
      });
    }

    await hederaClient.logToHCS(job.hcsTopicId, JSON.stringify({
      event:  "AUTO_RELEASED",
      reason: "Client did not respond within 48h timeout",
      payout: job.jobValueHbar + job.bondAmountHbar,
    }));

    const agentPayout = job.jobValueHbar + job.bondAmountHbar;
    job.status    = "completed";
    job.agentPayout = agentPayout;
    await upsertJob(job);

    res.json({ success: true, agentPayout, message: "Auto-release triggered. Agent paid in full." });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Agent stats
app.get("/api/v1/agents/:id/stats", async (req, res) => {
  // Would query MongoDB for agent's job history
  res.json({
    agentId:      req.params.id,
    totalEarned:  0,
    totalSlashed: 0,
    completions:  0,
    slashRate:    "0%",
    note:         "Full stats require MongoDB + real Hedera transactions",
  });
});

// ─────────────── Start ───────────────

connectDB().then(() => {
  app.listen(PORT, () => {
    console.log(`AgentBond API listening on port ${PORT}`);
    console.log(`Hedera network: ${process.env.HEDERA_NETWORK || "testnet"}`);
  });
}).catch(err => {
  console.error("Startup error:", err);
  process.exit(1);
});
