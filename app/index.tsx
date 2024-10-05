import { Text, View } from "react-native";
import { openDatabase } from "./db/db";

export default function Index() {
  openDatabase();

  return (
    <View
      style={{
        flex: 1,
        justifyContent: "center",
        alignItems: "center",
      }}
    >
      <Text>Edit app/index.tsx to edit this screen.</Text>
    </View>
  );
}
