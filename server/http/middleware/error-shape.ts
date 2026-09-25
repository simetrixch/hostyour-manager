import { AppError } from "../../kernel/errors.ts";
import type { ApiError } from "../../../shared/api-types.ts";

// The ONLY module that turns an error into an API response.
// A non-AppError is redacted to a generic INTERNAL — internal messages never leak.
export function toApiError(err: unknown): { status: number; body: ApiError } {
  if (err instanceof AppError) {
    return {
      status: err.http,
      body: err.detail ? { code: err.code, message: err.message, detail: err.detail } : { code: err.code, message: err.message },
    };
  }
  return { status: 500, body: { code: "INTERNAL", message: "Internal error" } };
}
