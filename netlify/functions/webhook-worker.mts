import type { Config } from "@netlify/functions";
import { processWebhookDeliveryQueue } from "../../src/lib/webhooks/dispatcher";

const webhookWorker = async () => {
  try {
    const result = await processWebhookDeliveryQueue({ batchSize: 20 });
    console.log(
      `[Webhook Worker] Run complete: claimed=${result.claimed}, succeeded=${result.succeeded}, failed=${result.failed}`
    );
    return new Response(JSON.stringify({ success: true, ...result }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Error processing webhook delivery queue";
    console.error("[Webhook Worker] Error:", error);
    return new Response(JSON.stringify({ success: false, error: message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
};

export default webhookWorker;

export const config: Config = {
  schedule: "* * * * *",
};

