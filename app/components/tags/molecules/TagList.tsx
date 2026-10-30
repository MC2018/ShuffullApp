import { Text } from "react-native";
import { Tag } from "@/app/services/db/models";

export interface TagListProps {
    tags: Tag[];
}

export function TagList({ tags }: TagListProps) {

    return (<Text>{tags.map(x => x.name).join(", ")}</Text>);
}
