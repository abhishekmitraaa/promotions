export class WhatsAppApiError extends Error {
  public readonly statusCode: number;
  public readonly errorCode?: number;
  public readonly errorSubcode?: number;
  public readonly fbTraceId?: string;
  public readonly errorData?: unknown;
  public readonly isTransient: boolean;

  constructor(
    message: string,
    statusCode: number = 500,
    errorCode?: number,
    errorSubcode?: number,
    fbTraceId?: string,
    errorData?: unknown,
    isTransient?: boolean
  ) {
    super(message);
    this.name = "WhatsAppApiError";
    this.statusCode = statusCode;
    this.errorCode = errorCode;
    this.errorSubcode = errorSubcode;
    this.fbTraceId = fbTraceId;
    this.errorData = errorData;
    this.isTransient = isTransient !== undefined ? isTransient : statusCode >= 500 || statusCode === 408;
  }
}
