// Outbound Request Types

export type WhatsAppMessageType = "text" | "template" | "image" | "document" | "audio" | "video" | "interactive";

export interface MetaTextMessagePayload {
  messaging_product: "whatsapp";
  recipient_type: "individual";
  to: string;
  type: "text";
  text: {
    preview_url?: boolean;
    body: string;
  };
}

export interface MetaTemplateParameter {
  type: "text" | "image" | "document" | "video" | "payload";
  text?: string;
  image?: { link: string };
  document?: { link: string; filename?: string };
  video?: { link: string };
}

export interface MetaTemplateComponent {
  type: "header" | "body" | "button";
  sub_type?: "quick_reply" | "url";
  index?: string;
  parameters: MetaTemplateParameter[];
}

export interface MetaTemplateMessagePayload {
  messaging_product: "whatsapp";
  recipient_type: "individual";
  to: string;
  type: "template";
  template: {
    name: string;
    language: {
      code: string;
    };
    components?: MetaTemplateComponent[];
  };
}

export type MetaOutboundPayload = MetaTextMessagePayload | MetaTemplateMessagePayload;

// Meta API Response Types
export interface MetaSuccessResponse {
  messaging_product: "whatsapp";
  contacts?: Array<{
    input: string;
    wa_id: string;
  }>;
  messages: Array<{
    id: string;
  }>;
}

export interface MetaErrorDetail {
  message: string;
  type: string;
  code: number;
  error_data?: {
    messaging_product?: string;
    details?: string;
  };
  error_subcode?: number;
  fbtrace_id?: string;
}

export interface MetaErrorResponse {
  error: MetaErrorDetail;
}

// Inbound Webhook Payload Types
export interface WebhookStatus {
  id: string;
  status: "sent" | "delivered" | "read" | "failed";
  timestamp: string;
  recipient_id: string;
  conversation?: {
    id: string;
    origin?: {
      type: string;
    };
  };
  pricing?: {
    billable: boolean;
    pricing_model: string;
    category: string;
  };
  errors?: Array<{
    code: number;
    title: string;
    message?: string;
    error_data?: {
      details?: string;
    };
  }>;
}

export interface WebhookIncomingMessage {
  from: string;
  id: string;
  timestamp: string;
  type: "text" | "image" | "document" | "audio" | "video" | "sticker" | "location" | "contacts" | "button" | "interactive";
  text?: {
    body: string;
  };
  image?: {
    id: string;
    mime_type: string;
    sha256: string;
    caption?: string;
  };
  document?: {
    id: string;
    filename: string;
    mime_type: string;
    sha256: string;
  };
}

export interface WebhookValue {
  messaging_product: "whatsapp";
  metadata: {
    display_phone_number: string;
    phone_number_id: string;
  };
  contacts?: Array<{
    profile: {
      name: string;
    };
    wa_id: string;
  }>;
  messages?: WebhookIncomingMessage[];
  statuses?: WebhookStatus[];
}

export interface WebhookChange {
  value: WebhookValue;
  field: "messages";
}

export interface WebhookEntry {
  id: string;
  changes: WebhookChange[];
}

export interface WebhookPayload {
  object: "whatsapp_business_account";
  entry: WebhookEntry[];
}
