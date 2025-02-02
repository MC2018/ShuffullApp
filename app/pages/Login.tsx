import { Button, Text, TextInput, View } from "react-native";
import { useEffect, useState } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { STORAGE_KEYS } from "../constants/storageKeys";
import React from "react";

export interface LoginProps {
    onLogin: (username: string, password: string, hostAddress: string) => void;
}

export default function LoginPage({ onLogin }: LoginProps) {
    const [username, setUsername] = useState("");
    const [password, setPassword] = useState("");
    const [hostAddress, setHostAddress] = useState("");

    useEffect(() => {
        (async () => {
            const hostAddress = await AsyncStorage.getItem(STORAGE_KEYS.HOST_ADDRESS);
            setHostAddress(hostAddress ?? "");
        })();
    }, []);

    async function attemptLogin() {
        await AsyncStorage.setItem(STORAGE_KEYS.HOST_ADDRESS, hostAddress);
        onLogin(username, password, hostAddress);
    };

    return (
        <>
            <TextInput value={username} onChangeText={setUsername} placeholder="Username" />
            <TextInput value={password} onChangeText={setPassword} placeholder="Password" secureTextEntry />
            <TextInput value={hostAddress} onChangeText={setHostAddress} placeholder="Host Address" />
            <Button title="Login" onPress={attemptLogin}></Button>
        </>
    );
}
