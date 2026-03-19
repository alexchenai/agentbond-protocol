/**
 * AgentBond Protocol — Integration Test
 * Tests the complete job lifecycle without real HBAR (mock mode)
 *
 * Run: npm test
 */

const BASE_URL = process.env.TEST_URL || "http://localhost:3000";

async function request(method, path, body) {
  const opts = {
    method,
    headers: { "Content-Type": "application/json" },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${BASE_URL}${path}`, opts);
  const data = await res.json();
  return { status: res.status, data };
}

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`  PASS: ${message}`);
    passed++;
  } else {
    console.error(`  FAIL: ${message}`);
    failed++;
  }
}

async function runTests() {
  console.log("=== AgentBond Protocol Integration Tests ===\n");

  // Test 1: Health check
  console.log("1. Health check");
  const health = await request("GET", "/api/v1/health");
  assert(health.status === 200, "Health endpoint returns 200");
  assert(health.data.service === "AgentBond Protocol", "Correct service name");
  assert(health.data.status === "ok", "Status is ok");

  // Test 2: Create job
  console.log("\n2. Create job (client posts work)");
  const jobRes = await request("POST", "/api/v1/jobs", {
    clientAccountId: "0.0.100001",
    jobValueHbar:    50,
    durationHours:   24,
    description:     "Write a market analysis report on Hedera ecosystem Q1 2026",
  });
  assert(jobRes.status === 200, "Job creation returns 200");
  assert(jobRes.data.jobId, "Job has an ID");
  assert(jobRes.data.hcsTopicId, "HCS topic created for evidence chain");

  const jobId = jobRes.data.jobId;
  console.log(`  Job ID: ${jobId}`);
  console.log(`  HCS Topic: ${jobRes.data.hcsTopicId}`);

  // Test 3: Get job
  console.log("\n3. Get job status");
  const getJob = await request("GET", `/api/v1/jobs/${jobId}`);
  assert(getJob.status === 200, "Get job returns 200");
  assert(getJob.data.status === "open", "Job status is 'open'");
  assert(getJob.data.jobValueHbar === 50, "Job value correct");

  // Test 4: Place bid with insufficient bond
  console.log("\n4. Place bid with insufficient bond (should fail)");
  const badBid = await request("POST", `/api/v1/jobs/${jobId}/bid`, {
    agentAccountId: "0.0.200001",
    bondAmountHbar: 5, // Only 10%, need 20%
  });
  assert(badBid.status === 400, "Insufficient bond rejected");
  assert(badBid.data.error.includes("Bond must be at least"), "Correct error message");

  // Test 5: Place valid bid
  console.log("\n5. Place valid bid (agent stakes 20% bond)");
  const validBid = await request("POST", `/api/v1/jobs/${jobId}/bid`, {
    agentAccountId: "0.0.200001",
    bondAmountHbar: 10, // 20% of 50 HBAR
  });
  assert(validBid.status === 200, "Valid bid accepted");
  assert(validBid.data.job.status === "assigned", "Job status is 'assigned'");
  assert(validBid.data.job.agent === "0.0.200001", "Agent assigned correctly");

  // Test 6: Submit delivery
  console.log("\n6. Submit delivery (agent logs work to HCS)");
  const deliverRes = await request("POST", `/api/v1/jobs/${jobId}/deliver`, {
    deliverableContent: "Market analysis report: Hedera Q1 2026 — TVL up 340%, HCS messages 12M+...",
    deliverableUrl:     "https://agentbond.chitacloud.dev/deliverables/sample-report.pdf",
  });
  assert(deliverRes.status === 200, "Delivery submission returns 200");
  assert(deliverRes.data.deliveryHash, "Delivery hash generated");
  assert(deliverRes.data.hcsLogUrl, "HCS log URL provided");
  assert(deliverRes.data.timeoutAt, "48h timeout window set");

  console.log(`  Delivery hash: ${deliverRes.data.deliveryHash}`);
  console.log(`  Auto-releases at: ${deliverRes.data.timeoutAt}`);

  // Test 7: Attempt timeout before 48h (should fail)
  console.log("\n7. Claim timeout before 48h (should fail)");
  const earlyTimeout = await request("POST", `/api/v1/jobs/${jobId}/timeout`);
  assert(earlyTimeout.status === 400, "Early timeout rejected");
  assert(earlyTimeout.data.error.includes("Timeout period not elapsed"), "Correct error");

  // Test 8: Accept delivery
  console.log("\n8. Accept delivery (client approves, funds released)");
  const acceptRes = await request("POST", `/api/v1/jobs/${jobId}/accept`);
  assert(acceptRes.status === 200, "Acceptance returns 200");
  assert(acceptRes.data.agentPayout === 60, "Agent receives job value (50) + bond (10) = 60 HBAR");

  console.log(`  Agent payout: ${acceptRes.data.agentPayout} HBAR`);

  // Test 9: Test rejection flow (separate job)
  console.log("\n9. Test rejection flow (bond slashing)");
  const job2Res = await request("POST", "/api/v1/jobs", {
    clientAccountId: "0.0.100002",
    jobValueHbar:    100,
    durationHours:   48,
    description:     "Smart contract audit",
  });
  const job2Id = job2Res.data.jobId;

  await request("POST", `/api/v1/jobs/${job2Id}/bid`, {
    agentAccountId: "0.0.200002",
    bondAmountHbar: 20,
  });
  await request("POST", `/api/v1/jobs/${job2Id}/deliver`, {
    deliverableContent: "Audit report...",
  });

  const rejectRes = await request("POST", `/api/v1/jobs/${job2Id}/reject`, {
    reason: "Report does not cover Solidity version requirements",
  });
  assert(rejectRes.status === 200, "Rejection returns 200");
  assert(rejectRes.data.slashAmount === 10, "50% of bond (10 HBAR) slashed");
  assert(rejectRes.data.clientRefund === 110, "Client gets job value (100) + slash (10) = 110 HBAR");
  assert(rejectRes.data.agentRefund === 10, "Agent gets back half bond (10 HBAR)");

  console.log(`  Slash amount: ${rejectRes.data.slashAmount} HBAR`);
  console.log(`  Client refund: ${rejectRes.data.clientRefund} HBAR`);
  console.log(`  Agent refund: ${rejectRes.data.agentRefund} HBAR`);

  // Summary
  console.log("\n=== Test Results ===");
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);
  console.log(`Total: ${passed + failed}`);

  if (failed > 0) {
    console.error("\nSome tests failed!");
    process.exit(1);
  } else {
    console.log("\nAll tests passed!");
  }
}

runTests().catch(err => {
  console.error("Test error:", err);
  process.exit(1);
});
