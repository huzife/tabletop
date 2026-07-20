import type { FastifyInstance } from "fastify";
import type { JsonObject } from "@tabletop/protocol";
import { ZodError } from "zod";

type ErrorDetails = JsonObject;

export class HttpError extends Error {
  readonly code: string;
  readonly details: ErrorDetails;
  readonly statusCode: number;

  constructor(statusCode: number, code: string, message: string, details: ErrorDetails = {}) {
    super(message);
    this.name = "HttpError";
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export function registerErrorHandling(app: FastifyInstance): void {
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof HttpError) {
      return reply.code(error.statusCode).send({
        error: {
          code: error.code,
          details: error.details,
          message: error.message,
          requestId: request.id,
        },
      });
    }

    if (error instanceof ZodError) {
      return reply.code(400).send({
        error: {
          code: "VALIDATION_FAILED",
          details: {
            fieldCount: error.issues.length,
          },
          message: "提交的数据不符合要求",
          requestId: request.id,
        },
      });
    }

    if (isFastifyClientError(error)) {
      return reply.code(error.statusCode).send({
        error: {
          code: "VALIDATION_FAILED",
          details: {},
          message: error.statusCode === 413 ? "请求内容过大" : "提交的数据不符合要求",
          requestId: request.id,
        },
      });
    }

    request.log.error({ err: error }, "unhandled request error");
    return reply.code(500).send({
      error: {
        code: "INTERNAL_ERROR",
        details: {},
        message: "服务器暂时无法处理请求",
        requestId: request.id,
      },
    });
  });
}

function isFastifyClientError(error: unknown): error is Error & { readonly statusCode: number } {
  if (!(error instanceof Error) || !("statusCode" in error)) return false;
  const statusCode = (error as { readonly statusCode?: unknown }).statusCode;
  return (
    typeof statusCode === "number" &&
    Number.isInteger(statusCode) &&
    statusCode >= 400 &&
    statusCode < 500
  );
}
