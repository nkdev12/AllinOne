import { BadRequestException, HttpStatus, ArgumentsHost } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { AllExceptionsFilter } from "./all-exceptions.filter";
import { ErrorCode } from "../../errors/error-code";
import { notFound } from "../../errors/http-errors";

describe("AllExceptionsFilter", () => {
  let filter: AllExceptionsFilter;
  let response: {
    status: jest.Mock;
    header: jest.Mock;
    json: jest.Mock;
  };
  let request: {
    method: string;
    url: string;
    headers: Record<string, string>;
  };
  let host: ArgumentsHost;

  beforeEach(() => {
    filter = new AllExceptionsFilter();
    response = {
      status: jest.fn().mockReturnThis(),
      header: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };
    request = { method: "POST", url: "/sync/pull", headers: {} };
    host = {
      switchToHttp: () => ({
        getResponse: () => response,
        getRequest: () => request,
      }),
    } as unknown as ArgumentsHost;
  });

  const body = () => response.json.mock.calls[0][0];

  it("forwards the code and details a service attached", () => {
    filter.catch(
      notFound(
        ErrorCode.DEVICE_NOT_REGISTERED,
        "Active device with ID 'x' not found.",
        {
          deviceId: "x",
        },
      ),
      host,
    );

    expect(response.status).toHaveBeenCalledWith(HttpStatus.NOT_FOUND);
    expect(body()).toMatchObject({
      statusCode: 404,
      code: ErrorCode.DEVICE_NOT_REGISTERED,
      details: { deviceId: "x" },
    });
  });

  it("echoes an inbound request id and generates one when absent", () => {
    request.headers["x-request-id"] = "traceable-1";
    filter.catch(new BadRequestException("nope"), host);
    expect(body().requestId).toBe("traceable-1");
    expect(response.header).toHaveBeenCalledWith("X-Request-ID", "traceable-1");

    request.headers = {};
    filter.catch(new BadRequestException("nope"), host);
    expect(body().requestId).toEqual(expect.any(String));
  });

  it("keeps raw database text out of the answer", () => {
    const leaky = new Prisma.PrismaClientValidationError(
      "Argument `email` must not be null in `UserCreateInput`",
      { clientVersion: "5.0.0" },
    );

    filter.catch(leaky, host);

    expect(response.status).toHaveBeenCalledWith(500);
    expect(body().message).toBe("An unexpected error occurred");
    expect(JSON.stringify(body())).not.toContain("UserCreateInput");
  });

  it("maps a unique-constraint failure to a conflict", () => {
    const duplicate = new Prisma.PrismaClientKnownRequestError(
      "Unique constraint failed on the fields: (`email`)",
      {
        code: "P2002",
        clientVersion: "5.0.0",
        meta: { target: ["email"] },
      },
    );

    filter.catch(duplicate, host);

    expect(response.status).toHaveBeenCalledWith(409);
    expect(body()).toMatchObject({
      code: ErrorCode.ALREADY_EXISTS,
      details: { target: ["email"] },
    });
    expect(body().message).toBe("That entry already exists.");
  });

  it("maps a missing relation and a vanished record", () => {
    filter.catch(
      new Prisma.PrismaClientKnownRequestError(
        " Foreign key constraint violated",
        {
          code: "P2003",
          clientVersion: "5.0.0",
          meta: { field: "noteId" },
        },
      ),
      host,
    );
    expect(response.status).toHaveBeenCalledWith(409);
    expect(body().details).toEqual({ field: "noteId" });
    expect(body().message).not.toContain("constraint");

    response.json.mockClear();
    filter.catch(
      new Prisma.PrismaClientKnownRequestError("No record found", {
        code: "P2025",
        clientVersion: "5.0.0",
      }),
      host,
    );
    expect(response.status).toHaveBeenCalledWith(404);
    expect(body().code).toBe(ErrorCode.NOT_FOUND);
  });

  it("does not leak an unexpected error message", () => {
    filter.catch(
      new Error("Mongoose connection lost to mongodb://user:pass@host"),
      host,
    );

    expect(response.status).toHaveBeenCalledWith(500);
    expect(JSON.stringify(body())).not.toContain("mongodb://");
    expect(body().code).toBe("INTERNAL_ERROR");
  });
});
