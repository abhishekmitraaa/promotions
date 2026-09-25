/**
 * Email Template & Immutable Versioning Service
 *
 * Implements tenant-scoped templates with immutable versioning:
 * - Templates have an active version.
 * - Scheduled or running campaigns bind to a specific immutable EmailTemplateVersion.
 * - Future edits produce new versions (version: N + 1) without modifying historical versions.
 */

import { prisma } from "../prisma";
import { TemplateEngine } from "../email/template-engine";
import { EmailTemplate, EmailTemplateVersion, EmailTemplateType } from "@prisma/client";

export interface CreateTemplateInput {
  name: string;
  description?: string | null;
  type?: EmailTemplateType;
  subject: string;
  htmlContent: string;
  textContent?: string | null;
  variableSchema?: unknown;
}

export interface CreateVersionInput {
  subject: string;
  htmlContent: string;
  textContent?: string | null;
  variableSchema?: unknown;
}

export class EmailTemplateService {
  /**
   * Creates a new template with initial immutable Version 1.
   */
  static async createTemplate(
    clientId: string,
    input: CreateTemplateInput
  ): Promise<EmailTemplate & { activeVersion: EmailTemplateVersion }> {
    if (!clientId) throw new Error("clientId is required");
    const cleanName = input.name?.trim();
    if (!cleanName) throw new Error("Template name is required");
    if (!input.subject?.trim()) throw new Error("Template subject is required");
    if (!input.htmlContent?.trim()) throw new Error("Template htmlContent is required");

    // Check duplicate name
    const existing = await prisma.emailTemplate.findUnique({
      where: { clientId_name: { clientId, name: cleanName } },
    });
    if (existing) {
      throw new Error(`Template with name '${cleanName}' already exists for this tenant.`);
    }

    // Validate variable schema if provided
    let schemaStr: string | null = null;
    if (input.variableSchema) {
      const parsed = TemplateEngine.parseSchema(input.variableSchema);
      schemaStr = JSON.stringify(parsed);
    }

    // Create Template
    const template = await prisma.emailTemplate.create({
      data: {
        clientId,
        name: cleanName,
        description: input.description?.trim() || null,
        type: input.type || EmailTemplateType.PROMOTIONAL,
      },
    });

    // Create Immutable Version 1
    const version = await prisma.emailTemplateVersion.create({
      data: {
        templateId: template.id,
        version: 1,
        subject: input.subject.trim(),
        htmlContent: input.htmlContent,
        textContent: input.textContent || null,
        variableSchema: schemaStr,
        status: "ACTIVE",
      },
    });

    // Link Active Version
    const updatedTemplate = await prisma.emailTemplate.update({
      where: { id: template.id },
      data: { activeVersionId: version.id },
    });

    return {
      ...updatedTemplate,
      activeVersion: version,
    };
  }

  /**
   * Creates a new immutable version for an existing template.
   * Does NOT mutate older versions.
   */
  static async createVersion(
    clientId: string,
    templateId: string,
    input: CreateVersionInput
  ): Promise<EmailTemplateVersion> {
    const template = await prisma.emailTemplate.findFirst({
      where: { id: templateId, clientId },
      include: {
        versions: {
          orderBy: { version: "desc" },
          take: 1,
        },
      },
    });

    if (!template) {
      throw new Error(`Template '${templateId}' not found for tenant '${clientId}'.`);
    }

    if (!input.subject?.trim()) throw new Error("Version subject is required");
    if (!input.htmlContent?.trim()) throw new Error("Version htmlContent is required");

    let schemaStr: string | null = null;
    if (input.variableSchema !== undefined) {
      const parsed = TemplateEngine.parseSchema(input.variableSchema);
      schemaStr = JSON.stringify(parsed);
    } else if (template.versions[0]?.variableSchema) {
      schemaStr = template.versions[0].variableSchema;
    }

    const nextVersionNum = (template.versions[0]?.version || 0) + 1;

    const newVersion = await prisma.emailTemplateVersion.create({
      data: {
        templateId: template.id,
        version: nextVersionNum,
        subject: input.subject.trim(),
        htmlContent: input.htmlContent,
        textContent: input.textContent || null,
        variableSchema: schemaStr,
        status: "ACTIVE",
      },
    });

    // Update template's active version pointer
    await prisma.emailTemplate.update({
      where: { id: template.id },
      data: { activeVersionId: newVersion.id },
    });

    return newVersion;
  }

  /**
   * Retrieves a template by ID strictly scoped to tenant.
   */
  static async getTemplateById(
    clientId: string,
    templateId: string
  ): Promise<(EmailTemplate & { versions: EmailTemplateVersion[]; activeVersion: EmailTemplateVersion | null }) | null> {
    if (!clientId || !templateId) return null;

    const template = await prisma.emailTemplate.findFirst({
      where: { id: templateId, clientId },
      include: {
        versions: {
          orderBy: { version: "desc" },
        },
      },
    });

    if (!template) return null;

    const activeVersion =
      template.versions.find((v) => v.id === template.activeVersionId) ||
      template.versions[0] ||
      null;

    return {
      ...template,
      activeVersion,
    };
  }

  /**
   * Retrieves a specific immutable template version.
   */
  static async getTemplateVersionById(
    clientId: string,
    versionId: string
  ): Promise<EmailTemplateVersion | null> {
    const version = await prisma.emailTemplateVersion.findUnique({
      where: { id: versionId },
      include: { template: true },
    });

    if (!version || version.template.clientId !== clientId) {
      return null;
    }

    return version;
  }

  /**
   * Lists templates for a tenant.
   */
  static async listTemplates(
    clientId: string,
    options: { type?: EmailTemplateType } = {}
  ): Promise<Array<EmailTemplate & { activeVersion: EmailTemplateVersion | null }>> {
    if (!clientId) throw new Error("clientId is required");

    const where: Record<string, unknown> = { clientId };
    if (options.type) where.type = options.type;

    const templates = await prisma.emailTemplate.findMany({
      where,
      orderBy: { createdAt: "desc" },
      include: {
        versions: {
          orderBy: { version: "desc" },
        },
      },
    });

    return templates.map((t) => {
      const activeVersion =
        t.versions.find((v) => v.id === t.activeVersionId) ||
        t.versions[0] ||
        null;
      return {
        ...t,
        activeVersion,
      };
    });
  }

  /**
   * Deletes a template if not actively bound to a running campaign.
   */
  static async deleteTemplate(clientId: string, templateId: string): Promise<{ deleted: boolean }> {
    const template = await prisma.emailTemplate.findFirst({
      where: { id: templateId, clientId },
    });

    if (!template) {
      throw new Error(`Template '${templateId}' not found for tenant '${clientId}'.`);
    }

    await prisma.emailTemplate.delete({
      where: { id: template.id },
    });

    return { deleted: true };
  }
}
