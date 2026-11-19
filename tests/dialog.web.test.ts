import { beforeEach, describe, expect, it, vi } from "vitest";
import { showAlert } from "@/app/tools/dialog.web";
import { dismissDialog, pressDialogButton, useDialogQueue } from "@/app/tools/dialogQueue";

function current() {
    return useDialogQueue.getState().dialogs[0];
}

describe("showAlert (web)", () => {
    beforeEach(() => {
        useDialogQueue.setState({ dialogs: [] });
    });

    it("queues the dialog and returns without blocking", () => {
        showAlert("Couldn't save", "Something went wrong.");
        expect(current()).toMatchObject({ title: "Couldn't save", message: "Something went wrong." });
    });

    it("gives a dialog with no buttons a lone OK", () => {
        showAlert("Done");
        expect(current().buttons.map((b) => b.text)).toEqual(["OK"]);
    });

    it("keeps every button, with its own label", () => {
        showAlert("Delete playlist", "Delete this playlist?", [
            { text: "Cancel", style: "cancel" },
            { text: "Delete", style: "destructive" },
        ]);
        expect(current().buttons.map((b) => b.text)).toEqual(["Cancel", "Delete"]);
    });

    it("runs only the pressed button, once, and closes the dialog", () => {
        const onDelete = vi.fn();
        const onCancel = vi.fn();
        showAlert("Delete playlist", undefined, [
            { text: "Cancel", style: "cancel", onPress: onCancel },
            { text: "Delete", style: "destructive", onPress: onDelete },
        ]);
        const { id } = current();
        pressDialogButton(id, 1);
        pressDialogButton(id, 1); // a double click
        expect(onDelete).toHaveBeenCalledOnce();
        expect(onCancel).not.toHaveBeenCalled();
        expect(useDialogQueue.getState().dialogs).toEqual([]);
    });

    it("shows queued dialogs one after another, in order", () => {
        showAlert("First");
        showAlert("Second");
        expect(current().title).toBe("First");
        pressDialogButton(current().id, 0);
        expect(current().title).toBe("Second");
    });

    it("closes before running the button, so a button can open the next dialog", () => {
        showAlert("Step one", undefined, [{ text: "Next", onPress: () => showAlert("Step two") }]);
        pressDialogButton(current().id, 0);
        expect(useDialogQueue.getState().dialogs.map((d) => d.title)).toEqual(["Step two"]);
    });

    it("dismissing runs the cancel button", () => {
        const onDelete = vi.fn();
        const onCancel = vi.fn();
        showAlert("Delete playlist", undefined, [
            { text: "Cancel", style: "cancel", onPress: onCancel },
            { text: "Delete", style: "destructive", onPress: onDelete },
        ]);
        dismissDialog(current().id);
        expect(onCancel).toHaveBeenCalledOnce();
        expect(onDelete).not.toHaveBeenCalled();
        expect(useDialogQueue.getState().dialogs).toEqual([]);
    });

    it("dismissing a plain alert runs its only button", () => {
        const onOk = vi.fn();
        showAlert("Done", undefined, [{ text: "OK", onPress: onOk }]);
        dismissDialog(current().id);
        expect(onOk).toHaveBeenCalledOnce();
    });

    it("dismissing a choice with no cancel button leaves it open and runs nothing", () => {
        const a = vi.fn();
        const b = vi.fn();
        showAlert("Pick one", undefined, [{ text: "A", onPress: a }, { text: "B", onPress: b }]);
        dismissDialog(current().id);
        expect(current().title).toBe("Pick one");
        expect(a).not.toHaveBeenCalled();
        expect(b).not.toHaveBeenCalled();
    });

    it("logs a failing async button instead of leaving an unhandled rejection", async () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
        showAlert("Delete", undefined, [{ text: "Delete", onPress: async () => { throw new Error("boom"); } }]);
        pressDialogButton(current().id, 0);
        await new Promise((r) => setTimeout(r, 0));
        expect(warn).toHaveBeenCalledOnce();
        warn.mockRestore();
    });
});
