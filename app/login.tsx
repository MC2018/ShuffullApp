import { Button, Text, TextInput, View } from "react-native";
import { useDb } from "./db/dbProvider";
import { userTable } from "./db/schema";
import { useState } from "react";
import { useApi } from "./services/apiProvider";
import { ApiClient } from "./services/apiClient";

interface LoginProps {
    onLogin: (newApiClient: ApiClient) => void;
}

const LoginPage = ({ onLogin }: LoginProps) => {
    const [username, setUsername] = useState("")
    const [password, setPassword] = useState("")
    const [hostAddress, setHostAddress] = useState("http://192.168.11.43:7117")

    async function attemptLogin() {
        const userHash = "638a95e77ba6ec76c4179ff3fd98e682"; // TODO: THIS ONLY WORKS WITH USER MC PASS password, ARGON2 HAS TO BE IMPLEMENTED
        const api = new ApiClient(hostAddress);
        console.log("logging in...");

        const x = await api?.authenticate(username, userHash);
        //.then(x => {
            console.log(x);
            console.log(x.user.username + " " + x.token + " " + x.expiration);
            onLogin(api);
        //});
    }

    return (
        <>
            <TextInput value={username} onChangeText={setUsername} placeholder="Username" />
            <TextInput value={password} onChangeText={setPassword} placeholder="Password" secureTextEntry />
            <TextInput value={hostAddress} onChangeText={setHostAddress} placeholder="Host Address" />
            <Button title="Login" onPress={attemptLogin}></Button>
        </>
    );
}

export default LoginPage;