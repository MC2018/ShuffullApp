import { Button, Text, TextInput, View } from "react-native";
import { useDB } from "./db/db";
import { usersTable } from "./db/schema";
import { useState } from "react";

function printSomething() {
    console.log("Logging in...");
}

const LoginPage = () => {
    const [username, setUsername] = useState("")
    const [password, setPassword] = useState("")
    const [hostAddress, setHostAddress] = useState("")
    const db = useDB();

    return (
        <>
            <TextInput value={username} onChangeText={setUsername} placeholder="Username" />
            <TextInput value={password} onChangeText={setPassword} placeholder="Password" secureTextEntry />
            <TextInput value={hostAddress} onChangeText={setHostAddress} placeholder="Host Address" />
            <Button title="Login" onPress={printSomething}></Button>
        </>
    );
}

export default LoginPage;