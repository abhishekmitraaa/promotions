import { z } from "zod";

export const metaTemplateParameterSchema = z.object({
  type: z.enum(["text", "currency", "date_time", "image", "document", "video", "payload"]),
  text: z.string().optional(),
  currency: z.record(z.string(), z.unknown()).optional(),
  date_time: z.record(z.string(), z.unknown()).optional(),
  image: z.record(z.string(), z.unknown()).optional(),
  document: z.record(z.string(), z.unknown()).optional(),
  video: z.record(z.string(), z.unknown()).optional(),
  payload: z.string().optional(),
});

export const metaTemplateComponentSchema = z.object({
  type: z.enum(["header", "body", "button"]),
  sub_type: z.enum(["quick_reply", "url", "catalog"]).optional(),
  index: z.union([z.string(), z.number()]).optional(),
  parameters: z.array(metaTemplateParameterSchema).optional(),
});

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
    templateParameters: z
      .union([
        z.array(z.string()),
        z.array(metaTemplateComponentSchema),
      ])
      .optional(),
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
export type MetaTemplateParameterInput = z.infer<typeof metaTemplateParameterSchema>;
export type MetaTemplateComponentInput = z.infer<typeof metaTemplateComponentSchema>;
