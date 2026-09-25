/**
 * Transactional Email Templates and Template Service
 *
 * Implements hardened, system-default transactional templates for:
 * 1. EMAIL_VERIFICATION
 * 2. EMAIL_OTP
 * 3. PASSWORD_RESET
 *
 * Follows security requirements:
 * - HTML is never hardcoded inside API route handlers.
 * - Dynamic variables are automatically HTML-escaped to prevent injection/XSS.
 * - Always generates clean plain-text fallback for accessibility & spam filter compliance.
 */

import { renderEmailTemplate, stripHtmlToPlainText } from "./sanitization";

export type SystemTemplateType = "EMAIL_VERIFICATION" | "EMAIL_OTP" | "PASSWORD_RESET";

export interface RenderedSystemTemplate {
  subject: string;
  html: string;
  text: string;
  missingVariables: string[];
}

export interface SystemTemplateDefinition {
  subjectTemplate: string;
  htmlTemplate: string;
  textTemplate?: string;
  requiredVariables: string[];
}

const BASE_HTML_SHELL = (title: string, bodyContent: string) => `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <title>${title}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; margin: 0; padding: 0; background-color: #09090b; color: #f4f4f5; -webkit-font-smoothing: antialiased; }
    .wrapper { width: 100%; max-width: 560px; margin: 0 auto; padding: 40px 20px; }
    .card { background-color: #18181b; border: 1px solid #27272a; border-radius: 16px; padding: 36px 32px; box-shadow: 0 4px 24px rgba(0, 0, 0, 0.4); }
    .header { margin-bottom: 24px; text-align: left; }
    .logo-badge { display: inline-block; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; background-color: rgba(16, 185, 129, 0.15); color: #10b981; border: 1px solid rgba(16, 185, 129, 0.3); padding: 4px 10px; border-radius: 9999px; }
    .title { font-size: 22px; font-weight: 700; color: #ffffff; margin: 16px 0 8px 0; }
    .subtitle { font-size: 14px; color: #a1a1aa; line-height: 1.5; margin: 0; }
    .content { margin: 28px 0; }
    .btn { display: inline-block; background-color: #10b981; color: #09090b !important; text-decoration: none; font-weight: 600; font-size: 14px; padding: 12px 28px; border-radius: 8px; text-align: center; }
    .code-box { background-color: #09090b; border: 1px solid #27272a; border-radius: 12px; padding: 20px; text-align: center; margin: 24px 0; }
    .otp-code { font-family: 'SF Mono', Consolas, Menlo, Monaco, monospace; font-size: 32px; font-weight: 800; letter-spacing: 0.25em; color: #10b981; }
    .footer { margin-top: 32px; padding-top: 24px; border-top: 1px solid #27272a; font-size: 12px; color: #71717a; line-height: 1.6; }
    .footer a { color: #10b981; text-decoration: none; }
    .disclaimer { font-size: 11px; color: #52525b; margin-top: 16px; }
  </style>
</head>
<body>
  <div class="wrapper">
    <div class="card">
      ${bodyContent}
      <div class="footer">
        <p>This is a security notification from WhatsApp Hub Authentication Services. If you did not initiate this request, you can safely ignore this email.</p>
        <p class="disclaimer">&copy; ${new Date().getFullYear()} WhatsApp Hub. All rights reserved.</p>
      </div>
    </div>
  </div>
</body>
</html>`;

