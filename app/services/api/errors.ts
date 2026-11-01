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

/**
 * Whether a failure's status (from statusOfFailure) means the API couldn't be reached at all, rather than that it
 * answered with an error. No answer is 503 (see above); 502 and 504 come from a proxy that got nothing from the API;
 * Cloudflare's 520 to 530 mean the tunnel or the box behind it is down (530 is what the tunnel says while it's off).
 * A 4xx or a plain 500 means the API is up, and what's wrong is the request or the API.
 */
export function isUnreachableStatus(status: number): boolean {
    return status == HttpStatusCode.BadGateway
        || status == HttpStatusCode.ServiceUnavailable
        || status == HttpStatusCode.GatewayTimeout
        || (520 <= status && status <= 530);
}

/** What the login screen says when signing in or registering fails. */
export function describeAuthFailure(error: unknown, hostAddress: string): string {
    const status = statusOfFailure(error);

    if (isUnreachableStatus(status)) {
        return `Can't reach the server at ${hostAddress}. Check the address and your connection.`;
    }

    // The API explains every rejection in { error } (see describeBody), a wrong password included.
    if (error instanceof ApiStatusFailureError) {
        const reason = (error.data as { error?: unknown } | undefined)?.error;
        return typeof reason === "string" && reason.length ? reason : `The server answered ${error.status}.`;
    }

    return error instanceof Error ? error.message : String(error);
}
