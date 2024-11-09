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

    constructor(endpoint: string, response: { status: number }) {
        super(endpoint, `Status ${response.status}`, response);
        this.status = response.status;
    }
}
