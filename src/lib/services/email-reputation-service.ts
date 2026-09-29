import { prisma } from "../prisma";
import { EmailDeliveryStatus, EmailDnsStatus } from "@prisma/client";

export type ReputationGrade = "EXCELLENT" | "GOOD" | "FAIR" | "POOR" | "CRITICAL";

export interface DeliverabilityMetrics {
  sentCount: number;
  deliveredCount: number;
  bouncedCount: number;
  complaintCount: number;
  bounceRate: number; // percentage (e.g. 1.25)
  complaintRate: number; // percentage (e.g. 0.04)
  deliveryRate: number; // percentage (e.g. 98.75)
}

export interface GoogleYahooComplianceReport {
  compliant: boolean;
  checks: {
    spfVerified: boolean;
    dkimVerified: boolean;
    dmarcVerified: boolean;
    complaintRateSafe: boolean; // < 0.30%
    oneClickUnsubscribeSupported: boolean;
  };
  missingRequirements: string[];
}

export interface ReputationReport {
  score: number; // 0 - 100
  grade: ReputationGrade;
  metrics24h: DeliverabilityMetrics;
  metrics7d: DeliverabilityMetrics;
  googleYahooCompliance: GoogleYahooComplianceReport;
  factors: {
    authenticationScore: number; // out of 30
    complaintScore: number; // out of 35
    bounceScore: number; // out of 25
    deliveryScore: number; // out of 10
  };
  actionableAlerts: string[];
}

export class EmailReputationService {
  /**
   * Computes authoritative deliverability & reputation report for a client
   */
  async getClientReputation(clientId: string): Promise<ReputationReport> {
    const now = new Date();
    const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    // 1. Fetch deliveries in 7-day window
    const recentDeliveries = await prisma.emailDelivery.findMany({
      where: {
        clientId,
        createdAt: { gte: sevenDaysAgo },
      },
      select: {
        status: true,
        createdAt: true,
      },
    });

    // 2. Fetch registered domains
    const domains = await prisma.emailDomain.findMany({
      where: { clientId },
    });

    // Compute 24h metrics
    const deliveries24h = recentDeliveries.filter((d) => d.createdAt >= oneDayAgo);
    const metrics24h = this.calculateMetrics(deliveries24h);

    // Compute 7d metrics
    const metrics7d = this.calculateMetrics(recentDeliveries);

    // 3. Compute Authentication Score (out of 30)
    let authScore = 15; // default baseline if no domain registered yet
    let spfVerified = false;
    let dkimVerified = false;
    let dmarcVerified = false;

    if (domains.length > 0) {
      // Find best verified domain
      spfVerified = domains.some((d) => d.spfStatus === EmailDnsStatus.VERIFIED);
      dkimVerified = domains.some((d) => d.dkimStatus === EmailDnsStatus.VERIFIED);
      dmarcVerified = domains.some(
        (d) => d.dmarcStatus === EmailDnsStatus.VERIFIED && d.dmarcPolicy !== "none"
      );
      const dmarcAny = domains.some((d) => d.dmarcStatus === EmailDnsStatus.VERIFIED);

      authScore = 0;
      if (spfVerified) authScore += 10;
      if (dkimVerified) authScore += 10;
      if (dmarcVerified) authScore += 10;
      else if (dmarcAny) authScore += 5; // p=none gets partial credit
    }

    // 4. Compute Complaint Score (out of 35)
    // Target: < 0.1% Google requirement, < 0.3% Hard block limit
    let complaintScore = 35;
    if (metrics7d.sentCount > 0) {
      const cr = metrics7d.complaintRate;
      if (cr <= 0.05) complaintScore = 35;
      else if (cr <= 0.10) complaintScore = 25;
      else if (cr <= 0.20) complaintScore = 15;
      else if (cr <= 0.30) complaintScore = 5;
      else complaintScore = 0; // Violation
    }

    // 5. Compute Bounce Score (out of 25)
    // Target: < 2.0% industry standard
    let bounceScore = 25;
    if (metrics7d.sentCount > 0) {
      const br = metrics7d.bounceRate;
      if (br <= 1.0) bounceScore = 25;
      else if (br <= 2.0) bounceScore = 18;
      else if (br <= 5.0) bounceScore = 8;
      else bounceScore = 0; // Severe bounce rate
    }

    // 6. Compute Delivery Rate Score (out of 10)
    let deliveryScore = 10;
    if (metrics7d.sentCount > 0) {
      const dr = metrics7d.deliveryRate;
      if (dr >= 98.0) deliveryScore = 10;
      else if (dr >= 95.0) deliveryScore = 7;
      else if (dr >= 90.0) deliveryScore = 4;
      else deliveryScore = 0;
    }

    // Total Score (0 - 100)
    const totalScore = Math.min(100, Math.max(0, authScore + complaintScore + bounceScore + deliveryScore));

    // Determine Grade
    let grade: ReputationGrade = "EXCELLENT";
    if (totalScore >= 90) grade = "EXCELLENT";
    else if (totalScore >= 75) grade = "GOOD";
    else if (totalScore >= 50) grade = "FAIR";
    else if (totalScore >= 25) grade = "POOR";
    else grade = "CRITICAL";

    // Google & Yahoo Compliance Evaluation
    const missingRequirements: string[] = [];
    if (!spfVerified) missingRequirements.push("Valid SPF record authorizing sending servers");
    if (!dkimVerified) missingRequirements.push("Valid DKIM public key signature record");
    if (!dmarcVerified) missingRequirements.push("Active DMARC policy with quarantine or reject");
    if (metrics7d.complaintRate >= 0.30) {
      missingRequirements.push(
        `Spam complaint rate (${metrics7d.complaintRate.toFixed(2)}%) exceeds 0.30% mandatory threshold`
      );
    }

    const googleYahooCompliance: GoogleYahooComplianceReport = {
      compliant: missingRequirements.length === 0,
      checks: {
        spfVerified,
        dkimVerified,
        dmarcVerified,
        complaintRateSafe: metrics7d.complaintRate < 0.30,
        oneClickUnsubscribeSupported: true, // Native List-Unsubscribe header is built into WhatsApp Hub email dispatcher
      },
      missingRequirements,
    };

    // Actionable Alerts
    const actionableAlerts: string[] = [];
    if (metrics7d.complaintRate > 0.10) {
      actionableAlerts.push(
        `Warning: Your 7-day complaint rate is ${metrics7d.complaintRate.toFixed(2)}%. Google recommends keeping complaints strictly below 0.10%.`
      );
    }
    if (metrics7d.bounceRate > 2.0) {
      actionableAlerts.push(
        `Alert: High bounce rate (${metrics7d.bounceRate.toFixed(2)}%). Clean your subscriber list and verify recipient addresses.`
      );
    }
    if (!spfVerified || !dkimVerified) {
      actionableAlerts.push("Critical: Configure SPF and DKIM on your sending domain to prevent deliverability drops.");
    }
    if (domains.length > 0 && !dmarcVerified) {
      actionableAlerts.push("Recommended: Set your domain DMARC policy to 'quarantine' or 'reject' to protect your domain from spoofing.");
    }

    return {
      score: totalScore,
      grade,
      metrics24h,
      metrics7d,
      googleYahooCompliance,
      factors: {
        authenticationScore: authScore,
        complaintScore,
        bounceScore,
        deliveryScore,
      },
      actionableAlerts,
    };
  }

