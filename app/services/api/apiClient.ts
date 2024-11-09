import axios, { AxiosInstance } from "axios";
import { AuthenticateResponse, AuthenticateResponseSchema } from "./models";
import { ApiStatusFailureError } from "./errors";


export class ApiClient {
    client: AxiosInstance;

    constructor(url: string) {
        this.client = axios.create({
            baseURL: url,
            timeout: 3000000
        });
    }

    public async authenticate(username: string, userHash: string): Promise<AuthenticateResponse> {
        return this.client.post(`/user/authenticate?username=${username}&userHash=${userHash}`).then(function (response) {
            if (!isSuccessfulStatus(response.status)) {
                throw new ApiStatusFailureError("authenticate", response);
            }
            
            return AuthenticateResponseSchema.parse(response.data);
        });
    }
}

function isSuccessfulStatus(status: number) {
    return 200 <= status && status < 300;
}