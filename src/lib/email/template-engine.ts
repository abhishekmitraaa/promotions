/**
 * Safe Email Template Engine
 *
 * Implements strict, injection-proof template rendering:
 * - Built-in support for {{firstName}}, {{lastName}}, {{email}}
 * - Declared custom variables with schema validation
 * - Automatic HTML entity escaping for XSS prevention
 * - Zero eval / zero JavaScript execution / zero arbitrary server expressions
 * - Tracks missing required variables and defaults
 */

import { escapeHtml } from "./sanitization";

export interface TemplateVariableSchema {
  name: string;
  required?: boolean;
  defaultValue?: string;
  description?: string;
}

export interface RenderTemplateOptions {
  escapeHtml?: boolean;
}

export interface RenderResult {
  rendered: string;
  missingVariables: string[];
  usedVariables: string[];
}

export class TemplateEngine {
  /**
   * Validates and parses the variable schema JSON string or array.
   */
  static parseSchema(schemaInput: unknown): TemplateVariableSchema[] {
    if (!schemaInput) return [];
    let schemaList = schemaInput;

    if (typeof schemaInput === "string") {
      try {
        schemaList = JSON.parse(schemaInput);
      } catch {
        throw new Error("Invalid variable schema JSON.");
      }
    }

    if (!Array.isArray(schemaList)) {
      throw new Error("Variable schema must be an array of variable definitions.");
    }

    return schemaList.map((item, idx) => {
      if (!item || typeof item !== "object" || !item.name || typeof item.name !== "string") {
        throw new Error(`Schema item ${idx + 1} must have a valid string 'name'.`);
      }

      // Variable names must be valid alphanumeric identifiers
      if (!/^[a-zA-Z0-9_]+$/.test(item.name)) {
        throw new Error(`Invalid variable name '${item.name}'. Only alphanumeric characters and underscores allowed.`);
      }

      return {
        name: item.name,
        required: item.required === true,
        defaultValue: item.defaultValue !== undefined ? String(item.defaultValue) : undefined,
        description: typeof item.description === "string" ? item.description : undefined,
      };
    });
  }

  /**
   * Validates variables against declared schema.
   */
  static validateVariables(
    schema: TemplateVariableSchema[],
    variables: Record<string, unknown>
  ): { valid: boolean; missing: string[]; resolved: Record<string, string> } {
    const missing: string[] = [];
    const resolved: Record<string, string> = {};

    for (const def of schema) {
      const val = variables[def.name];
      if (val !== undefined && val !== null && String(val).trim() !== "") {
        resolved[def.name] = String(val);
      } else if (def.defaultValue !== undefined) {
        resolved[def.name] = def.defaultValue;
      } else if (def.required) {
        missing.push(def.name);
      }
    }

    return {
      valid: missing.length === 0,
      missing,
      resolved,
    };
  }

  /**
   * Safely renders a template string with variable substitution.
   * NEVER evaluates code, expressions, or scripts.
   */
  static render(
    template: string,
    variables: Record<string, unknown> = {},
    options: RenderTemplateOptions = { escapeHtml: true }
  ): RenderResult {
    if (!template) {
      return { rendered: "", missingVariables: [], usedVariables: [] };
    }

    const shouldEscape = options.escapeHtml !== false;
    const missingVariables: string[] = [];
    const usedVariables: string[] = [];

    // Match {{variable_name}} or {{ variable_name }}
    const pattern = /\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g;

    const rendered = template.replace(pattern, (match, varName) => {
      // Direct lookup in variables dictionary
      if (Object.prototype.hasOwnProperty.call(variables, varName)) {
        usedVariables.push(varName);
        const rawVal = variables[varName];
        if (rawVal === undefined || rawVal === null) {
          return "";
        }
        return shouldEscape
          ? escapeHtml(rawVal as string | number | boolean)
          : String(rawVal);
      }

      // Check standard contact aliases
      if (varName === "name" && variables.firstName) {
        usedVariables.push(varName);
        const combined = [variables.firstName, variables.lastName].filter(Boolean).join(" ");
        return shouldEscape ? escapeHtml(combined) : combined;
      }

      missingVariables.push(varName);
      // Leave intact if unresolved so caller can detect
      return match;
    });

    return {
      rendered,
      missingVariables: Array.from(new Set(missingVariables)),
      usedVariables: Array.from(new Set(usedVariables)),
    };
  }

  /**
   * Renders full email template (subject, HTML, text) with recipient data.
   */
  static renderTemplate(
    template: {
      subject: string;
      htmlContent: string;
      textContent?: string | null;
      variableSchema?: string | null;
    },
    variables: Record<string, unknown>
  ): {
    subject: string;
    html: string;
    text: string;
    missingVariables: string[];
  } {
    // 1. Resolve schema defaults and requirements
    let schema: TemplateVariableSchema[] = [];
    if (template.variableSchema) {
      try {
        schema = this.parseSchema(template.variableSchema);
      } catch {
        schema = [];
      }
    }

    const schemaValidation = this.validateVariables(schema, variables);
    const mergedVariables = { ...schemaValidation.resolved, ...variables };

    // 2. Render Subject (no HTML escaping, but CRLF stripped)
    const subjectResult = this.render(template.subject, mergedVariables, { escapeHtml: false });
    const safeSubject = subjectResult.rendered.replace(/[\r\n]/g, " ").trim();

    // 3. Render HTML Body (strict HTML escaping for variables)
    const htmlResult = this.render(template.htmlContent, mergedVariables, { escapeHtml: true });

    // 4. Render Plaintext Body (no HTML escaping)
    let textBody = "";
    if (template.textContent) {
      textBody = this.render(template.textContent, mergedVariables, { escapeHtml: false }).rendered;
    } else {
      // Fallback: strip HTML
      textBody = htmlResult.rendered
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<\/p>/gi, "\n\n")
        .replace(/<[^>]+>/g, "")
        .trim();
    }

    const allMissing = Array.from(
      new Set([
        ...schemaValidation.missing,
        ...subjectResult.missingVariables,
        ...htmlResult.missingVariables,
      ])
    );

    return {
      subject: safeSubject,
      html: htmlResult.rendered,
      text: textBody,
      missingVariables: allMissing,
    };
  }
}
