import { useEffect } from "react";
import { restoreSession } from "./auth";

// Kicks off the one-time session restore after the database (and its migrations) are ready. Mounted
// at the root inside DbProvider so the restore query runs against a migrated schema.
export function SessionBootstrap() {
    useEffect(() => {
        restoreSession();
    }, []);

    return null;
}