export const SYSTEM_TEMPLATES: Record<SystemTemplateType, SystemTemplateDefinition> = {
  EMAIL_VERIFICATION: {
    subjectTemplate: "Verify your email address",
    htmlTemplate: BASE_HTML_SHELL(
      "Verify your email address",
      `<div class="header">
        <span class="logo-badge">Security & Verification</span>
        <h1 class="title">Verify your email address</h1>
        <p class="subtitle">Please confirm your email address to complete your account verification.</p>
      </div>
      <div class="content">
        <p style="font-size: 14px; color: #d4d4d8; line-height: 1.6;">Click the button below to verify your email address. This verification link will expire in {{expires_in_minutes}} minutes.</p>
        <div style="margin: 28px 0; text-align: left;">
          <a href="{{verification_url}}" class="btn" target="_blank" rel="noopener noreferrer">Verify Email Address</a>
        </div>
        <p style="font-size: 12px; color: #71717a; line-height: 1.5; word-break: break-all;">
          If the button above does not work, copy and paste this link into your browser:<br/>
          <a href="{{verification_url}}" style="color: #10b981;">{{verification_url}}</a>
        </p>
      </div>`
    ),
    requiredVariables: ["verification_url", "expires_in_minutes"],
  },

  EMAIL_OTP: {
    subjectTemplate: "Your verification code: {{otp_code}}",
    htmlTemplate: BASE_HTML_SHELL(
      "Your verification code",
      `<div class="header">
        <span class="logo-badge">One-Time Password</span>
        <h1 class="title">Your verification code</h1>
        <p class="subtitle">Use the verification code below to complete your authentication.</p>
      </div>
      <div class="content">
        <div class="code-box">
          <div class="otp-code">{{otp_code}}</div>
          <p style="font-size: 12px; color: #a1a1aa; margin: 8px 0 0 0;">Expires in {{expires_in_minutes}} minutes</p>
        </div>
        <p style="font-size: 13px; color: #a1a1aa; line-height: 1.5;">
          For your security, never share this code with anyone. WhatsApp Hub staff will never ask for your verification code.
        </p>
      </div>`
    ),
    requiredVariables: ["otp_code", "expires_in_minutes"],
  },

  PASSWORD_RESET: {
    subjectTemplate: "Reset your password",
    htmlTemplate: BASE_HTML_SHELL(
      "Reset your password",
      `<div class="header">
        <span class="logo-badge">Account Security</span>
        <h1 class="title">Reset your password</h1>
        <p class="subtitle">We received a request to reset the password for your account.</p>
      </div>
      <div class="content">
        <p style="font-size: 14px; color: #d4d4d8; line-height: 1.6;">Click the button below to choose a new password. This reset link will expire in {{expires_in_minutes}} minutes.</p>
        <div style="margin: 28px 0; text-align: left;">
          <a href="{{reset_url}}" class="btn" target="_blank" rel="noopener noreferrer">Reset Password</a>
        </div>
        <p style="font-size: 12px; color: #71717a; line-height: 1.5; word-break: break-all;">
          If the button does not work, copy and paste this link into your browser:<br/>
          <a href="{{reset_url}}" style="color: #10b981;">{{reset_url}}</a>
        </p>
        <p style="font-size: 12px; color: #f87171; margin-top: 20px; line-height: 1.5;">
          Important: Resetting your password will immediately invalidate all existing active sessions on other devices.
        </p>
      </div>`
    ),
    requiredVariables: ["reset_url", "expires_in_minutes"],
  },
};

export class EmailTemplateService {
  /**
   * Renders a system transactional email template with automatic HTML escaping and plain-text generation.
   */
  static renderSystemTemplate(
    type: SystemTemplateType,
    variables: Record<string, string | number | boolean | null | undefined> = {}
  ): RenderedSystemTemplate {
    const definition = SYSTEM_TEMPLATES[type];
    if (!definition) {
      throw new Error(`Unsupported system template type: '${type}'`);
    }

    // Render Subject (variables are unescaped in email subject lines)
    const subjectResult = renderEmailTemplate(definition.subjectTemplate, variables, {
      escape: false,
    });

    // Render HTML (variables are strictly HTML-escaped)
    const htmlResult = renderEmailTemplate(definition.htmlTemplate, variables, {
      escape: true,
    });

    // Generate Plain-Text Fallback
    const text = definition.textTemplate
      ? renderEmailTemplate(definition.textTemplate, variables, { escape: false }).rendered
      : stripHtmlToPlainText(htmlResult.rendered);

    // Merge missing variables from subject and HTML
    const missingVariables = Array.from(
      new Set([...subjectResult.missingVariables, ...htmlResult.missingVariables])
    );

    return {
      subject: subjectResult.rendered,
      html: htmlResult.rendered,
      text,
      missingVariables,
    };
  }
}
