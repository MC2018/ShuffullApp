import { describe, it, expect, vi } from "vitest";
import { showAlert, BrowserDialogs } from "@/app/tools/dialog.web";

function dialogs(confirmResult = true) {
    return {
        alert: vi.fn<BrowserDialogs["alert"]>(),
        confirm: vi.fn<BrowserDialogs["confirm"]>(() => confirmResult),
    };
}

describe("showAlert (web)", () => {
    it("shows a plain alert with the title and message when there are no buttons", () => {
        const d = dialogs();
        showAlert("Couldn't save", "Something went wrong.", undefined, d);
        expect(d.alert).toHaveBeenCalledWith("Couldn't save\n\nSomething went wrong.");
        expect(d.confirm).not.toHaveBeenCalled();
    });

    it("runs the action when the confirm is accepted", () => {
        const d = dialogs(true);
        const onDelete = vi.fn();
        const onCancel = vi.fn();
        showAlert("Delete playlist", "Delete this playlist?", [
            { text: "Cancel", style: "cancel", onPress: onCancel },
            { text: "Delete", style: "destructive", onPress: onDelete },
        ], d);
        expect(d.confirm).toHaveBeenCalledWith("Delete playlist\n\nDelete this playlist?");
        expect(onDelete).toHaveBeenCalledOnce();
        expect(onCancel).not.toHaveBeenCalled();
    });

    it("runs only the cancel button when the confirm is dismissed", () => {
        const d = dialogs(false);
        const onDelete = vi.fn();
        const onCancel = vi.fn();
        showAlert("Delete playlist", undefined, [
            { text: "Cancel", style: "cancel", onPress: onCancel },
            { text: "Delete", style: "destructive", onPress: onDelete },
        ], d);
        expect(d.confirm).toHaveBeenCalledWith("Delete playlist");
        expect(onDelete).not.toHaveBeenCalled();
        expect(onCancel).toHaveBeenCalledOnce();
    });

    it("treats a lone OK button as a plain alert and still runs it", () => {
        const d = dialogs();
        const onOk = vi.fn();
        showAlert("Done", undefined, [{ text: "OK", onPress: onOk }], d);
        expect(d.alert).toHaveBeenCalledWith("Done");
        expect(d.confirm).not.toHaveBeenCalled();
        expect(onOk).toHaveBeenCalledOnce();
    });
});
