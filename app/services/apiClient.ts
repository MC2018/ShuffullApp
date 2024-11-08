import axios, { AxiosInstance } from "axios";

export class ApiClient {
    client: AxiosInstance;

    constructor(url: string) {
        this.client = axios.create({
            baseURL: url,
            timeout: 3000000
        });
    }

    public async authenticate(username: string, userHash: string) {
        return await this.client.post(`/user/authenticate?username=${username}&userHash=${userHash}`).then(function (response) {
            return response.data;
        });
    }
}
