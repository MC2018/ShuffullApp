import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import ts from "typescript";

/**
 * Every `X.web.ts(x)` must offer everything its native `X.ts(x)` does.
 *
 * App code imports the native path (`@/app/services/downloader/Downloader`), so TypeScript checks every caller
 * against the NATIVE file only. Metro swaps in the `.web` file for the web and desktop builds, and a name it lacks
 * is `undefined` there, found only when the call runs. That is how `Downloader.resolveAlbumArt` (added to
 * Downloader.ts alone) broke saving a song edit on desktop and blanked album art on three screens
 * (ShuffullApp#209).
 *
 * Checked: the module's exported names, and the public static members of each exported class. The web file may
 * export more (a test seam, a browser-only helper); it may not export less. Parsed, not imported: most of these
 * modules pull in native code that can't load under Node.
 */

const APP_DIR = path.resolve(__dirname, "../app");

/**
 * Native names the web file deliberately lacks, by web file, each with the reason. Add here only when every caller
 * of the name is itself native-only.
 */
const ALLOWED_GAPS: Record<string, Record<string, string>> = {
    [path.join("services", "db", "database.web.ts")]: {
        // Its only caller is DbProvider.tsx, which has its own .web twin; DbProvider.web.tsx imports database.web
        // directly and calls the async resetDbAsync, because the web database can't be reset synchronously.
        resetDb: "native-only caller (DbProvider.tsx)",
    },
};

interface Surface {
    exports: Set<string>;
    statics: Map<string, Set<string>>;
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
    return ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((m) => m.kind === kind);
}

function surfaceOf(file: string): Surface {
    const source = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    const exports = new Set<string>();
    const statics = new Map<string, Set<string>>();

    for (const node of source.statements) {
        const exported = hasModifier(node, ts.SyntaxKind.ExportKeyword);
        const isDefault = hasModifier(node, ts.SyntaxKind.DefaultKeyword);

        if (ts.isClassDeclaration(node) && exported) {
            const name = isDefault ? "default" : node.name!.text;
            exports.add(name);
            const members = new Set<string>();
            for (const member of node.members) {
                const isStatic = hasModifier(member, ts.SyntaxKind.StaticKeyword);
                const isHidden = hasModifier(member, ts.SyntaxKind.PrivateKeyword)
                    || hasModifier(member, ts.SyntaxKind.ProtectedKeyword);
                if (isStatic && !isHidden && member.name && ts.isIdentifier(member.name)) {
                    members.add(member.name.text);
                }
            }
            statics.set(name, members);
        } else if ((ts.isFunctionDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)
            || ts.isEnumDeclaration(node)) && exported) {
            exports.add(isDefault ? "default" : node.name!.text);
        } else if (ts.isVariableStatement(node) && exported) {
            for (const decl of node.declarationList.declarations) {
                if (ts.isIdentifier(decl.name)) {
                    exports.add(decl.name.text);
                }
            }
        } else if (ts.isExportAssignment(node)) {
            exports.add("default");
        } else if (ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause)) {
            for (const spec of node.exportClause.elements) {
                exports.add(spec.name.text);
            }
        }
    }
    return { exports, statics };
}

function platformPairs(dir: string): [native: string, web: string][] {
    const pairs: [string, string][] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            pairs.push(...platformPairs(full));
            continue;
        }
        const match = /^(.*)\.web\.(tsx?)$/.exec(entry.name);
        if (!match) {
            continue;
        }
        const native = ["ts", "tsx"].map((ext) => path.join(dir, `${match[1]}.${ext}`)).find((p) => fs.existsSync(p));
        if (native) {
            pairs.push([native, full]);
        }
    }
    return pairs;
}

/** What the native module offers that the web one doesn't, as readable names ("Downloader.resolveAlbumArt"). */
function missingOnWeb(native: Surface, web: Surface): string[] {
    const missing: string[] = [];
    for (const name of native.exports) {
        if (!web.exports.has(name)) {
            missing.push(name);
        }
    }
    for (const [cls, members] of native.statics) {
        const webMembers = web.statics.get(cls);
        if (webMembers == undefined) {
            continue; // the class itself is already reported above, or web exports it some other way
        }
        for (const member of members) {
            if (!webMembers.has(member)) {
                missing.push(`${cls}.${member}`);
            }
        }
    }
    return missing.sort();
}

describe("native/web module parity", () => {
    const pairs = platformPairs(APP_DIR);

    it("finds the platform-split modules", () => {
        // Guards the walker: if it silently found nothing, every parity check below would pass vacuously.
        expect(pairs.map(([, web]) => path.relative(APP_DIR, web))).toContain(path.join("services", "downloader", "Downloader.web.ts"));
    });

    it.each(pairs.map(([native, web]) => [path.relative(APP_DIR, web), native, web]))(
        "%s offers everything its native module does",
        (label, native, web) => {
            const allowed = ALLOWED_GAPS[label] ?? {};
            const missing = missingOnWeb(surfaceOf(native), surfaceOf(web)).filter((name) => !(name in allowed));
            expect(missing).toEqual([]);
        },
    );

    it("reports a static member that exists only on native", () => {
        const native: Surface = { exports: new Set(["Downloader"]), statics: new Map([["Downloader", new Set(["shared", "resolveAlbumArt"])]]) };
        const web: Surface = { exports: new Set(["Downloader"]), statics: new Map([["Downloader", new Set(["shared"])]]) };
        expect(missingOnWeb(native, web)).toEqual(["Downloader.resolveAlbumArt"]);
    });
});
