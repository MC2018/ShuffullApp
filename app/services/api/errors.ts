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

// The API explains every rejection in the body — its Result mapping turns any handler or validation failure
// into a 400 carrying { error }, so the status alone says nothing about the cause. Interpolating the raw
// response object rendered "[object Object]", which is what made a looping 400 undiagnosable from the log.
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
