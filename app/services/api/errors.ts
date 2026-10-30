import axios, { HttpStatusCode } from "axios";

export class ApiError extends Error {
    constructor(endpoint: string, message: string, response?: any, error?: Error) {
        let stringBuilder = `Problem occurred in ${endpoint}: ${message}`;

        if (response) {
            stringBuilder += `\nResponse: ${response}`;
        }

        if (error) {
            stringBuilder += `\nError: ${error}`;
        }

        super(stringBuilder);
    }
}

export class ApiStatusFailureError extends ApiError {
    status: number;
    data: unknown;

    constructor(endpoint: string, response: { status: number, data?: unknown }) {
        super(endpoint, `Status ${response.status}`, describeBody(response.data));
        this.status = response.status;
        this.data = response.data;
    }
}

// The API explains every rejection in the body — its Result mapping answers a handler or validation failure
// with { error } and a 400, 403, 404, 409 or 500. The status gives only the kind of failure, and only a 5xx
// says the server itself failed (see statusOfFailure for how the outbox treats each). The reason is in the
// body. Interpolating the raw response object rendered "[object Object]", which is what made a looping 400
// undiagnosable from the log.
function describeBody(data: unknown): string | undefined {
    if (data == null) {
        return undefined;
    }

    if (typeof data === "string") {
        return data;
    }

    try {
        return JSON.stringify(data);
    } catch {
        return String(data);
    }
}

/**
 * The HTTP status the outbox should act on for a failed call.
 *
 * - The server answered: its real status, so a 4xx is retained, a 401 logs out, and only a 5xx aborts the sync.
 * - No answer at all (offline, DNS, timeout): 503, which aborts the sync and retries everything next time.
 * - Anything else (a response that failed to parse, a bug): 500, the same retry-later path.
 *
 * Every SyncManager handler used to inline the first and third branches, so a missing `instanceof` match
 * anywhere quietly turned a rejection into "server down".
 */
export function statusOfFailure(error: unknown): number {
    if (error instanceof ApiStatusFailureError) {
        return error.status;
    }

    if (axios.isAxiosError(error)) {
        return error.response?.status ?? HttpStatusCode.ServiceUnavailable;
    }

    return HttpStatusCode.InternalServerError;
}
