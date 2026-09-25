import { z } from "zod";

export const publicEmailSendSchema = z.object({
  to: z.union([
    z.string().email(),
    z.object({
      email: z.string().email(),
      name: z.string().optional(),
    }),
  ]),
  type: z.enum(["TRANSACTIONAL", "PROMOTIONAL"], {
    message: "Field 'type' must be explicitly 'TRANSACTIONAL' or 'PROMOTIONAL'",
  }),
  subject: z.string().min(1).max(255).optional(),
  templateId: z.string().uuid().optional(),
  templateVersionId: z.string().uuid().optional(),
  variables: z.record(z.string(), z.unknown()).optional(),
  html: z.string().optional(),
  text: z.string().optional(),
  from: z.string().email().optional(),
  replyTo: z.string().email().optional(),
}).refine(
  (data) => data.templateId || (data.subject && (data.html || data.text)),
  {
    message: "Either 'templateId' or direct content ('subject' and 'html'/'text') must be provided",
    path: ["templateId"],
  }
);

export type PublicEmailSendInput = z.infer<typeof publicEmailSendSchema>;
