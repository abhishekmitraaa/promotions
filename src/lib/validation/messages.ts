import { z } from "zod";

export const createMessageSchema = z
  .object({
    to: z
      .string()
      .min(7, "Phone number must be at least 7 digits")
      .max(20, "Phone number must not exceed 20 characters")
      .regex(/^[\d+\s()-]+$/, "Invalid phone number characters"),
    type: z.enum(["text", "template"]).default("text"),
    body: z.string().max(4096, "Message body exceeds maximum 4096 characters").optional(),
    templateName: z.string().min(1).optional(),
    templateLanguage: z.string().default("en_US").optional(),
    templateParameters: z.array(z.union([z.string(), z.record(z.string(), z.unknown())])).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .refine(
    (data) => {
      if (data.type === "text") {
        return Boolean(data.body && data.body.trim().length > 0);
      }
      if (data.type === "template") {
        return Boolean(data.templateName && data.templateName.trim().length > 0);
      }
      return true;
    },
    {
      message: "Text messages require 'body', template messages require 'templateName'",
      path: ["body"],
    }
  );

export type CreateMessageInput = z.infer<typeof createMessageSchema>;