  private calculateMetrics(deliveries: Array<{ status: EmailDeliveryStatus }>): DeliverabilityMetrics {
    const sentCount = deliveries.filter((d) =>
      (
        [
          EmailDeliveryStatus.SENT,
          EmailDeliveryStatus.DELIVERED,
          EmailDeliveryStatus.BOUNCED,
          EmailDeliveryStatus.COMPLAINED,
        ] as EmailDeliveryStatus[]
      ).includes(d.status)
    ).length;

    const deliveredCount = deliveries.filter(
      (d) => d.status === EmailDeliveryStatus.DELIVERED
    ).length;
    const bouncedCount = deliveries.filter(
      (d) => d.status === EmailDeliveryStatus.BOUNCED
    ).length;
    const complaintCount = deliveries.filter(
      (d) => d.status === EmailDeliveryStatus.COMPLAINED
    ).length;

    const bounceRate = sentCount > 0 ? (bouncedCount / sentCount) * 100 : 0.0;
    const complaintRate = sentCount > 0 ? (complaintCount / sentCount) * 100 : 0.0;
    const deliveryRate = sentCount > 0 ? (deliveredCount / sentCount) * 100 : 100.0;

    return {
      sentCount,
      deliveredCount,
      bouncedCount,
      complaintCount,
      bounceRate: parseFloat(bounceRate.toFixed(2)),
      complaintRate: parseFloat(complaintRate.toFixed(3)),
      deliveryRate: parseFloat(deliveryRate.toFixed(2)),
    };
  }
}

export const emailReputationService = new EmailReputationService();
